const DISCONNECTED_PORT_PATTERN =
  /disconnected port|message port closed|receiving end does not exist|extension context invalidated/i;

export function createPortClient({ connect, createId, onEvent, onDisconnect }) {
  let currentPort = null;
  const pending = new Map();

  function openPort() {
    const nextPort = connect();
    nextPort.onMessage.addListener((message) => handleMessage(nextPort, message));
    nextPort.onDisconnect.addListener(() => handleDisconnect(nextPort));
    currentPort = nextPort;
    return nextPort;
  }

  function ensurePort() {
    return currentPort || openPort();
  }

  function request(action, payload = {}, customId = null) {
    const id = customId || createId();
    const message = { id, action, payload };

    return new Promise((resolve, reject) => {
      const attempt = (canRetry) => {
        let targetPort = null;

        try {
          targetPort = ensurePort();
          pending.set(id, { resolve, reject, port: targetPort });
          targetPort.postMessage(message);
        } catch (error) {
          const handler = pending.get(id);
          if (handler?.port === targetPort) pending.delete(id);
          if (currentPort === targetPort) currentPort = null;

          if (canRetry && isDisconnectedPortError(error)) {
            attempt(false);
            return;
          }

          reject(toConnectionError(error));
        }
      };

      attempt(true);
    });
  }

  function handleMessage(sourcePort, message) {
    if (message?.type === "response") {
      const handler = pending.get(message.id);
      if (!handler || handler.port !== sourcePort) return;

      pending.delete(message.id);
      if (message.ok) handler.resolve(message.data);
      else handler.reject(toRemoteError(message.error));
      return;
    }

    onEvent?.(message, sourcePort);
  }

  function handleDisconnect(sourcePort) {
    if (currentPort === sourcePort) currentPort = null;

    for (const [id, handler] of pending.entries()) {
      if (handler.port !== sourcePort) continue;
      pending.delete(id);
      handler.reject(new Error("扩展连接已断开。下次操作会自动重连，请重试刚才的操作。"));
    }

    onDisconnect?.(sourcePort);
  }

  return {
    connect: ensurePort,
    request
  };
}

function toRemoteError(value) {
  if (!value || typeof value !== "object") {
    return new Error(String(value || "操作失败。"));
  }
  const error = new Error(String(value.message || "操作失败。"));
  Object.assign(error, value);
  return error;
}

export function isDisconnectedPortError(error) {
  return DISCONNECTED_PORT_PATTERN.test(String(error?.message ?? error ?? ""));
}

function toConnectionError(error) {
  const message = String(error?.message ?? error ?? "");
  if (/extension context invalidated/i.test(message)) {
    return new Error("扩展刚刚重新加载，当前侧栏已经失效。请关闭后重新打开侧栏。");
  }
  if (isDisconnectedPortError(error)) {
    return new Error("扩展连接失败。请关闭后重新打开侧栏。", { cause: error });
  }
  return error instanceof Error ? error : new Error(message || "扩展连接失败。");
}
