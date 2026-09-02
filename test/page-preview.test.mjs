import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContextPreviewModel,
  buildPagePreviewModel,
  formatBlockPreviewText
} from "../lib/page-preview.mjs";

test("page preview exposes the exact text sent to the model", () => {
  const model = buildPagePreviewModel({
    text: "第一段\n\n第二段",
    frameCount: 2,
    detectedDocumentCount: 2,
    shadowRootCount: 1,
    canvasCount: 0,
    blockCount: 7,
    blocks: [{
      id: "B0001",
      kind: "heading",
      text: "第一节",
      headingPath: ["第一节"],
      source: { isMainFrame: true, rootKind: "document" }
    }],
    blockTypeCounts: { heading: 1, paragraph: 5, code: 1 },
    truncated: false
  });

  assert.equal(model.text, "第一段\n\n第二段");
  assert.equal(model.stats[1].value, "2/2");
  assert.equal(model.stats[4].value, "7 个");
  assert.equal(model.stats[5].value, "标题 1 · 正文 5 · 代码 1");
  assert.equal(model.blocks[0].kindLabel, "标题");
  assert.equal(model.blocks[0].previewText, "第一节");
  assert.equal(model.blocks[0].sourceLabel, "主页面");
  assert.equal(model.warnings[0].level, "success");
});

test("preview reflows prose without changing the source block text", () => {
  const sourceText = "第一行   内容\n第二行 ，继续。\n\n  第三段";
  const model = buildPagePreviewModel({
    text: sourceText,
    blocks: [{
      id: "B0001",
      kind: "paragraph",
      text: sourceText,
      source: { isMainFrame: true, rootKind: "document" }
    }]
  });

  assert.equal(model.blocks[0].text, sourceText);
  assert.equal(model.blocks[0].previewText, "第一行 内容 第二行，继续。\n\n第三段");
  assert.equal(model.text, sourceText);
});

test("preview preserves layout for code and rows for lists", () => {
  assert.equal(
    formatBlockPreviewText("\nconst x = 1;\n  return x;\n", "code"),
    "const x = 1;\n  return x;"
  );
  assert.equal(
    formatBlockPreviewText("-  第一项\n\n-   第二项", "list"),
    "- 第一项\n- 第二项"
  );
});

test("preview exposes structured rows for native table rendering", () => {
  const table = {
    rows: [
      { cells: [{ text: "指标", header: true }, { text: "结果", header: true }] },
      { cells: [{ text: "Recall@K", header: false }, { text: "85%", header: false }] }
    ]
  };
  const model = buildPagePreviewModel({
    text: "指标 结果\nRecall@K 85%",
    blocks: [{
      id: "B0001",
      kind: "table",
      text: "指标 结果\nRecall@K 85%",
      table,
      source: { isMainFrame: true, rootKind: "document" }
    }]
  });

  assert.deepEqual(model.blocks[0].table, table);
  assert.equal(model.blocks[0].previewText, "指标 结果\nRecall@K 85%");
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

test("page preview reports an independently truncated structured view", () => {
  const model = buildPagePreviewModel({
    text: "完整兼容文本",
    frameCount: 1,
    detectedDocumentCount: 1,
    blockCount: 2,
    blockTypeCounts: { paragraph: 2 },
    structuredTruncated: true,
    truncated: false
  });

  assert.equal(model.warnings.length, 1);
  assert.match(model.warnings[0].text, /结构化内容块超过 8 万字符/);
});

test("context preview explains selected blocks and character reduction", () => {
  const model = buildContextPreviewModel({
    requestedMode: "auto",
    effectiveMode: "retrieved",
    reason: "已根据问题选择相关内容块。",
    pageChars: 10_000,
    sentChars: 2_500,
    reductionPercent: 75,
    totalBlockCount: 20,
    selectedBlockCount: 4,
    selectedBlocks: [{
      id: "B0007",
      kind: "paragraph",
      text: "相关正文",
      headingPath: ["架构"],
      source: { isMainFrame: true, rootKind: "document" },
      reasons: ["命中问题：架构"]
    }]
  });

  assert.equal(model.modeLabel, "自动选择");
  assert.equal(model.countLabel, "2,500 / 10,000 字符");
  assert.equal(model.stats[2].value, "4/20");
  assert.equal(model.stats[3].value, "75%");
  assert.deepEqual(model.blocks[0].reasons, ["命中问题：架构"]);
});
