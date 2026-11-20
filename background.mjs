import {
  buildAnthropicPayload,
  buildMessages,
  parseAnthropicSseChunk,
  readApiErrorDetails
} from "./lib/deepseek.mjs";
import {
  DEFAULT_API_CONFIG,
  apiEndpoint,
  apiPermissionOrigin,
  apiProviderName,
  normalizeApiConfig
} from "./lib/api-config.mjs";
import { parseOpenAiSseChunk } from "./lib/openai-stream.mjs";
import { createRequestError, serializeRequestError } from "./lib/request-error.mjs";
import {
  EVIDENCE_REPORT_PROTOCOL,
  buildEvidenceReportTool,
  normalizeEvidenceReport
} from "./lib/evidence-report.mjs";

const KEY_STORAGE_NAME = "deepseekApiKey";
const SETTINGS_STORAGE_NAME = "apiSettings";
const MAX_OUTPUT_TOKENS = 4096;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "reading-assistant") return;

  const activeRequests = new Map();

  port.onMessage.addListener((message) => {
    handlePortMessage(port, activeRequests, message).catch((error) => {
      postResponse(port, message?.id, false, null, serializeRequestError(error));
    });
  });

  port.onDisconnect.addListener(() => {
    for (const controller of activeRequests.values()) controller.abort();
    activeRequests.clear();
  });
});

async function handlePortMessage(port, activeRequests, message) {
  const { id, action, payload = {} } = message ?? {};
  if (!id || !action) return;

  switch (action) {
    case "key.status": {
      const settings = await getApiSettings();
      postResponse(port, id, true, publicApiSettings(settings));
      return;
    }
    case "key.save": {
      const config = normalizeApiConfig(payload);
      const existing = await getApiSettings();
      if (existing.key && existing.baseUrl !== config.baseUrl && !String(payload.key ?? "").trim()) {
        throw new Error("更换服务地址时，请重新输入该服务的 API Key。");
      }
      const key = normalizeApiKey(payload.key || existing.key);
      const allowed = await chrome.permissions.contains({ origins: [apiPermissionOrigin(config)] });
      if (!allowed) throw new Error("请先允许扩展访问所选 API 地址。");
      const settings = { ...config, key };
      await chrome.storage.local.set({ [SETTINGS_STORAGE_NAME]: settings });
      await chrome.storage.local.remove(KEY_STORAGE_NAME);
      postResponse(port, id, true, publicApiSettings(settings));
      return;
    }
    case "key.clear": {
      await chrome.storage.local.remove([KEY_STORAGE_NAME, SETTINGS_STORAGE_NAME]);
      postResponse(port, id, true, publicApiSettings({ ...DEFAULT_API_CONFIG, key: "" }));
      return;
    }
    case "key.test": {
      const settings = await getApiSettings();
      if (!settings.key) throw new Error("请先保存 API 设置。");
      const result = await testApiSettings(settings);
      postResponse(port, id, true, result);
      return;
    }
    case "chat.start": {
      if (activeRequests.has(id)) throw new Error("该请求已经开始。");
      const controller = new AbortController();
      activeRequests.set(id, controller);
      postResponse(port, id, true, { started: true });

      streamChat(port, id, payload, controller.signal)
        .catch((error) => {
          if (error?.name === "AbortError") {
            safePost(port, { type: "stream.cancelled", requestId: id });
          } else {
            safePost(port, {
              type: "stream.error",
              requestId: id,
              error: serializeRequestError(error)
            });
          }
        })
        .finally(() => activeRequests.delete(id));
      return;
    }
    case "chat.cancel": {
      const requestId = String(payload.requestId ?? "");
      activeRequests.get(requestId)?.abort();
      postResponse(port, id, true, { cancelled: Boolean(activeRequests.get(requestId)) });
      return;
    }
    default:
      throw new Error("未知操作。");
  }
}

