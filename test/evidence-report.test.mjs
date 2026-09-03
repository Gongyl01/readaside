import test from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_REPORT_PROTOCOL,
  EVIDENCE_REPORT_TOOL_NAME,
  buildEvidenceReportTool,
  snapshotEvidenceTargets,
  stripInternalBlockMarkers,
  validateEvidenceReport
} from "../lib/evidence-report.mjs";

const blocks = [
  {
    id: "B0002",
    kind: "paragraph",
    text: "前置信息。核心证据说明系统只在用户点击后读取页面。后续信息。",
    source: { frameId: 0, isMainFrame: true, rootKind: "document" },
    locator: {
      structurePath: "html:nth-of-type(1) > body:nth-of-type(1) > p:nth-of-type(1)",
      shadowPath: [],
      textQuote: { exact: "前置信息。核心证据说明系统只在用户点击后读取页面。后续信息。" }
    }
  }
];

test("hidden evidence protocol and tool use a versioned contract", () => {
  const tool = buildEvidenceReportTool();
  assert.equal(EVIDENCE_REPORT_PROTOCOL, "readaside/evidence-report/v1");
  assert.equal(tool.name, EVIDENCE_REPORT_TOOL_NAME);
  assert.equal(tool.input_schema.properties.evidence.maxItems, 3);
  assert.deepEqual(tool.input_schema.properties.evidence.items.required, [
    "blockId",
    "exactQuote",
    "supports"
  ]);
});

test("evidence targets keep full local text and DOM locator without exposing unrelated blocks", () => {
  const targets = snapshotEvidenceTargets(blocks);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].blockId, "B0002");
  assert.match(targets[0].text, /后续信息/);
  assert.match(targets[0].locator.structurePath, /p:nth-of-type/);
});

test("validator accepts verbatim core evidence from an allowed block", () => {
  const result = validateEvidenceReport({
    evidence: [{
      blockId: "B0002",
      exactQuote: "核心证据说明系统只在用户点击后读取页面。",
      supports: "读取时机"
    }]
  }, { targets: snapshotEvidenceTargets(blocks) });

  assert.equal(result.valid.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.valid[0].target.blockId, "B0002");
});

test("validator rejects invented block ids and paraphrased evidence", () => {
  const result = validateEvidenceReport({
    evidence: [
      { blockId: "B9999", exactQuote: "伪造原文", supports: "错误" },
      { blockId: "B0002", exactQuote: "系统会自动持续读取页面。", supports: "改写" }
    ]
  }, { targets: snapshotEvidenceTargets(blocks) });

  assert.equal(result.valid.length, 0);
  assert.deepEqual(result.rejected.map((item) => item.reason), [
    "内容块不属于本次发送范围。",
    "证据不是该内容块中的逐字原文。"
  ]);
});

test("validator rejects an exact quote that cannot identify one occurrence", () => {
  const duplicateBlock = [{
    ...blocks[0],
    text: "同一句证据。同一句证据。"
  }];
  const item = { blockId: "B0002", exactQuote: "同一句证据。", supports: "重复示例" };
  const result = validateEvidenceReport({ evidence: [item, item] }, {
    targets: snapshotEvidenceTargets(duplicateBlock)
  });

  assert.equal(result.valid.length, 0);
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected[0].reason, /重复出现/);
});

test("visible answers hide legacy and partially streamed internal block markers", () => {
  assert.equal(
    stripInternalBlockMarkers("第一点。[B0002][B0003] 第二点。"),
    "第一点。 第二点。"
  );
  assert.equal(stripInternalBlockMarkers("回答正在生成 [B00"), "回答正在生成");
});
