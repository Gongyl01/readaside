export const API_PRESETS = {
  deepseek: {
    name: "DeepSeek",
    protocol: "anthropic",
    baseUrl: "https://api.deepseek.com/anthropic/v1"
  },
  openai: {
    name: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1"
  },
  anthropic: {
    name: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1"
  }
};

export const DEFAULT_API_CONFIG = {
  preset: "deepseek",
  protocol: "anthropic",
  baseUrl: API_PRESETS.deepseek.baseUrl,
  model: "deepseek-flash"
};

export function normalizeApiConfig(value) {
  const preset = String(value?.preset ?? "deepseek");
  if (preset !== "custom" && !API_PRESETS[preset]) {
    throw new Error("请选择有效的 API 服务。");
  }

  const protocol = preset === "custom"
    ? String(value?.protocol ?? "")
    : API_PRESETS[preset].protocol;
  if (protocol !== "openai" && protocol !== "anthropic") {
    throw new Error("请选择 OpenAI 或 Anthropic 兼容协议。");
  }

  const baseUrl = preset === "custom"
    ? normalizeBaseUrl(value?.baseUrl)
    : API_PRESETS[preset].baseUrl;
  const model = String(value?.model ?? "").trim();
  if (!model || model.length > 128 || /\s/.test(model)) {
    throw new Error("请输入有效的模型名，不能包含空格。");
  }

  return { preset, protocol, baseUrl, model };
}

export function normalizeBaseUrl(value) {
  const text = String(value ?? "").trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("Base URL 格式不正确。");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash || !url.hostname) {
    throw new Error("Base URL 须为 HTTPS 地址；本机 localhost 可使用 HTTP，且不能包含账号或参数。");
  }
  if (/\/(?:chat\/completions|messages|models)$/i.test(url.pathname)) {
    throw new Error("Base URL 请填写接口根路径，不包含 /chat/completions、/messages 或 /models。");
  }
  return url.href.replace(/\/+$/, "");
}

export function apiEndpoint(config, resource) {
  return `${config.baseUrl}/${resource}`;
}

export function apiPermissionOrigin(config) {
  const url = new URL(config.baseUrl);
  return `${url.protocol}//${url.hostname}/*`;
}

export function apiProviderName(config) {
  return API_PRESETS[config.preset]?.name || "自定义模型服务";
}
