import {
  DEEPSEEK_ANTHROPIC_MESSAGES_URL,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
  buildAnthropicPayload,
  parseAnthropicSseChunk,
  readApiErrorDetails
} from "./lib/deepseek.mjs";
import { createRequestError, serializeRequestError } from "./lib/request-error.mjs";
import {
  EVIDENCE_REPORT_PROTOCOL,
  buildEvidenceReportTool,
  normalizeEvidenceReport
} from "./lib/evidence-report.mjs";

const KEY_STORAGE_NAME = "deepseekApiKey";

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
      const key = await getApiKey();
      postResponse(port, id, true, {
        configured: Boolean(key),
        preview: key ? `••••${key.slice(-4)}` : ""
      });
      return;
    }
    case "key.save": {
      const key = normalizeApiKey(payload.key);
      await chrome.storage.local.set({ [KEY_STORAGE_NAME]: key });
      postResponse(port, id, true, { configured: true, preview: `••••${key.slice(-4)}` });
      return;
    }
    case "key.clear": {
      await chrome.storage.local.remove(KEY_STORAGE_NAME);
      postResponse(port, id, true, { configured: false, preview: "" });
      return;
    }
    case "key.test": {
      const key = await getApiKey();
      if (!key) throw new Error("请先保存 DeepSeek API Key。");
      const result = await testApiKey(key);
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
  const key = await getApiKey();
  if (!key) throw new Error("请先在设置中保存 DeepSeek API Key。");

  const conversation = buildAnthropicPayload(payload);
  const evidenceEnabled = payload?.context?.evidenceProtocol === EVIDENCE_REPORT_PROTOCOL;
  const tools = [
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 3
    },
    ...(evidenceEnabled ? [buildEvidenceReportTool()] : [])
  ];
  let response;
  try {
    response = await fetch(DEEPSEEK_ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        system: conversation.system,
        messages: conversation.messages,
        thinking: { type: "disabled" },
        max_tokens: 2048,
        tools,
        tool_choice: { type: "auto" },
        stream: true
      }),
      cache: "no-store",
      signal
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw createRequestError(
      {
        code: "network",
        category: "network",
        message: "无法连接 DeepSeek，请检查网络或代理设置。",
        advice: "确认浏览器可以访问 api.deepseek.com，并检查代理、防火墙或 DNS。",
        retryable: true
      },
      error
    );
  }

  if (!response.ok) throw createRequestError(await readApiErrorDetails(response));
  if (!response.body) {
    throw createRequestError({
      code: "missing_stream",
      category: "response",
      message: "DeepSeek 没有返回可读取的响应流。",
      advice: "请手动重新发送；如果持续出现，请查看 DeepSeek 服务状态。",
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
        advice: "DeepSeek 在生成过程中返回错误，请稍后手动重新发送。",
        retryable: true
      });
    }
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const parsed = parseAnthropicSseChunk(buffer, decoder.decode(value, { stream: true }));
    buffer = parsed.buffer;
    for (const event of parsed.events) handleStreamEvent(event);
  }

  const finalParsed = parseAnthropicSseChunk(buffer, decoder.decode(), true);
  for (const event of finalParsed.events) handleStreamEvent(event);

  if (!receivedContent && searchAnnounced) {
    throw createRequestError({
      code: "empty_search_response",
      category: "response",
      message: "DeepSeek 已执行联网搜索，但没有生成最终总结。",
      advice: "可以直接手动重新发送原问题。",
      retryable: true
    });
  }
  if (!receivedContent) {
    throw createRequestError({
      code: "empty_response",
      category: "response",
      message: "DeepSeek 返回了空回答。",
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

async function testApiKey(key) {
  let response;
  try {
    response = await fetch(`${DEEPSEEK_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store"
    });
  } catch (error) {
    throw createRequestError(
      {
        code: "network",
        category: "network",
        message: "无法连接 DeepSeek，请检查网络或代理设置。",
        advice: "确认浏览器可以访问 api.deepseek.com，并检查代理、防火墙或 DNS。",
        retryable: true
      },
      error
    );
  }

  if (!response.ok) throw createRequestError(await readApiErrorDetails(response));
  const payload = await response.json();
  const modelIds = Array.isArray(payload?.data) ? payload.data.map((item) => item?.id) : [];
  return {
    valid: true,
    modelAvailable: modelIds.includes(DEEPSEEK_MODEL),
    model: DEEPSEEK_MODEL
  };
}

async function getApiKey() {
  const result = await chrome.storage.local.get(KEY_STORAGE_NAME);
  return String(result?.[KEY_STORAGE_NAME] ?? "").trim();
}

function normalizeApiKey(value) {
  const key = String(value ?? "").trim();
  if (!key) throw new Error("API Key 不能为空。");
  if (key.length < 16 || /\s/.test(key)) throw new Error("API Key 格式看起来不正确。");
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
