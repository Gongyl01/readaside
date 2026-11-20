export const DEEPSEEK_STATUS_URL = "https://status.deepseek.com/";

const DEFAULT_ERROR = {
  code: "unknown",
  category: "unknown",
  message: "发生未知错误，请重试。",
  advice: "请稍后重试；如果问题持续出现，请重新测试 API Key 和网络连接。",
  httpStatus: null,
  retryable: true,
  statusUrl: ""
};

export function describeHttpError(status, apiMessage = "", providerName = "DeepSeek") {
  const httpStatus = toHttpStatus(status);

  if (httpStatus === 401 || httpStatus === 403) {
    return {
      code: "authentication",
      category: "account",
      message: "API Key 无效或没有访问权限，请重新检查。",
      advice: "请在设置中重新保存并测试 API Key。",
      httpStatus,
      retryable: false,
      statusUrl: ""
    };
  }

  if (httpStatus === 402) {
    return {
      code: "balance",
      category: "account",
      message: `${providerName} API 余额不足，请先充值。`,
      advice: "充值后重新发送；重复点击不会绕过余额限制。",
      httpStatus,
      retryable: false,
      statusUrl: ""
    };
  }

  if (httpStatus === 429) {
    return {
      code: "rate_limit",
      category: "rate_limit",
      message: "请求过于频繁，请稍后再试。",
      advice: "等待一段时间后再重新发送，避免连续点击。",
      httpStatus,
      retryable: true,
      statusUrl: ""
    };
  }

  if (httpStatus !== null && httpStatus >= 500) {
    return {
      code: "provider_unavailable",
      category: "provider",
      message: `${providerName} 服务暂时不可用，请稍后重试。`,
      advice: "服务端暂时出错，请稍后手动重新发送。",
      httpStatus,
      retryable: true,
      statusUrl: providerName === "DeepSeek" ? DEEPSEEK_STATUS_URL : ""
    };
  }

  return {
    code: "http_error",
    category: "provider",
    message: String(apiMessage || `${providerName} 请求失败（HTTP ${httpStatus ?? "未知"}）。`),
    advice: "请检查请求信息；如果问题持续出现，请重新测试 API Key。",
    httpStatus,
    retryable: true,
    statusUrl: ""
  };
}

export function createRequestError(details, cause = undefined) {
  const normalized = normalizeErrorDetails(details);
  const error = cause === undefined
    ? new Error(normalized.message)
    : new Error(normalized.message, { cause });
  Object.assign(error, normalized);
  return error;
}

export function normalizeRequestError(error) {
  if (error && typeof error === "object" && hasStructuredDetails(error)) {
    return normalizeErrorDetails(error);
  }

  const message = String(error?.message ?? error ?? "").trim();
  if (/扩展连接|连接已断开|disconnected port|message port closed/i.test(message)) {
    return {
      code: "extension_connection",
      category: "extension",
      message: message || "扩展连接已断开。",
      advice: "请保持当前页面不变并手动重新发送；如果扩展刚重新加载，请关闭后重新打开侧栏。",
      httpStatus: null,
      retryable: true,
      statusUrl: ""
    };
  }

  return {
    ...DEFAULT_ERROR,
    message: message || DEFAULT_ERROR.message
  };
}

function hasStructuredDetails(value) {
  return ["code", "category", "advice", "httpStatus", "retryable", "statusUrl"]
    .some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function serializeRequestError(error) {
  return normalizeRequestError(error);
}

export function formatErrorLabel(error) {
  const details = normalizeRequestError(error);
  const status = details.httpStatus ? `HTTP ${details.httpStatus}` : "";
  const categoryLabels = {
    account: "账号问题",
    rate_limit: "请求限流",
    provider: "模型服务",
    network: "网络连接",
    response: "返回异常",
    extension: "扩展连接",
    unknown: "未知错误"
  };
  return [status, categoryLabels[details.category] || categoryLabels.unknown]
    .filter(Boolean)
    .join(" · ");
}

function normalizeErrorDetails(value) {
  const source = value && typeof value === "object" ? value : {};
  const message = String(source.message ?? "").trim();
  return {
    code: String(source.code ?? DEFAULT_ERROR.code),
    category: String(source.category ?? DEFAULT_ERROR.category),
    message: message || DEFAULT_ERROR.message,
    advice: String(source.advice ?? DEFAULT_ERROR.advice),
    httpStatus: toHttpStatus(source.httpStatus),
    retryable: source.retryable === undefined ? DEFAULT_ERROR.retryable : Boolean(source.retryable),
    statusUrl: /^https:\/\//.test(String(source.statusUrl ?? ""))
      ? String(source.statusUrl)
      : ""
  };
}

function toHttpStatus(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 100 || number > 599) return null;
  return number;
}
