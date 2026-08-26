const PROTECTED_PAGE_PATTERN =
  /(?:chrome|chrome-extension|devtools|edge|about):\/\/|chrome web store|extensions gallery|cannot access a chrome/i;

const PERMISSION_PATTERN =
  /cannot access|permission|host permission|missing host permission|not allowed/i;

export function canAttemptPageRead(url) {
  const normalized = String(url ?? "").trim();
  if (!normalized) return true;
  return /^(?:https?|file):\/\//i.test(normalized);
}

export function isLocalFileUrl(url) {
  return /^file:\/\//i.test(String(url ?? "").trim());
}

export function isUnsupportedLocalPdf(url) {
  const normalized = String(url ?? "").trim();
  if (!isLocalFileUrl(normalized)) return false;

  try {
    return /\.pdf$/i.test(new URL(normalized).pathname);
  } catch {
    return /\.pdf(?:[?#]|$)/i.test(normalized);
  }
}

export function describePageReadError(errorMessage, tabUrl = "") {
  const message = String(errorMessage ?? "").trim();
  const combined = `${tabUrl} ${message}`;

  if (isLocalFileUrl(tabUrl) && PERMISSION_PATTERN.test(message)) {
    return "本地文件访问尚未开启。请右键扩展图标，选择“管理扩展”，然后打开“允许访问文件网址”，再回到文件页面重试。";
  }

  if (PROTECTED_PAGE_PATTERN.test(combined)) {
    return "这是 Chrome 内置或受保护页面，扩展无法读取。请打开普通网页或支持的本地文件后重试。";
  }

  if (PERMISSION_PATTERN.test(message)) {
    return "当前普通网页还没有授权。请再次点击“读取当前页”，并在 Chrome 提示中选择允许。";
  }

  return message || "读取网页失败，请重新打开侧栏后重试。";
}
