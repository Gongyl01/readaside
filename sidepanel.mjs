import { extractPageContent, mergePageContents } from "./lib/page-extractor.mjs";
import { buildPagePreviewModel } from "./lib/page-preview.mjs";
import {
  extractSelectionContent,
  mergeSelectionContents
} from "./lib/selection-extractor.mjs";
import { shouldSubmitOnEnter } from "./lib/input.mjs";
import { renderMarkdown } from "./dist/markdown-renderer.mjs";
import { createPortClient } from "./lib/port-client.mjs";
import {
  MAX_RENDERED_MESSAGES,
  appendBoundedHistory,
  countConversationTurns
} from "./lib/conversation.mjs";
import { formatErrorLabel, normalizeRequestError } from "./lib/request-error.mjs";
import {
  canAttemptPageRead,
  describePageReadError,
  isLocalFileUrl,
  isUnsupportedLocalPdf
} from "./lib/tab-access.mjs";

const elements = {
  apiKeyInput: document.querySelector("#apiKeyInput"),
  cancelButton: document.querySelector("#cancelButton"),
  clearChatButton: document.querySelector("#clearChatButton"),
  clearKeyButton: document.querySelector("#clearKeyButton"),
  clearPageButton: document.querySelector("#clearPageButton"),
  clearSelectionButton: document.querySelector("#clearSelectionButton"),
  conversationCount: document.querySelector("#conversationCount"),
  conversation: document.querySelector("#conversation"),
  diagnosticGrid: document.querySelector("#diagnosticGrid"),
  diagnosticMessages: document.querySelector("#diagnosticMessages"),
  emptyState: document.querySelector("#emptyState"),
  keyBadge: document.querySelector("#keyBadge"),
  pageHeading: document.querySelector("#pageHeading"),
  pageMeta: document.querySelector("#pageMeta"),
  pagePreview: document.querySelector("#pagePreview"),
  pagePreviewText: document.querySelector("#pagePreviewText"),
  pageUrl: document.querySelector("#pageUrl"),
  previewCount: document.querySelector("#previewCount"),
  questionInput: document.querySelector("#questionInput"),
  readPageButton: document.querySelector("#readPageButton"),
  readSelectionButton: document.querySelector("#readSelectionButton"),
  saveKeyButton: document.querySelector("#saveKeyButton"),
  sendButton: document.querySelector("#sendButton"),
  selectionCard: document.querySelector("#selectionCard"),
  selectionCount: document.querySelector("#selectionCount"),
  selectionMeta: document.querySelector("#selectionMeta"),
  selectionPreviewText: document.querySelector("#selectionPreviewText"),
  statusText: document.querySelector("#statusText"),
  testKeyButton: document.querySelector("#testKeyButton")
};

const state = {
  page: null,
  selection: null,
  history: [],
  activeRequest: null,
  keyConfigured: false
};

const NORMAL_WEB_PAGE_PERMISSIONS = ["http://*/*", "https://*/*"];
let compositionActive = false;

const background = createPortClient({
  connect: () => chrome.runtime.connect({ name: "reading-assistant" }),
  createId: () => crypto.randomUUID(),
  onEvent: handlePortMessage,
  onDisconnect: () => {
    if (state.activeRequest) {
      finishRequest(
        {
          code: "extension_connection",
          category: "extension",
          message: "回答连接已断开。",
          advice: "为避免重复调用，扩展没有自动重发；请点击下方按钮手动重新发送。",
          retryable: true
        },
        true
      );
    }
  }
});

background.connect();

