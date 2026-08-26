import test from "node:test";
import assert from "node:assert/strict";
import { createPortClient } from "../lib/port-client.mjs";

function createFakePort({ postError = null } = {}) {
  const messageListeners = [];
  const disconnectListeners = [];

  return {
    messages: [],
    onMessage: {
      addListener(listener) {
        messageListeners.push(listener);
      }
    },
    onDisconnect: {
      addListener(listener) {
        disconnectListeners.push(listener);
      }
    },
    postMessage(message) {
      if (postError) throw postError;
      this.messages.push(message);
    },
    emitMessage(message) {
      for (const listener of messageListeners) listener(message);
    },
    disconnect() {
      for (const listener of disconnectListeners) listener();
    }
  };
}

function createIds() {
  let value = 0;
  return () => `request-${++value}`;
}

test("port client reconnects once when posting to a stale port fails synchronously", async () => {
  const stalePort = createFakePort({
    postError: new Error("Attempting to use a disconnected port object")
  });
  const freshPort = createFakePort();
  const ports = [stalePort, freshPort];
  let connectionCount = 0;

  const client = createPortClient({
    connect: () => {
      connectionCount += 1;
      return ports.shift();
    },
    createId: createIds()
  });

  const request = client.request("key.status");
  const sent = freshPort.messages[0];
  freshPort.emitMessage({ type: "response", id: sent.id, ok: true, data: { configured: true } });

  assert.deepEqual(await request, { configured: true });
  assert.equal(connectionCount, 2);
});

test("port client rejects an in-flight request instead of automatically resending it", async () => {
  const firstPort = createFakePort();
  const secondPort = createFakePort();
  const ports = [firstPort, secondPort];
  let connectionCount = 0;

  const client = createPortClient({
    connect: () => {
      connectionCount += 1;
      return ports.shift();
    },
    createId: createIds()
  });

  const interrupted = client.request("chat.start", {}, "chat-1");
  firstPort.disconnect();

  await assert.rejects(interrupted, /下次操作会自动重连/);
  assert.equal(connectionCount, 1);
  assert.equal(secondPort.messages.length, 0);

  const nextRequest = client.request("key.status");
  const sent = secondPort.messages[0];
  secondPort.emitMessage({ type: "response", id: sent.id, ok: true, data: { configured: false } });

  assert.deepEqual(await nextRequest, { configured: false });
  assert.equal(connectionCount, 2);
});

test("responses from an old port cannot resolve a request sent through a new port", async () => {
  const firstPort = createFakePort();
  const secondPort = createFakePort();
  const ports = [firstPort, secondPort];
  const client = createPortClient({ connect: () => ports.shift(), createId: createIds() });

  client.connect();
  firstPort.disconnect();

  const request = client.request("key.status");
  const sent = secondPort.messages[0];
  firstPort.emitMessage({ type: "response", id: sent.id, ok: true, data: { source: "old" } });
  secondPort.emitMessage({ type: "response", id: sent.id, ok: true, data: { source: "new" } });

  assert.deepEqual(await request, { source: "new" });
});

test("port client preserves structured remote error details", async () => {
  const port = createFakePort();
  const client = createPortClient({ connect: () => port, createId: createIds() });
  const request = client.request("chat.start");
  const sent = port.messages[0];

  port.emitMessage({
    type: "response",
    id: sent.id,
    ok: false,
    error: {
      code: "provider_unavailable",
      category: "provider",
      message: "DeepSeek 服务暂时不可用，请稍后重试。",
      advice: "查看状态页后手动重新发送。",
      httpStatus: 503,
      retryable: true,
      statusUrl: "https://status.deepseek.com/"
    }
  });

  await assert.rejects(request, (error) => {
    assert.equal(error.message, "DeepSeek 服务暂时不可用，请稍后重试。");
    assert.equal(error.code, "provider_unavailable");
    assert.equal(error.httpStatus, 503);
    assert.equal(error.retryable, true);
    assert.equal(error.statusUrl, "https://status.deepseek.com/");
    return true;
  });
});
