import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_CONTEXT_CHAR_BUDGET,
  SMALL_PAGE_FULL_TEXT_THRESHOLD,
  buildContextPlan
} from "../lib/context-retriever.mjs";

test("automatic context sends every structured block for a short page", () => {
  const page = pageWithBlocks([
    block("B0001", "heading", "模型说明"),
    block("B0002", "paragraph", "KDA 是一种注意力机制。", ["模型说明"])
  ]);
  const plan = buildContextPlan({ page, question: "KDA 是什么", mode: "auto" });

  assert.equal(plan.effectiveMode, "structured");
  assert.match(plan.contextText, /网页内容块 B0001/);
  assert.match(plan.contextText, /网页内容块 B0002/);
  assert.deepEqual(plan.selectedBlocks.map((item) => item.id), ["B0001", "B0002"]);
  assert.match(plan.reason, /全部结构化内容块/);
});

test("automatic context keeps every structured block within budget even with a selection", () => {
  const text = filler("需要重点解释的原文片段", SMALL_PAGE_FULL_TEXT_THRESHOLD);
  const page = pageWithBlocks([
    block("B0001", "paragraph", text)
  ]);
  const plan = buildContextPlan({
    page,
    selection: { text: "需要重点解释的原文片段" },
    question: "这是什么意思",
    mode: "auto"
  });

  assert.equal(page.text.length, SMALL_PAGE_FULL_TEXT_THRESHOLD);
  assert.equal(plan.effectiveMode, "structured");
  assert.match(plan.contextText, /网页内容块 B0001/);
  assert.match(plan.contextText, /需要重点解释的原文片段/);
  assert.equal(plan.reductionPercent, 0);
});

test("automatic context retrieves blocks once the page exceeds the full-text budget", () => {
  const page = pageWithBlocks([
    block(
      "B0001",
      "paragraph",
      filler("目标证据说明", SMALL_PAGE_FULL_TEXT_THRESHOLD + 1)
    )
  ]);
  const plan = buildContextPlan({
    page,
    question: "目标证据是什么",
    mode: "auto"
  });

  assert.equal(page.text.length, SMALL_PAGE_FULL_TEXT_THRESHOLD + 1);
  assert.equal(plan.effectiveMode, "retrieved");
  assert.ok(plan.contextText.length <= AUTO_CONTEXT_CHAR_BUDGET);
  assert.ok(plan.selectedBlocks.some((item) => item.id === "B0001"));
});

test("automatic context selects Chinese query matches and nearby blocks", () => {
  const blocks = [
    block("B0001", "heading", "模型架构"),
    block("B0002", "paragraph", filler("模型总体介绍", 550), ["模型架构"]),
    block("B0003", "paragraph", filler("KDA 使用细粒度通道门控来更新记忆状态", 550), ["模型架构"]),
    block("B0004", "paragraph", filler("该机制在线性注意力中保留相关信息", 550), ["模型架构"]),
    block("B0005", "heading", "训练数据"),
    block("B0006", "paragraph", filler("训练数据来自公开语料", 550), ["训练数据"]),
    block("B0007", "paragraph", filler("许可证和使用限制", 550), ["训练数据"])
  ];
  const page = pageWithBlocks(blocks);
  const plan = buildContextPlan(
    { page, question: "KDA 的通道门控是什么", mode: "auto" },
    { smallPageThreshold: 100, charBudget: 4_000 }
  );

  assert.equal(plan.effectiveMode, "retrieved");
  assert.ok(plan.selectedBlocks.some((item) => item.id === "B0003"));
  assert.match(plan.contextText, /网页内容块 B0003/);
  assert.match(plan.contextText, /KDA 使用细粒度通道门控/);
  assert.ok(plan.sentChars < plan.pageChars);
  assert.ok(plan.reductionPercent > 0);
});