elements.readPageButton.addEventListener("click", readCurrentPage);
elements.clearPageButton.addEventListener("click", clearPageContext);
elements.readSelectionButton.addEventListener("click", readCurrentSelection);
elements.clearSelectionButton.addEventListener("click", () => clearSelection());
elements.saveKeyButton.addEventListener("click", saveApiKey);
elements.testKeyButton.addEventListener("click", testApiKey);
elements.clearKeyButton.addEventListener("click", clearApiKey);
elements.sendButton.addEventListener("click", sendQuestion);
elements.cancelButton.addEventListener("click", cancelActiveRequest);
elements.clearChatButton.addEventListener("click", clearConversation);
elements.questionInput.addEventListener("compositionstart", () => {
  compositionActive = true;
});
elements.questionInput.addEventListener("compositionend", () => {
  compositionActive = false;
});
elements.questionInput.addEventListener("keydown", (event) => {
  if (shouldSubmitOnEnter(event, compositionActive)) {
    event.preventDefault();
    sendQuestion();
  }
});

refreshKeyStatus();

function handlePortMessage(message) {
  if (!state.activeRequest || message?.requestId !== state.activeRequest.id) return;

  if (message.type === "stream.delta") {
    state.activeRequest.answer += message.delta;
    renderMarkdown(
      state.activeRequest.element,
      state.activeRequest.answer,
      state.activeRequest.citations
    );
    scrollConversationToEnd();
  } else if (message.type === "stream.done") {
    const { question, answer } = state.activeRequest;
    state.history = appendBoundedHistory(state.history, question, answer);
    updateConversationCount();
    trimConversationMessages();
    finishRequest("回答完成");
  } else if (message.type === "stream.search") {
    setStatus("DeepSeek 正在联网搜索并整理来源…");
  } else if (message.type === "stream.citation") {
    const citation = message.citation;
    if (citation?.url && !state.activeRequest.citations.some((item) => item.url === citation.url)) {
      state.activeRequest.citations.push(citation);
      renderMarkdown(
        state.activeRequest.element,
        state.activeRequest.answer,
        state.activeRequest.citations
      );
    }
  } else if (message.type === "stream.error") {
    finishRequest(message.error, true);
  } else if (message.type === "stream.cancelled") {
    finishRequest("已停止生成");
  }
}

function requestBackground(action, payload = {}, customId = null) {
  return background.request(action, payload, customId);
}

async function refreshKeyStatus() {
  try {
    const status = await requestBackground("key.status");
    renderKeyStatus(status);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function saveApiKey() {
  const key = elements.apiKeyInput.value.trim();
  setSettingsBusy(true);
  try {
    const status = await requestBackground("key.save", { key });
    elements.apiKeyInput.value = "";
    renderKeyStatus(status);
    setStatus("API Key 已保存在本机");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setSettingsBusy(false);
  }
}

async function testApiKey() {
  setSettingsBusy(true);
  try {
    const result = await requestBackground("key.test");
    if (!result.modelAvailable) {
      setStatus(`Key 有效，但账号暂未提供 ${result.model}。`, true);
    } else {
      setStatus(`连接正常，可使用 ${result.model}`);
    }
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setSettingsBusy(false);
  }
}

async function clearApiKey() {
  setSettingsBusy(true);
  try {
    const status = await requestBackground("key.clear");
    elements.apiKeyInput.value = "";
    renderKeyStatus(status);
    setStatus("API Key 已清除");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setSettingsBusy(false);
  }
}

function renderKeyStatus(status) {
  state.keyConfigured = Boolean(status?.configured);
  elements.keyBadge.textContent = state.keyConfigured ? `已配置 ${status.preview}` : "未配置";
  elements.keyBadge.classList.toggle("badge-success", state.keyConfigured);
  elements.keyBadge.classList.toggle("badge-warning", !state.keyConfigured);
}

async function readCurrentPage() {
  elements.readPageButton.disabled = true;
  elements.readSelectionButton.disabled = true;
  setStatus("正在确认网页读取权限…");
  let currentTabUrl = "";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("找不到当前标签页。");
    currentTabUrl = String(tab.url ?? "");

    if (isUnsupportedLocalPdf(currentTabUrl)) {
      throw new Error("当前版本不支持读取本地 PDF。请改用 HTML、TXT、JSON 或 Markdown 文件。");
    }
    if (!canAttemptPageRead(tab.url)) {
      throw new Error(
        "这是 Chrome 内置或受保护页面，扩展无法读取。请打开普通网页或支持的本地文件后重试。"
      );
    }

    if (isLocalFileUrl(currentTabUrl)) {
      const fileAccessAllowed = await chrome.extension.isAllowedFileSchemeAccess();
      if (!fileAccessAllowed) {
        throw new Error(
          "本地文件访问尚未开启。请右键扩展图标，选择“管理扩展”，然后打开“允许访问文件网址”，再回到文件页面重试。"
        );
      }
    } else {
      const granted = await chrome.permissions.request({
        origins: NORMAL_WEB_PAGE_PERMISSIONS
      });
      if (!granted) {
        throw new Error("你没有授予普通网页读取权限。请再次点击“读取当前页”，并在 Chrome 提示中选择允许。");
      }
    }

    setStatus("正在读取当前页面…");
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: extractPageContent
    });
    const page = mergePageContents(results);
    if (!page?.text) throw new Error("当前网页没有提取到可读正文。");

    const pageChanged = state.page?.url && state.page.url !== page.url;
    state.page = page;
    clearSelection(false);
    if (pageChanged) clearConversation(false);
    renderPage(page);
    setStatus("网页已读取，可以开始提问");
  } catch (error) {
    const message = String(error?.message ?? "读取网页失败。");
    setStatus(describePageReadError(message, currentTabUrl), true);
  } finally {
    elements.readPageButton.disabled = false;
    elements.readSelectionButton.disabled = !state.page;
  }
}

