import test from "node:test";
import assert from "node:assert/strict";
import {
  BLOCK_CITATION_PROTOCOL,
  buildEvidenceCardModel,
  parseBlockCitationMarkers,
  snapshotEvidenceBlocks,
  validateBlockCitations
} from "../lib/block-citations.mjs";

const sentBlocks = [
  {
    id: "B0002",
    kind: "paragraph",
    text: "KDA 使用按通道门控更新状态。",
    headingPath: ["方法", "门控机制"],
    source: { frameId: 0, isMainFrame: true, rootKind: "document" }
  },
  {
    id: "B0010",
    kind: "table",
    text: "指标\t结果\nRecall@K\t100%",
    headingPath: ["评测结果"],
    source: {
      frameId: 2,
      isMainFrame: false,
      frameLabel: "Results frame",
      rootKind: "shadow",
      shadowDepth: 1
    }
  }
];

test("block citation protocol uses a versioned local contract", () => {
  assert.equal(BLOCK_CITATION_PROTOCOL, "readaside/block-citation/v1");
});

test("evidence snapshots preserve only citation-facing block metadata", () => {
  const snapshots = snapshotEvidenceBlocks(sentBlocks);

  assert.deepEqual(snapshots[0].headingPath, ["方法", "门控机制"]);
  assert.equal(snapshots[0].headingLabel, "方法 › 门控机制");
  assert.equal(snapshots[0].sourceLabel, "主页面");
  assert.equal(snapshots[1].sourceLabel, "Results frame · Shadow DOM");
  assert.equal(snapshots[1].kindLabel, "表格");
});

test("long evidence snapshots and cards keep both the beginning and block ending", () => {
  const longText = [
    `开头第一段 ${"甲".repeat(1_100)}`,
    `中间第二段 ${"乙".repeat(1_100)}`,
    `结尾最后一段 ${"丙".repeat(40)}`
  ].join("\n\n");
  const source = [{
    ...sentBlocks[0],
    text: longText
  }];
  const snapshots = snapshotEvidenceBlocks(source);

  assert.ok(snapshots[0].text.length <= 2_000);
  assert.match(snapshots[0].text, /^开头第一段/);
  assert.match(snapshots[0].text, /\[…中间内容已省略…\]/);
  assert.match(snapshots[0].text, /结尾最后一段/);
  assert.equal(snapshots[0].textCondensed, true);

  const validation = validateBlockCitations("依据 [B0002]。", {
    sentBlocks: snapshots,
    pageBlocks: snapshots
  });
  const card = buildEvidenceCardModel(validation).cards[0];
  assert.match(card.excerpt, /^开头第一段/);
  assert.match(card.excerpt, /\[…中间内容已省略…\]/);
  assert.match(card.excerpt, /丙+$/);
  assert.equal(card.condensed, true);
});

test("table evidence keeps the header, first two rows, omission row, and final row", () => {
  const tableText = [
    "| 字段 | 说明 |",
    "| --- | --- |",
    "| first | 第一行 |",
    "| second | 第二行 |",
    "| third | 第三行 |",
    "| fourth | 第四行 |",
    "| last | 最后一行 |"
  ].join("\n");
  const source = [{
    ...sentBlocks[1],
    text: tableText
  }];
  const snapshots = snapshotEvidenceBlocks(source);
  const validation = validateBlockCitations("表格依据 [B0010]。", {
    sentBlocks: snapshots,
    pageBlocks: snapshots
  });
  const card = buildEvidenceCardModel(validation).cards[0];

  assert.deepEqual(
    card.table.rows.map((row) => row.cells.map((cell) => cell.text)),
    [
      ["字段", "说明"],
      ["first", "第一行"],
      ["second", "第二行"],
      ["…", "…"],
      ["last", "最后一行"]
    ]
  );
  assert.equal(card.table.rows[3].omitted, true);
  assert.equal(card.table.rows[3].omittedCount, 2);
  assert.equal(card.excerpt, "");
  assert.equal(card.condensed, true);
});

test("parser finds block markers but ignores code, links, and escaped examples", () => {
  const markdown = [
    "KDA 使用通道门控。[B0002]",
    "",
    "`[B0010]` 只是行内代码。",
    "",
    "```text",
    "[B0999]",
    "```",
    "",
    "[B0010](https://example.com) 是链接标签。",
    "[B0002][evidence] 是引用式链接。",
    "[B0002]: https://example.com/evidence",
    "\\[B0003] 是转义示例。",
    "真实表格结果见 [B0010]。"
  ].join("\n");

  assert.deepEqual(
    parseBlockCitationMarkers(markdown).map((item) => item.id),
    ["B0002", "B0010"]
  );
});

test("validator accepts only sent blocks and explains other page or unknown ids", () => {
  const validation = validateBlockCitations(
    "结论一。[B0002] 重复依据。[B0002] 未发送。[B0003] 不存在。[B9999]",
    {
      sentBlocks,
      pageBlocks: [...sentBlocks, { id: "B0003", text: "页面中的其他段落" }]
    }
  );

  assert.equal(validation.references.length, 3);
  assert.equal(validation.validReferences.length, 1);
  assert.equal(validation.validReferences[0].id, "B0002");
  assert.equal(validation.validReferences[0].occurrenceCount, 2);
  assert.deepEqual(
    validation.invalidReferences.map((item) => [item.id, item.status]),
    [["B0003", "not-sent"], ["B9999", "unknown"]]
  );
  assert.match(validation.invalidReferences[0].reason, /没有包含在本次发送/);
  assert.match(validation.invalidReferences[1].reason, /不存在/);
});

test("evidence card model keeps valid evidence separate from invalid warnings", () => {
  const validation = validateBlockCitations("结果见 [B0010]，错误编号 [B9000]。", {
    sentBlocks,
    pageBlocks: sentBlocks
  });
  const model = buildEvidenceCardModel(validation);

  assert.equal(model.cards.length, 1);
  assert.equal(model.cards[0].id, "B0010");
  assert.equal(model.cards[0].headingLabel, "评测结果");
  assert.equal(model.cards[0].sourceLabel, "Results frame · Shadow DOM");
  assert.match(model.cards[0].excerpt, /Recall@K/);
  assert.deepEqual(model.invalidCards.map((item) => item.id), ["B9000"]);
});

test("missing citations safely produces an empty evidence model", () => {
  const validation = validateBlockCitations("回答可以正常显示，没有块引用。", {
    sentBlocks,
    pageBlocks: sentBlocks
  });

  assert.deepEqual(validation.references, []);
  assert.deepEqual(buildEvidenceCardModel(validation), { cards: [], invalidCards: [] });
});