test("paper paragraph references select the whole target and neighbors within its section", () => {
  const title = "Context Folding for Long-Horizon Agents";
  const abstract = [title, "Abstract"];
  const intro = [title, "1Introduction"];
  const blocks = [
    { ...block("B0001", "heading", title, [title]), paper: { role: "title" } },
    { ...block("B0002", "other", "Names and affiliations", [title]), paper: { role: "authors" } },
    { ...block("B0003", "heading", "Abstract", abstract), paper: { role: "abstract" } },
    { ...block("B0004", "paragraph", "An overview of the system.", abstract), paper: { role: "abstract", paragraph: 1 } },
    { ...block("B0005", "heading", "1Introduction", intro), paper: { role: "introduction" } },
    { ...block("B0006", "paragraph", "Long tasks produce records.", intro), paper: { role: "introduction", paragraph: 1 } },
    { ...block("B0007", "paragraph", "Previous methods summarize history.", intro), paper: { role: "introduction", paragraph: 2 } },
    { ...block("B0008", "paragraph", "Each compaction reads the history it replaces.", intro), paper: { role: "introduction", paragraph: 3 } },
    { ...block("B0009", "paragraph", "It then writes a new summary.", intro), paper: { role: "introduction", paragraph: 3 } },
    { ...block("B0010", "paragraph", "The runtime selects an existing view.", intro), paper: { role: "introduction", paragraph: 4 } }
  ];
  const page = { ...pageWithBlocks(blocks), documentType: "paper" };
  const question = "文章开头第三段 为什么说压缩次数增加工作量也会随之增加呢？在我看来每次压缩不都是创建进的对象对context 进行总结吗";
  const plan = buildContextPlan({ page, question, history: [{ role: "user", content: "Abstract" }] });

  assert.equal(plan.effectiveMode, "retrieved");
  assert.deepEqual(plan.selectedBlocks.map((item) => item.id), ["B0005", "B0007", "B0008", "B0009", "B0010"]);
  assert.match(plan.selectedBlocks[2].reasons[0], /按位置命中 · Introduction 第 3 段/);
  assert.ok(!plan.selectedBlocks[2].truncated);
  assert.ok(!plan.selectedBlocks[3].truncated);

  const summary = buildContextPlan({ page, question: "摘要第1段讲了什么" });
  assert.deepEqual(summary.selectedBlocks.map((item) => item.id), ["B0003", "B0004"]);

  const full = buildContextPlan({ page, question, mode: "full" });
  assert.equal(full.contextText, page.text);
});

test("paper title tokens do not pull the byline or unrelated sections into retrieval", () => {
  const title = "Context Folding for Long-Horizon Agents";
  const blocks = [
    { ...block("B0001", "heading", title, [title]), paper: { role: "title" } },
    { ...block("B0002", "other", "Names and affiliations", [title]), paper: { role: "authors" } },
    block("B0003", "heading", "Abstract", [title, "Abstract"]),
    block("B0004", "paragraph", "An overview of the system.", [title, "Abstract"]),
    block("B0005", "heading", "Methods", [title, "Methods"]),
    block("B0006", "paragraph", "The runtime folds the context programmatically.", [title, "Methods"])
  ];
  const plan = buildContextPlan({ page: pageWithBlocks(blocks), question: "context" }, { smallPageThreshold: 1 });

  assert.deepEqual(plan.selectedBlocks.map((item) => item.id), ["B0005", "B0006"]);
  assert.equal(plan.trace.candidateCount, 1);
});

test("automatic context limits lexical seeds and only expands within the same section", () => {
  const blocks = [
    block("B0001", "heading", "入口协议", ["入口协议"]),
    block("B0002", "paragraph", filler("Webhook 接收事件", 500), ["入口协议"]),
    block("B0003", "paragraph", filler("Webhook 返回 202", 500), ["入口协议"]),
    block("B0004", "heading", "失败恢复", ["失败恢复"]),
    block("B0005", "paragraph", filler("Webhook 重试规则", 500), ["失败恢复"]),
    block("B0006", "paragraph", filler("Webhook 死信处理", 500), ["失败恢复"]),
    block("B0007", "heading", "审计", ["审计"]),
    block("B0008", "paragraph", filler("Webhook 审计记录", 500), ["审计"])
  ];
  const page = pageWithBlocks(blocks);
  const plan = buildContextPlan(
    { page, question: "Webhook 返回 202 的含义", mode: "auto" },
    { smallPageThreshold: 100, charBudget: 5_000, blockLimit: 10 }
  );

  assert.ok(plan.selectedBlockCount <= 6);
  assert.ok(plan.selectedBlocks.some((item) => item.id === "B0003"));
  assert.ok(!plan.selectedBlocks.some((item) => item.id === "B0004"));
});