function renderPage(page) {
  elements.pageHeading.textContent = page.title;
  elements.pageUrl.textContent = page.url;
  elements.pageUrl.href = page.url;
  elements.pageUrl.classList.remove("hidden");
  const count = new Intl.NumberFormat("zh-CN").format(page.text.length);
  const details = [`已读取可见文字 ${count} 个字符`];
  if (page.detectedDocumentCount > 1) {
    details.push(`文档层 ${page.frameCount}/${page.detectedDocumentCount}`);
  }
  if (page.shadowRootCount > 0) details.push(`开放 Shadow DOM ${page.shadowRootCount} 个`);
  if (page.canvasCount > 0) details.push(`Canvas ${page.canvasCount} 个（文字不可直接读取）`);
  if (page.truncated) details.push("内容已截断");
  elements.pageMeta.textContent = details.join(" · ");
  elements.readSelectionButton.disabled = false;
  elements.clearPageButton.disabled = false;
  renderPagePreview(page);
}

function clearPageContext() {
  stopActiveRequestForReset();
  state.page = null;
  clearSelection(false);
  clearConversation(false);
  elements.pageHeading.textContent = "尚未读取网页";
  elements.pageUrl.textContent = "";
  elements.pageUrl.removeAttribute("href");
  elements.pageUrl.classList.add("hidden");
  elements.pageMeta.textContent = "打开想阅读的网页，然后点击“读取当前页”。";
  elements.pagePreview.open = false;
  elements.pagePreview.classList.add("hidden");
  elements.pagePreviewText.textContent = "";
  elements.diagnosticGrid.replaceChildren();
  elements.diagnosticMessages.replaceChildren();
  elements.readSelectionButton.disabled = true;
  elements.clearPageButton.disabled = true;
  setStatus("当前网页资料、选区和对话已从内存中清除");
}

async function readCurrentSelection() {
  if (!state.page) {
    setStatus("请先读取当前网页，再读取选中文字。", true);
    return;
  }

  elements.readSelectionButton.disabled = true;
  setStatus("正在读取选中文字…");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("找不到当前标签页。");
    if (String(tab.url ?? "") !== state.page.url) {
      throw new Error("当前标签页已经变化，请先重新读取当前页。");
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: extractSelectionContent
    });
    const selection = mergeSelectionContents(results);
    if (!selection.text) {
      throw new Error("没有检测到选中文字。请先在网页中拖动选择一段文字，再点击此按钮。");
    }

    state.selection = selection;
    renderSelection(selection);
    setStatus("已读取选中文字，提问时会优先参考这段内容");
  } catch (error) {
    setStatus(String(error?.message ?? "读取选中文字失败。"), true);
  } finally {
    elements.readSelectionButton.disabled = Boolean(state.activeRequest) || !state.page;
  }
}

