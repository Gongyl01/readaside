import test from "node:test";
import assert from "node:assert/strict";
import {
  apiEndpoint,
  apiPermissionOrigin,
  normalizeApiConfig
} from "../lib/api-config.mjs";
import { parseOpenAiSseChunk } from "../lib/openai-stream.mjs";
import { buildMessages } from "../lib/deepseek.mjs";

test("presets fix the protocol and endpoint while keeping the model user editable", () => {
  const config = normalizeApiConfig({ preset: "openai", protocol: "anthropic", model: "my-model" });
  assert.equal(config.protocol, "openai");
  assert.equal(apiEndpoint(config, "chat/completions"), "https://api.openai.com/v1/chat/completions");
  assert.equal(apiPermissionOrigin(config), "https://api.openai.com/*");
  assert.equal(config.model, "my-model");
});

test("custom endpoints reject unsafe URLs and accept local development servers", () => {
  assert.throws(() => normalizeApiConfig({
    preset: "custom", protocol: "openai", baseUrl: "http://example.com/v1", model: "test"
  }), /HTTPS/);
  assert.throws(() => normalizeApiConfig({
    preset: "custom", protocol: "anthropic", baseUrl: "https://user:pass@example.com/v1", model: "test"
  }), /不能包含账号/);
  assert.throws(() => normalizeApiConfig({
    preset: "custom", protocol: "openai", baseUrl: "https://example.com/v1/chat/completions", model: "test"
  }), /接口根路径/);

  const local = normalizeApiConfig({
    preset: "custom", protocol: "openai", baseUrl: "http://localhost:11434/v1/", model: "local"
  });
  assert.equal(local.baseUrl, "http://localhost:11434/v1");
  assert.equal(apiPermissionOrigin(local), "http://localhost/*");
});

test("OpenAI compatible streaming handles split chunks and ignores usage-only chunks", () => {
  const first = parseOpenAiSseChunk("", 'data: {"choices":[{"delta":{"content":"你');
  assert.deepEqual(first.events, []);
  const second = parseOpenAiSseChunk(first.buffer,
    '好"}}]}\n\ndata: {"choices":[],"usage":{"total_tokens":2}}\n\ndata: [DONE]\n\n');
  assert.deepEqual(second.events, [{ type: "delta", delta: "你好" }]);
  assert.equal(second.buffer, "");
});

test("providers without web search or evidence tools receive matching instructions", () => {
  const messages = buildMessages({
    page: { title: "页面", url: "https://example.com", text: "正文" },
    question: "总结"
  }, { allowWebSearch: false, allowEvidence: false });
  assert.match(messages[0].content, /没有联网搜索工具/);
  assert.doesNotMatch(messages[0].content, /调用 report_page_evidence/);
});