test("automatic context gives separate lexical seeds to compound question clauses", () => {
  const blocks = [
    block("B0001", "heading", "关闭流程", ["关闭流程"]),
    block("B0002", "paragraph", filler("事件关闭必须完成写入探针", 650), ["关闭流程"]),
    block("B0003", "paragraph", filler("一般观察指标和时间线说明", 650), ["关闭流程"]),
    block("B0004", "heading", "记录保留", ["记录保留"]),
    block("B0005", "paragraph", filler("批准记录保留一百八十天", 650), ["记录保留"])
  ];
  const page = pageWithBlocks(blocks);
  const plan = buildContextPlan(
    { page, question: "事件如何关闭，批准记录保留多久？", mode: "auto" },
    { smallPageThreshold: 100, charBudget: 4_000, blockLimit: 10 }
  );

  assert.ok(plan.selectedBlocks.some((item) => item.id === "B0002"));
  assert.ok(plan.selectedBlocks.some((item) => item.id === "B0005"));
});

test("automatic context covers three independent clauses", () => {
  const blocks = [
    block("B0001", "heading", "入口", ["入口"]),
    block("B0002", "paragraph", filler("入口使用蓝色信号", 900), ["入口"]),
    block("B0003", "heading", "恢复", ["恢复"]),
    block("B0004", "paragraph", filler("恢复依赖绿色信号", 900), ["恢复"]),
    block("B0005", "heading", "审计", ["审计"]),
    block("B0006", "paragraph", filler("审计保存红色信号", 900), ["审计"])
  ];
  const plan = buildContextPlan(
    { page: pageWithBlocks(blocks), question: "入口什么颜色，恢复什么颜色，审计什么颜色？", mode: "auto" },
    { smallPageThreshold: 100, charBudget: 4_000 }
  );

  for (const id of ["B0002", "B0004", "B0006"]) {
    assert.ok(plan.selectedBlocks.some((item) => item.id === id), `${id} is sent`);
  }
});

test("automatic context pins the block containing the current selection", () => {
  const blocks = [
    block("B0001", "heading", "第一节"),
    block("B0002", "paragraph", filler("普通内容", 700), ["第一节"]),
    block("B0003", "heading", "第二节"),
    block("B0004", "paragraph", filler("需要重点解释的原文片段", 700), ["第二节"]),
    block("B0005", "paragraph", filler("其他内容", 700), ["第二节"])
  ];
  const page = pageWithBlocks(blocks);
  const plan = buildContextPlan(
    {
      page,
      selection: { text: "需要重点解释的原文片段" },
      question: "这是什么意思",
      mode: "auto"
    },
    { smallPageThreshold: 100, charBudget: 3_000 }
  );

  const selected = plan.selectedBlocks.find((item) => item.id === "B0004");
  assert.ok(selected);
  assert.ok(selected.reasons.includes("包含当前选区"));
});

test("full context mode preserves the exact compatibility text", () => {
  const page = pageWithBlocks([
    block("B0001", "heading", "标题"),
    block("B0002", "paragraph", filler("正文", 2_500), ["标题"])
  ]);
  const plan = buildContextPlan({ page, question: "总结", mode: "full" });

  assert.equal(plan.effectiveMode, "full");
  assert.equal(plan.contextText, page.text);
  assert.equal(plan.reductionPercent, 0);
});

test("automatic context respects the local character budget", () => {
  const blocks = Array.from({ length: 12 }, (_, index) => (
    block(`B${String(index + 1).padStart(4, "0")}`, "paragraph", filler("相关问题内容", 1_000))
  ));
  const page = pageWithBlocks(blocks);
  const plan = buildContextPlan(
    { page, question: "相关问题", mode: "auto" },
    { smallPageThreshold: 100, charBudget: 2_000, blockLimit: 10 }
  );

  assert.ok(plan.contextText.length <= 2_000);
  assert.ok(plan.contextText.length <= AUTO_CONTEXT_CHAR_BUDGET);
  assert.ok(plan.selectedBlockCount <= 10);
});

test("automatic context falls back to full text when retrieval has no matches", () => {
  const page = pageWithBlocks([
    block("B0001", "heading", "数据库复制"),
    block("B0002", "paragraph", filler("备用站写入探针", 17_000), ["数据库复制"])
  ]);
  const plan = buildContextPlan({ page, question: "雨林生态研究方法", mode: "auto" });

  assert.equal(plan.effectiveMode, "full");
  assert.equal(plan.contextText, page.text);
  assert.match(plan.reason, /没有找到可安全发送/);
});