function renderSelection(selection) {
  const count = new Intl.NumberFormat("zh-CN").format(selection.text.length);
  elements.selectionCount.textContent = `${count} 字符`;
  elements.selectionPreviewText.textContent = selection.text;
  elements.selectionMeta.textContent = selection.truncated
    ? "选区超过 20,000 字符，模型只会收到下方显示的截断内容。"
    : "提问时模型会优先参考这段文字，并使用整页内容补充上下文。";
  elements.selectionMeta.classList.toggle("warning", selection.truncated);
  elements.selectionCard.classList.remove("hidden");
  elements.selectionCard.open = true;
}

function clearSelection(showStatus = true) {
  state.selection = null;
  elements.selectionPreviewText.textContent = "";
  elements.selectionCard.classList.add("hidden");
  if (showStatus) setStatus("已清除选中文字，将继续使用整页内容回答");
}

function renderPagePreview(page) {
  const preview = buildPagePreviewModel(page);
  elements.previewCount.textContent = preview.countLabel;
  elements.pagePreviewText.textContent = preview.text;
  elements.diagnosticGrid.replaceChildren(
    ...preview.stats.map((stat) => {
      const item = document.createElement("div");
      item.className = "diagnostic-item";

      const label = document.createElement("span");
      label.className = "diagnostic-label";
      label.textContent = stat.label;

      const value = document.createElement("span");
      value.className = "diagnostic-value";
      value.textContent = stat.value;

      item.append(label, value);
      return item;
    })
  );
  elements.diagnosticMessages.replaceChildren(
    ...preview.warnings.map((warning) => {
      const message = document.createElement("p");
      message.className = `diagnostic-message ${warning.level}`;
      message.textContent = warning.text;
      return message;
    })
  );
  elements.pagePreview.classList.remove("hidden");
}

async function sendQuestion() {
  if (state.activeRequest) return;

  const question = elements.questionInput.value.trim();
  if (!state.keyConfigured) {
    setStatus("请先展开设置并保存 DeepSeek API Key。", true);
    return;
  }
  if (!state.page) {
    setStatus("请先点击“读取当前页”。", true);
    return;
  }
  if (!question) {
    setStatus("请输入问题。", true);
    return;
  }

  elements.questionInput.value = "";
  await startChatRequest(snapshotRequestPayload(question));
}

async function startChatRequest(payload, { appendUser = true, assistantElement = null } = {}) {
  if (state.activeRequest) return;

  elements.emptyState?.remove();
  if (appendUser) appendMessage("user", payload.question);

  const answerElement = assistantElement || appendMessage("assistant", "");
  answerElement.className = "message message-assistant typing";
  answerElement.replaceChildren();

  const requestId = crypto.randomUUID();
  state.activeRequest = {
    id: requestId,
    question: payload.question,
    answer: "",
    citations: [],
    element: answerElement,
    payload
  };
  setChatBusy(true);
  setStatus("DeepSeek 正在阅读并回答…");

  try {
    await requestBackground("chat.start", payload, requestId);
  } catch (error) {
    finishRequest(error, true);
  }
}

function snapshotRequestPayload(question) {
  return {
    page: cloneJsonValue(state.page),
    selection: cloneJsonValue(state.selection),
    history: cloneJsonValue(state.history) || [],
    question: String(question)
  };
}

