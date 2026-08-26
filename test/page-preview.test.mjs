import test from "node:test";
import assert from "node:assert/strict";
import { buildPagePreviewModel } from "../lib/page-preview.mjs";

test("page preview exposes the exact text sent to the model", () => {
  const model = buildPagePreviewModel({
    text: "第一段\n\n第二段",
    frameCount: 2,
    detectedDocumentCount: 2,
    shadowRootCount: 1,
    canvasCount: 0,
    truncated: false
  });

  assert.equal(model.text, "第一段\n\n第二段");
  assert.equal(model.stats[1].value, "2/2");
  assert.equal(model.warnings[0].level, "success");
});

test("page preview reports every known reading limitation", () => {
  const model = buildPagePreviewModel({
    text: "截断文本",
    frameCount: 1,
    detectedDocumentCount: 3,
    shadowRootCount: 0,
    canvasCount: 2,
    truncated: true
  });

  assert.equal(model.warnings.length, 3);
  assert.match(model.warnings[0].text, /8 万字符/);
  assert.match(model.warnings[1].text, /2 个文档层未能读取/);
  assert.match(model.warnings[2].text, /2 个 Canvas/);
});