async function streamChat(port, requestId, payload, signal) {
  const settings = await getApiSettings();
  if (!settings.key) throw new Error("请先在设置中保存 API 设置。");
  const providerName = apiProviderName(settings);
  const isDeepSeek = settings.preset === "deepseek";
  const evidenceEnabled = payload?.context?.evidenceProtocol === EVIDENCE_REPORT_PROTOCOL;
  const anthropic = settings.protocol === "anthropic";
  const tools = anthropic ? [
    ...(isDeepSeek ? [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] : []),
    ...(evidenceEnabled ? [buildEvidenceReportTool()] : [])
  ] : [];
  const conversation = anthropic
    ? buildAnthropicPayload(payload, { allowWebSearch: isDeepSeek })
    : buildMessages(payload, { allowWebSearch: false, allowEvidence: false });
  const requestBody = anthropic
    ? {
        model: settings.model,
        system: conversation.system,
        messages: conversation.messages,
        ...(isDeepSeek ? { thinking: { type: "disabled" } } : {}),
        max_tokens: MAX_OUTPUT_TOKENS,
        ...(tools.length ? { tools, tool_choice: { type: "auto" } } : {}),
        stream: true
      }
    : {
        model: settings.model,
        messages: conversation,
        ...(settings.preset === "openai"
          ? { max_completion_tokens: MAX_OUTPUT_TOKENS }
          : { max_tokens: MAX_OUTPUT_TOKENS }),
        stream: true
      };
  let response;
  try {
    response = await fetch(apiEndpoint(settings, anthropic ? "messages" : "chat/completions"), {
      method: "POST",
      headers: apiHeaders(settings),
      body: JSON.stringify(requestBody),
      cache: "no-store",
      redirect: "error",
      signal
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw createRequestError(
      {
        code: "network",
        category: "network",
        message: `无法连接 ${providerName}，请检查网络或代理设置。`,
        advice: `确认浏览器可以访问 ${new URL(settings.baseUrl).host}，并检查代理、防火墙或 DNS。`,
        retryable: true
      },
      error
    );
  }

  if (!response.ok) throw createRequestError(await readApiErrorDetails(response, providerName));
  if (!response.body) {
    throw createRequestError({
      code: "missing_stream",
      category: "response",
      message: `${providerName} 没有返回可读取的响应流。`,
      advice: "请手动重新发送；如果持续出现，请检查模型服务状态。",
      retryable: true
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedContent = false;
  let searchAnnounced = false;
  let evidenceReported = false;
  const evidenceBuffers = new Map();

  function handleStreamEvent(event) {
    if (event.type === "delta") {
      receivedContent = true;
      safePost(port, { type: "stream.delta", requestId, delta: event.delta });
    } else if (event.type === "search" && !searchAnnounced) {
      searchAnnounced = true;
      safePost(port, { type: "stream.search", requestId });
    } else if (event.type === "citation") {
      safePost(port, { type: "stream.citation", requestId, citation: event.citation });
    } else if (event.type === "evidence_start") {
      evidenceBuffers.set(event.index, {
        json: "",
        input: event.input
      });
    } else if (event.type === "evidence_delta") {
      const buffer = evidenceBuffers.get(event.index);
      if (buffer) buffer.json += event.partialJson;
    } else if (event.type === "content_stop") {
      const evidenceBuffer = evidenceBuffers.get(event.index);
      if (!evidenceBuffer || evidenceReported) return;
      evidenceBuffers.delete(event.index);
      const report = parseEvidenceToolInput(evidenceBuffer);
      if (report) {
        evidenceReported = true;
        safePost(port, { type: "stream.evidence", requestId, report });
      }
    } else if (event.type === "evidence_report" && !evidenceReported) {
      evidenceReported = true;
      safePost(port, { type: "stream.evidence", requestId, report: event.report });
    } else if (event.type === "error") {
      throw createRequestError({
        code: "provider_stream",
        category: "provider",
        message: event.error,
        advice: `${providerName} 在生成过程中返回错误，请稍后手动重新发送。`,
        retryable: true
      });
    }
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const parsed = anthropic
      ? parseAnthropicSseChunk(buffer, decoder.decode(value, { stream: true }))
      : parseOpenAiSseChunk(buffer, decoder.decode(value, { stream: true }));
    buffer = parsed.buffer;
    for (const event of parsed.events) handleStreamEvent(event);
  }

  const finalParsed = anthropic
    ? parseAnthropicSseChunk(buffer, decoder.decode(), true)
    : parseOpenAiSseChunk(buffer, decoder.decode(), true);
  for (const event of finalParsed.events) handleStreamEvent(event);

  if (!receivedContent && searchAnnounced) {
    throw createRequestError({
      code: "empty_search_response",
      category: "response",
      message: `${providerName} 已执行联网搜索，但没有生成最终总结。`,
      advice: "可以直接手动重新发送原问题。",
      retryable: true
    });
  }
  if (!receivedContent) {
    throw createRequestError({
      code: "empty_response",
      category: "response",
      message: `${providerName} 返回了空回答。`,
      advice: "可以直接手动重新发送原问题。",
      retryable: true
    });
  }
  safePost(port, { type: "stream.done", requestId });
}

function parseEvidenceToolInput(buffer) {
  if (buffer?.json) {
    try {
      return normalizeEvidenceReport(JSON.parse(buffer.json));
    } catch {
      return null;
    }
  }
  if (buffer?.input && typeof buffer.input === "object") {
    return normalizeEvidenceReport(buffer.input);
  }
  return null;
}

async function testApiSettings(settings) {
  const providerName = apiProviderName(settings);
  const url = settings.preset === "deepseek"
    ? `${new URL(settings.baseUrl).origin}/models`
    : apiEndpoint(settings, "models");
  let response;
  try {
    response = await fetch(url, {
      headers: settings.preset === "deepseek"
        ? { Authorization: `Bearer ${settings.key}` }
        : apiHeaders(settings),
      cache: "no-store",
      redirect: "error"
    });
  } catch (error) {
    throw createRequestError(
      {
        code: "network",
        category: "network",
        message: `无法连接 ${providerName}，请检查网络或代理设置。`,
        advice: `确认浏览器可以访问 ${new URL(settings.baseUrl).host}，并检查代理、防火墙或 DNS。`,
        retryable: true
      },
      error
    );
  }

  if (response.status === 404 || response.status === 405) {
    return { listAvailable: false, model: settings.model };
  }
  if (!response.ok) throw createRequestError(await readApiErrorDetails(response, providerName));
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { listAvailable: false, model: settings.model };
  }
  if (!Array.isArray(payload?.data)) return { listAvailable: false, model: settings.model };
  const modelIds = payload.data.map((item) => item?.id);
  return {
    valid: true,
    listAvailable: true,
    modelAvailable: modelIds.includes(settings.model),
    model: settings.model
  };
}

async function getApiSettings() {
  const result = await chrome.storage.local.get([SETTINGS_STORAGE_NAME, KEY_STORAGE_NAME]);
  const saved = result?.[SETTINGS_STORAGE_NAME];
  if (saved && typeof saved === "object") {
    return {
      ...normalizeApiConfig(saved),
      key: String(saved.key ?? result?.[KEY_STORAGE_NAME] ?? "").trim()
    };
  }
  return {
    ...DEFAULT_API_CONFIG,
    key: String(result?.[KEY_STORAGE_NAME] ?? "").trim()
  };
}

function publicApiSettings(settings) {
  return {
    configured: Boolean(settings.key),
    preview: settings.key ? `••••${settings.key.length > 4 ? settings.key.slice(-4) : ""}` : "",
    preset: settings.preset,
    protocol: settings.protocol,
    baseUrl: settings.baseUrl,
    model: settings.model
  };
}

function apiHeaders(settings) {
  return settings.protocol === "anthropic"
    ? {
        "Content-Type": "application/json",
        "x-api-key": settings.key,
        "anthropic-version": "2023-06-01"
      }
    : {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.key}`
      };
}

function normalizeApiKey(value) {
  const key = String(value ?? "").trim();
  if (!key) throw new Error("API Key 不能为空。");
  if (/\s/.test(key)) throw new Error("API Key 不能包含空格。");
  return key;
}

function postResponse(port, id, ok, data = null, error = "") {
  safePost(port, { type: "response", id, ok, data, error });
}

function safePost(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // The side panel may have been closed while a request was running.
  }
}
