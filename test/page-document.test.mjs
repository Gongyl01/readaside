import test from "node:test";
import assert from "node:assert/strict";
import {
  formatTableAsMarkdown,
  MAX_STRUCTURED_PAGE_CHARS,
  mergeExtractedPageDocuments,
  normalizeTableData,
  summarizeBlockKinds
} from "../lib/page-document.mjs";

test("page document normalizes blocks across frames with deterministic metadata", () => {
  const page = mergeExtractedPageDocuments(
    [
      {
        frameId: 0,
        result: {
          title: "Main",
          url: "https://example.com",
          text: "Title\n\nBody",
          blocks: [
            structuredBlock("heading", "Title", ["Title"]),
            structuredBlock("paragraph", "Body", ["Title"])
          ]
        }
      },
      {
        frameId: 3,
        result: {
          title: "Log frame",
          url: "https://example.com/log",
          text: "SUCCESS",
          blocks: [structuredBlock("code", "SUCCESS")]
        }
      }
    ],
    {
      captureId: "capture-test",
      capturedAt: "2026-08-26T00:00:00.000Z"
    }
  );

  assert.equal(page.captureId, "capture-test");
  assert.equal(page.capturedAt, "2026-08-26T00:00:00.000Z");
  assert.deepEqual(page.blocks.map((block) => block.id), ["B0001", "B0002", "B0003"]);
  assert.deepEqual(page.blockTypeCounts, { heading: 1, paragraph: 1, code: 1 });
  assert.equal(page.blocks[2].source.frameId, 3);
  assert.equal(page.blocks[2].source.frameLabel, "Log frame");
});

test("page document limits structured block text independently from compatibility text", () => {
  const oversized = "x".repeat(MAX_STRUCTURED_PAGE_CHARS + 10);
  const page = mergeExtractedPageDocuments(
    [{
      frameId: 0,
      result: {
        title: "Long",
        url: "https://example.com/long",
        text: oversized,
        blocks: [structuredBlock("paragraph", oversized)]
      }
    }],
    { captureId: "capture-long", capturedAt: "2026-08-26T00:00:00.000Z" }
  );

  assert.equal(page.structuredChars, MAX_STRUCTURED_PAGE_CHARS);
  assert.equal(page.blocks[0].text.length, MAX_STRUCTURED_PAGE_CHARS);
  assert.equal(page.blocks[0].truncated, true);
  assert.equal(page.structuredTruncated, true);
  assert.equal(page.text.length, MAX_STRUCTURED_PAGE_CHARS);
});

test("block summaries normalize unknown kinds as other", () => {
  assert.deepEqual(
    summarizeBlockKinds([{ kind: "heading" }, { kind: "unknown" }, {}]),
    { heading: 1, other: 2 }
  );
});

test("page document preserves simple table data and formats it as Markdown", () => {
  const table = {
    rows: [
      { cells: [{ text: "指标", header: true }, { text: "结果", header: true }] },
      { cells: [{ text: "Recall@K", header: false }, { text: "85% | 目标", header: false }] }
    ]
  };
  const block = structuredBlock("table", "指标 结果\nRecall@K 85% | 目标");
  block.table = table;
  const page = mergeExtractedPageDocuments([{
    frameId: 0,
    result: {
      title: "Metrics",
      url: "https://example.com/metrics",
      text: block.text,
      blocks: [block]
    }
  }], { captureId: "capture-table", capturedAt: "2026-08-27T00:00:00.000Z" });

  assert.deepEqual(page.blocks[0].table, table);
  assert.equal(formatTableAsMarkdown(page.blocks[0].table), [
    "| 指标 | 结果 |",
    "| --- | --- |",
    "| Recall@K | 85% \\| 目标 |"
  ].join("\n"));
});

test("table normalization rejects ragged rows so callers can fall back to text", () => {
  assert.equal(normalizeTableData({
    rows: [
      { cells: [{ text: "A" }, { text: "B" }] },
      { cells: [{ text: "1" }] }
    ]
  }), null);
});

function structuredBlock(kind, text, headingPath = []) {
  return {
    kind,
    text,
    headingPath,
    source: { rootKind: "document", shadowDepth: 0 },
    locator: {
      structurePath: "body > p:nth-of-type(1)",
      shadowPath: [],
      textQuote: { exact: text, prefix: "", suffix: "" }
    }
  };
}