function cloneJsonValue(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

async function cancelActiveRequest() {
  if (!state.activeRequest) return;
  try {
    await requestBackground("chat.cancel", { requestId: state.activeRequest.id });
  } catch (error) {
    finishRequest(error.message, true);
  }
}

function finishRequest(result, isError = false) {
  if (!state.activeRequest) return;
  const request = state.activeRequest;
  request.element.classList.remove("typing");
  if (isError) {
    const error = normalizeRequestError(result);
    renderRequestError(request, error);
  } else if (!request.answer) {
    request.element.remove();
  }
  state.activeRequest = null;
  setChatBusy(false);
  setStatus(isError ? normalizeRequestError(result).message : String(result), isError);
  trimConversationMessages();
}

function renderRequestError(request, error) {
  const element = request.element;
  element.classList.add("message-error");
  if (!request.answer) element.replaceChildren();

  const card = document.createElement("div");
  card.className = "request-error-card";

  const label = document.createElement("p");
  label.className = "request-error-label";
  label.textContent = formatErrorLabel(error);

  const message = document.createElement("p");
  message.className = "request-error-message";
  message.textContent = error.message;

  const advice = document.createElement("p");
  advice.className = "request-error-advice";
  advice.textContent = error.advice;

  const actions = document.createElement("div");
  actions.className = "request-error-actions";

  if (error.retryable) {
    const retryButton = document.createElement("button");
    retryButton.className = "button button-primary";
    retryButton.type = "button";
    retryButton.textContent = "重新发送";
    retryButton.addEventListener("click", () => {
      startChatRequest(request.payload, { appendUser: false, assistantElement: element });
    });
    actions.append(retryButton);
  }

  if (error.statusUrl) {
    const statusLink = document.createElement("a");
    statusLink.className = "button button-ghost request-status-link";
    statusLink.href = error.statusUrl;
    statusLink.target = "_blank";
    statusLink.rel = "noreferrer";
    statusLink.textContent = "查看服务状态";
    actions.append(statusLink);
  }

  card.append(label, message, advice);
  if (actions.childElementCount) card.append(actions);
  element.append(card);
}

function appendMessage(role, text) {
  const element = document.createElement("div");
  element.className = `message message-${role}`;
  if (role === "assistant") renderMarkdown(element, text);
  else element.textContent = text;
  elements.conversation.append(element);
  trimConversationMessages();
  scrollConversationToEnd();
  return element;
}

function clearConversation(showStatus = true) {
  stopActiveRequestForReset();
  state.history = [];
  elements.conversation.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.id = "emptyState";
  empty.innerHTML = [
    '<div class="empty-icon">读</div>',
    "<h2>边读边问</h2>",
    "<p>读取网页后，可以让我解释概念、梳理论点，或者回答页面中的具体问题。</p>"
  ].join("");
  elements.conversation.append(empty);
  elements.emptyState = empty;
  updateConversationCount();
  if (showStatus) setStatus("对话已清空");
}

function stopActiveRequestForReset() {
  if (!state.activeRequest) return;
  const requestId = state.activeRequest.id;
  state.activeRequest = null;
  requestBackground("chat.cancel", { requestId }).catch(() => {});
  setChatBusy(false);
}

function trimConversationMessages() {
  const messages = [...elements.conversation.querySelectorAll(".message")];
  const excess = messages.length - MAX_RENDERED_MESSAGES;
  if (excess <= 0) return;
  for (const message of messages.slice(0, excess)) message.remove();
}

function updateConversationCount() {
  elements.conversationCount.textContent = `${countConversationTurns(state.history)} 轮`;
}

function setSettingsBusy(busy) {
  elements.saveKeyButton.disabled = busy;
  elements.testKeyButton.disabled = busy;
  elements.clearKeyButton.disabled = busy;
}

function setChatBusy(busy) {
  elements.sendButton.disabled = busy;
  elements.readPageButton.disabled = busy;
  elements.readSelectionButton.disabled = busy || !state.page;
  elements.clearSelectionButton.disabled = busy;
  elements.clearPageButton.disabled = busy || !state.page;
  elements.clearChatButton.disabled = busy;
  elements.cancelButton.classList.toggle("hidden", !busy);
}

function setStatus(message, isError = false) {
  elements.statusText.textContent = message;
  elements.statusText.classList.toggle("error", isError);
}

function scrollConversationToEnd() {
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
}