test("automatic context uses recent user questions for short follow-ups", () => {
  const blocks = [
    block("B0001", "paragraph", filler("KDA 通道门控会选择性遗忘信息", 1_200)),
    block("B0002", "paragraph", filler("训练数据和许可证", 1_200))
  ];
  const page = pageWithBlocks(blocks);
  const plan = buildContextPlan(
    {
      page,
      history: [
        { role: "user", content: "KDA 的通道门控是什么" },
        { role: "assistant", content: "它是一种细粒度门控。" }
      ],
      question: "为什么？",
      mode: "auto"
    },
    { smallPageThreshold: 100, charBudget: 1_800 }
  );

  assert.ok(plan.selectedBlocks.some((item) => item.id === "B0001"));
  assert.match(plan.contextText, /KDA 通道门控/);
});

test("automatic context sends every structured block for a whole-page summary within budget", () => {
  const blocks = [
    block("B0001", "heading", "第一章"),
    block("B0002", "paragraph", filler("第一章正文", 2_500), ["第一章"]),
    block("B0003", "heading", "第二章"),
    block("B0004", "paragraph", filler("第二章正文", 2_500), ["第二章"])
  ];
  const page = pageWithBlocks(blocks);
  const plan = buildContextPlan(
    { page, question: "总结一下整篇文章", mode: "auto" },
    { smallPageThreshold: 100, charBudget: 8_000 }
  );

  assert.equal(plan.effectiveMode, "structured");
  assert.deepEqual(plan.selectedBlocks.map((item) => item.id), ["B0001", "B0002", "B0003", "B0004"]);
  assert.match(plan.reason, /整页/);
});

test("automatic context samples multiple sections for an oversized overview", () => {
  const blocks = Array.from({ length: 12 }, (_, index) => (
    index % 2 === 0
      ? block(`B${String(index + 1).padStart(4, "0")}`, "heading", `第 ${index / 2 + 1} 章`)
      : block(
          `B${String(index + 1).padStart(4, "0")}`,
          "paragraph",
          filler(`第 ${(index + 1) / 2} 章正文`, 2_500),
          [`第 ${(index + 1) / 2} 章`]
        )
  ));
  const page = pageWithBlocks(blocks);
  const plan = buildContextPlan(
    { page, question: "概括全文的主要内容", mode: "auto" },
    { smallPageThreshold: 100, charBudget: 5_000, blockLimit: 6 }
  );

  assert.equal(plan.effectiveMode, "retrieved");
  assert.ok(plan.selectedBlocks.some((item) => item.id === "B0001"));
  assert.ok(plan.selectedBlocks.some((item) => Number(item.id.slice(1)) >= 7));
  assert.ok(plan.contextText.length <= 5_000);
});

