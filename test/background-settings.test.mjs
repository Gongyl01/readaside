import test from "node:test";
import assert from "node:assert/strict";

test("saved OpenAI compatible settings drive model checks and chat requests", async () => {
  const saved = { deepseekApiKey: "legacy-deepseek-key" };
  let connectListener;
  let portListener;
  let streamDone;
  const posted = [];
  const requests = [];
  const pending = new Map();

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onConnect: { addListener(listener) { connectListener = listener; } }
    },
    sidePanel: { setPanelBehavior: async () => {} },
    permissions: { contains: async () => true },
    storage: {
      local: {
        async get(names) {
          return Object.fromEntries(names.filter((name) => name in saved).map((name) => [name, saved[name]]));
        },
        async set(values) { Object.assign(saved, values); },
        async remove(names) {
          for (const name of Array.isArray(names) ? names : [names]) delete saved[name];
        }
      }
    }
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "future-model" }] }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.endsWith("/messages")) {
      return new Response('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"另一条回答"}}\n\ndata: {"type":"message_stop"}\n\n', {
        headers: { "Content-Type": "text/event-stream" }
      });
    }
    return new Response('data: {"choices":[{"delta":{"content":"回答"}}]}\n\ndata: [DONE]\n\n', {
      headers: { "Content-Type": "text/event-stream" }
    });
  };

  await import("../background.mjs");
  connectListener({
    name: "reading-assistant",
    onMessage: { addListener(listener) { portListener = listener; } },
    onDisconnect: { addListener() {} },
    postMessage(message) {
      posted.push(message);
      if (message.type === "response") pending.get(message.id)?.(message);
      if (message.type === "stream.done") streamDone?.();
    }
  });
  let nextId = 0;
  const send = (action, payload = {}) => new Promise((resolve) => {
    const id = String(++nextId);
    pending.set(id, resolve);
    portListener({ id, action, payload });
  });

  const legacy = await send("key.status");
  assert.equal(legacy.data.model, "deepseek-flash");
  assert.equal(legacy.data.configured, true);

  const savedResponse = await send("key.save", {
    preset: "custom",
    protocol: "openai",
    baseUrl: "https://models.example.test/v1",
    model: "future-model",
    key: "new-provider-secret-key"
  });
  assert.equal(savedResponse.ok, true);
  assert.equal(saved.deepseekApiKey, undefined);
  assert.equal(saved.apiSettings.model, "future-model");

  const check = await send("key.test");
  assert.equal(check.data.modelAvailable, true);
  assert.equal(requests[0].url, "https://models.example.test/v1/models");

  const done = new Promise((resolve) => { streamDone = resolve; });
  const started = await send("chat.start", {
    page: { title: "测试页", url: "https://example.com", text: "页面内容" },
    question: "请总结"
  });
  assert.equal(started.data.started, true);
  await done;
  assert.equal(requests[1].url, "https://models.example.test/v1/chat/completions");
  assert.equal(requests[1].options.headers.Authorization, "Bearer new-provider-secret-key");
  assert.equal(JSON.parse(requests[1].options.body).model, "future-model");
  assert.equal(JSON.parse(requests[1].options.body).max_tokens, 4096);
  assert.equal(JSON.parse(requests[1].options.body).max_completion_tokens, undefined);
  assert.ok(posted.some((message) => message.type === "stream.delta" && message.delta === "回答"));

  const rejected = await send("key.save", {
    preset: "custom",
    protocol: "openai",
    baseUrl: "https://other.example.test/v1",
    model: "future-model",
    key: ""
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error.message, /重新输入/);
  assert.equal(saved.apiSettings.baseUrl, "https://models.example.test/v1");

  const anthropicSaved = await send("key.save", {
    preset: "custom",
    protocol: "anthropic",
    baseUrl: "https://messages.example.test/v1",
    model: "manual-model",
    key: "short"
  });
  assert.equal(anthropicSaved.ok, true);
  const anthropicDone = new Promise((resolve) => { streamDone = resolve; });
  await send("chat.start", {
    page: { title: "测试页", url: "https://example.com", text: "页面内容" },
    question: "再总结"
  });
  await anthropicDone;
  const last = requests.at(-1);
  assert.equal(last.url, "https://messages.example.test/v1/messages");
  assert.equal(last.options.headers["x-api-key"], "short");
  assert.equal(JSON.parse(last.options.body).tools, undefined);
  assert.equal(JSON.parse(last.options.body).max_tokens, 4096);
  assert.ok(posted.some((message) => message.type === "stream.delta" && message.delta === "另一条回答"));

  for (const preset of ["openai", "anthropic", "deepseek"]) {
    const settingsResponse = await send("key.save", {
      preset,
      model: "manual-model",
      key: "preset-test-key"
    });
    assert.equal(settingsResponse.ok, true);
    const presetDone = new Promise((resolve) => { streamDone = resolve; });
    await send("chat.start", {
      page: { title: "测试页", url: "https://example.com", text: "页面内容" },
      question: "请总结"
    });
    await presetDone;
    const body = JSON.parse(requests.at(-1).options.body);
    if (preset === "openai") {
      assert.equal(body.max_completion_tokens, 4096);
      assert.equal(body.max_tokens, undefined);
    } else {
      assert.equal(body.max_tokens, 4096);
      assert.equal(body.max_completion_tokens, undefined);
    }
    if (preset === "deepseek") {
      assert.ok(body.tools.some((tool) => tool.name === "web_search"));
    }
  }
});
