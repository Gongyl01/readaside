import test from "node:test";
import assert from "node:assert/strict";
import {
  DEEPSEEK_STATUS_URL,
  createRequestError,
  describeHttpError,
  formatErrorLabel,
  normalizeRequestError
} from "../lib/request-error.mjs";

test("HTTP errors preserve status and actionable categories", () => {
  assert.deepEqual(describeHttpError(401), {
    code: "authentication",
    category: "account",
    message: "API Key 无效或没有访问权限，请重新检查。",
    advice: "请在设置中重新保存并测试 API Key。",
    httpStatus: 401,
    retryable: false,
    statusUrl: ""
  });

  const unavailable = describeHttpError(503);
  assert.equal(unavailable.retryable, true);
  assert.equal(unavailable.statusUrl, DEEPSEEK_STATUS_URL);
  assert.equal(formatErrorLabel(unavailable), "HTTP 503 · 模型服务");
});

test("custom request errors are safe to serialize for the side panel", () => {
  const error = createRequestError({
    code: "network",
    category: "network",
    message: "无法连接 DeepSeek。",
    advice: "检查代理。",
    retryable: true
  });
  const normalized = normalizeRequestError(error);

  assert.equal(normalized.code, "network");
  assert.equal(normalized.category, "network");
  assert.equal(normalized.httpStatus, null);
  assert.equal(normalized.retryable, true);
});

test("disconnected ports become retryable extension errors", () => {
  const normalized = normalizeRequestError(new Error("扩展连接已断开。"));
  assert.equal(normalized.code, "extension_connection");
  assert.equal(normalized.retryable, true);
});