test("focused summary includes every matching workflow section and its use case", () => {
  const workflowNames = [
    "Prompt chaining",
    "Routing",
    "Parallelization",
    "Orchestrator-workers",
    "Evaluator-optimizer"
  ];
  const blocks = [
    block("B0001", "heading", "Building effective agents", ["Building effective agents"]),
    block("B0002", "paragraph", filler("Article introduction", 900), ["Building effective agents"])
  ];
  for (const name of workflowNames) {
    const heading = `Workflow: ${name}`;
    const path = ["Building effective agents", heading];
    const nextId = () => `B${String(blocks.length + 1).padStart(4, "0")}`;
    blocks.push(block(nextId(), "heading", heading, path));
    blocks.push(block(nextId(), "paragraph", filler(`${name} definition`, 500), path));
    blocks.push(block(nextId(), "paragraph", filler(`When to use this workflow: ${name} use case`, 500), path));
    blocks.push(block(nextId(), "list", filler(`${name} examples`, 500), path));
  }
  blocks.push(block(`B${String(blocks.length + 1).padStart(4, "0")}`, "heading", "Appendix: tools", ["Building effective agents", "Appendix: tools"]));
  blocks.push(block(`B${String(blocks.length + 1).padStart(4, "0")}`, "paragraph", filler("Tool appendix", 9_000), ["Building effective agents", "Appendix: tools"]));
  const page = pageWithBlocks(blocks);

  const plan = buildContextPlan({
    page,
    question: "总结一下 workflow 的五种架构以及使用场景，可以复制的 markdown 文档吧",
    mode: "auto"
  });

  assert.equal(plan.effectiveMode, "retrieved");
  assert.match(plan.reason, /多个同类章节/);
  for (const name of workflowNames) {
    assert.ok(plan.contextText.includes(`Workflow: ${name}`), `${name} heading is sent`);
    assert.ok(plan.contextText.includes(`${name} definition`), `${name} definition is sent`);
    assert.ok(plan.contextText.includes(`${name} use case`), `${name} use case is sent`);
  }
  assert.ok(!plan.contextText.includes("Tool appendix"));
  assert.ok(plan.contextText.length <= AUTO_CONTEXT_CHAR_BUDGET);

  const fullPlan = buildContextPlan({ page, question: "再结合全文核对", mode: "full" });
  assert.equal(fullPlan.effectiveMode, "full");
  for (const name of workflowNames) {
    assert.ok(fullPlan.contextText.includes(`Workflow: ${name}`));
  }

  const topicalPlan = buildContextPlan({
    page,
    question: "总结 Workflow 的架构和使用场景",
    mode: "auto"
  });
  for (const name of workflowNames) {
    assert.ok(topicalPlan.contextText.includes(`${name} use case`), `${name} survives without a number cue`);
  }

  const specificPlan = buildContextPlan({
    page,
    question: "总结 Workflow: Routing 的适用场景",
    mode: "auto"
  });
  assert.ok(specificPlan.contextText.includes("Routing use case"));
  assert.ok(!specificPlan.contextText.includes("Parallelization use case"));
});

test("section retrieval reserves room for later sections when early definitions are long", () => {
  const names = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];
  const blocks = names.flatMap((name, sectionIndex) => {
    const first = sectionIndex * 3 + 1;
    const heading = `Pattern: ${name}`;
    const path = [heading];
    return [
      block(`B${String(first).padStart(4, "0")}`, "heading", heading, path),
      block(`B${String(first + 1).padStart(4, "0")}`, "paragraph", filler(`${name} definition`, 4_000), path),
      block(`B${String(first + 2).padStart(4, "0")}`, "paragraph", `When to use: ${name} use case`, path)
    ];
  });
  const plan = buildContextPlan({
    page: pageWithBlocks(blocks),
    question: "总结十二种 Pattern 及其使用场景",
    mode: "auto"
  });

  for (const name of names) {
    assert.ok(plan.contextText.includes(`Pattern: ${name}`));
    assert.ok(plan.contextText.includes(`${name} use case`));
  }
  assert.ok(plan.contextText.length <= AUTO_CONTEXT_CHAR_BUDGET);
});

test("automatic context serializes a selected structured table as Markdown", () => {
  const tableBlock = block("B0001", "table", "指标 结果\nRecall@K 85%", ["评测"]);
  tableBlock.table = {
    rows: [
      { cells: [{ text: "指标", header: true }, { text: "结果", header: true }] },
      { cells: [{ text: "Recall@K", header: false }, { text: "85%", header: false }] }
    ]
  };
  const plan = buildContextPlan({
    page: pageWithBlocks([tableBlock]),
    question: "Recall@K 是多少",
    mode: "auto"
  }, { smallPageThreshold: 1 });

  assert.equal(plan.effectiveMode, "retrieved");
  assert.match(plan.contextText, /\| 指标 \| 结果 \|/);
  assert.match(plan.contextText, /\| Recall@K \| 85% \|/);
  assert.deepEqual(plan.selectedBlocks[0].table, tableBlock.table);
});

function pageWithBlocks(blocks) {
  return {
    title: "测试页面",
    url: "https://example.com/article",
    text: blocks.map((item) => item.text).join("\n\n"),
    blocks
  };
}

function block(id, kind, text, headingPath = []) {
  const order = Number(id.slice(1)) - 1;
  return {
    id,
    order,
    kind,
    text,
    headingPath,
    source: {
      frameId: 0,
      frameLabel: "测试页面",
      isMainFrame: true,
      rootKind: "document",
      shadowDepth: 0
    },
    locator: {}
  };
}

function filler(prefix, length) {
  return `${prefix} ${"补充说明".repeat(Math.ceil(length / 4))}`.slice(0, length);
}
