import { access, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SMALL_PAGE_FULL_TEXT_THRESHOLD,
  buildContextPlan
} from "../lib/context-retriever.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evaluationDirectory = resolve(projectRoot, "test/evaluation");
const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
const timingRuns = 30;
const scaleBlockCount = 2_000;
const scaleP95ThresholdMilliseconds = 100;
const longPageTargetChars = SMALL_PAGE_FULL_TEXT_THRESHOLD + 8_000;
const enforceThresholds = process.argv.includes("--enforce");
const markdownOutput = process.argv.includes("--markdown");
const jsonOutput = process.argv.includes("--json");
const compareArgument = process.argv.find((argument) => argument.startsWith("--compare="));

assert(!(jsonOutput && markdownOutput), "--json 和 --markdown 不能同时使用");
assert(!(jsonOutput && compareArgument), "--json 和 --compare 不能同时使用");

const datasetFiles = (await readdir(evaluationDirectory))
  .filter((name) => name.endsWith(".questions.json"))
  .sort()
  .map((name) => resolve(evaluationDirectory, name));

if (!datasetFiles.length) throw new Error("没有找到上下文评测集。");

const results = [];
for (const datasetFile of datasetFiles) {
  results.push(await evaluateDataset(datasetFile));
}

const report = summarizeResults(results);
const snapshot = createSnapshot(report);

if (jsonOutput) {
  console.log(JSON.stringify(snapshot, null, 2));
} else {
  console.log(markdownOutput ? renderMarkdown(report) : renderConsole(report));
  if (compareArgument) {
    const baselinePath = resolveComparisonPath(compareArgument.slice("--compare=".length));
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    console.log(`\n${renderComparison(baseline, snapshot, relative(projectRoot, baselinePath))}`);
  }
}

if (enforceThresholds && !report.passed) process.exitCode = 1;

async function evaluateDataset(datasetFile) {
  const dataset = JSON.parse(await readFile(datasetFile, "utf8"));
  assert(
    dataset.schemaVersion === "readaside/context-evaluation/v1",
    `${relative(projectRoot, datasetFile)} 的 schemaVersion 不受支持`
  );
  assert(Array.isArray(dataset.cases) && dataset.cases.length, "评测集必须包含问题");

  const fixtureFile = resolve(dirname(datasetFile), String(dataset.fixture || ""));
  const fixture = JSON.parse(await readFile(fixtureFile, "utf8"));
  assert(
    fixture.schemaVersion === "readaside/context-fixture/v1",
    `${relative(projectRoot, fixtureFile)} 的 schemaVersion 不受支持`
  );
  if (fixture.html) await access(resolve(dirname(fixtureFile), fixture.html));

  const shortPage = buildFixturePage(fixture);
  const page = buildLongFixturePage(shortPage);
  const seenCaseIds = new Set();
  const cases = [];
  const durationSamples = [];

  for (const evaluationCase of dataset.cases) {
    const caseId = String(evaluationCase.id || "").trim();
    const question = String(evaluationCase.question || "").trim();
    assert(caseId && !seenCaseIds.has(caseId), `问题编号为空或重复：${caseId}`);
    assert(question, `${caseId} 缺少问题文本`);
    seenCaseIds.add(caseId);

    const expectedBlockIds = resolveEvidenceBlocks(
      shortPage.blocks,
      evaluationCase.evidenceQuotes,
      caseId
    );
    const shortPlan = buildContextPlan({ page: shortPage, question, mode: "auto" });
    const plan = buildContextPlan({ page, question, mode: "auto" });
    for (let run = 0; run < timingRuns; run += 1) {
      const startedAt = performance.now();
      buildContextPlan({ page, question, mode: "auto" });
      durationSamples.push(performance.now() - startedAt);
    }

    const selectedBlockIds = new Set(plan.trace.selectedBlockIds);
    const matchedBlockIds = expectedBlockIds.filter((id) => selectedBlockIds.has(id));
    const shortSelectedBlockIds = new Set(shortPlan.trace.selectedBlockIds);
    const shortMatchedBlockIds = expectedBlockIds.filter((id) => shortSelectedBlockIds.has(id));
    cases.push({
      id: caseId,
      question,
      expectedBlockIds,
      selectedBlockIds: plan.trace.selectedBlockIds,
      matchedBlockIds,
      recallPercent: percent(matchedBlockIds.length, expectedBlockIds.length),
      reductionPercent: plan.reductionPercent,
      effectiveMode: plan.effectiveMode,
      sentChars: plan.sentChars,
      selectedBlockCount: plan.selectedBlockCount,
      shortPage: {
        effectiveMode: shortPlan.effectiveMode,
        sentChars: shortPlan.sentChars,
        matchedBlockIds: shortMatchedBlockIds,
        recallPercent: percent(shortMatchedBlockIds.length, expectedBlockIds.length)
      }
    });
  }

  const expectedCount = cases.reduce((total, item) => total + item.expectedBlockIds.length, 0);
  const matchedCount = cases.reduce((total, item) => total + item.matchedBlockIds.length, 0);
  const thresholds = {
    recallPercent: positiveNumber(dataset.thresholds?.recallPercent, 85),
    medianReductionPercent: positiveNumber(
      dataset.thresholds?.medianReductionPercent,
      60
    )
  };
  const recallPercent = percent(matchedCount, expectedCount);
  const medianReductionPercent = percentile(
    cases.map((item) => item.reductionPercent),
    50
  );
  const shortExpectedCount = expectedCount;
  const shortMatchedCount = cases.reduce(
    (total, item) => total + item.shortPage.matchedBlockIds.length,
    0
  );
  const shortCompleteContextCount = cases.filter(
    (item) => item.shortPage.effectiveMode === "structured"
  ).length;
  const shortPageResult = {
    pageChars: shortPage.text.length,
    expectedCount: shortExpectedCount,
    matchedCount: shortMatchedCount,
    recallPercent: percent(shortMatchedCount, shortExpectedCount),
    completeContextCount: shortCompleteContextCount,
    passed:
      shortCompleteContextCount === cases.length &&
      shortMatchedCount === shortExpectedCount
  };

  return {
    dataset: relative(projectRoot, datasetFile),
    fixture: relative(projectRoot, fixtureFile),
    fixtureId: String(fixture.id || "unknown"),
    shortPage: shortPageResult,
    pageChars: page.text.length,
    blockCount: page.blocks.length,
    sourceLayerCount: new Set(page.blocks.map(sourceLayerKey)).size,
    questionCount: cases.length,
    expectedCount,
    matchedCount,
    recallPercent,
    medianReductionPercent,
    fallbackCount: cases.filter((item) => item.effectiveMode === "full").length,
    p95Milliseconds: percentile(durationSamples, 95),
    durationSamples,
    thresholds,
    passed:
      shortPageResult.passed &&
      recallPercent >= thresholds.recallPercent &&
      medianReductionPercent >= thresholds.medianReductionPercent,
    cases
  };
}

function buildFixturePage(fixture) {
  assert(Array.isArray(fixture.blocks) && fixture.blocks.length, "夹具必须包含内容块");
  const blocks = fixture.blocks.map((sourceBlock, index) => {
    const id = `B${String(index + 1).padStart(4, "0")}`;
    const fixtureSource = sourceBlock?.source && typeof sourceBlock.source === "object"
      ? sourceBlock.source
      : {};
    const frameId = Number.isFinite(Number(fixtureSource.frameId))
      ? Number(fixtureSource.frameId)
      : 0;
    const frameLabel = String(
      fixtureSource.frameLabel || fixtureSource.frameTitle || fixture.title || "评测夹具"
    );
    return {
      id,
      order: index,
      kind: String(sourceBlock.kind || "other"),
      text: String(sourceBlock.text || "").trim(),
      headingPath: (Array.isArray(sourceBlock.headingPath) ? sourceBlock.headingPath : [])
        .map((part) => String(part).trim())
        .filter(Boolean),
      source: {
        frameId,
        frameLabel,
        frameTitle: String(fixtureSource.frameTitle || frameLabel),
        frameUrl: String(fixtureSource.frameUrl || fixture.url || ""),
        isMainFrame: frameId === 0,
        rootKind: fixtureSource.rootKind === "shadow" ? "shadow" : "document",
        shadowDepth: nonNegativeInteger(fixtureSource.shadowDepth)
      },
      locator: {
        structurePath: "",
        shadowPath: [],
        textQuote: { exact: String(sourceBlock.text || "").slice(0, 320), prefix: "", suffix: "" }
      },
      ...(sourceBlock.table ? { table: sourceBlock.table } : {})
    };
  });
  assert(blocks.every((block) => block.text), "夹具中存在空内容块");

  const compatibilityPrefix = (Array.isArray(fixture.compatibilityPrefix)
    ? fixture.compatibilityPrefix
    : [])
    .map((part) => String(part).trim())
    .filter(Boolean);
  return {
    schemaVersion: "readaside/page-document/v1",
    captureId: `evaluation-${fixture.id || "fixture"}`,
    capturedAt: "2026-08-28T00:00:00.000Z",
    title: String(fixture.title || "评测夹具"),
    url: String(fixture.url || ""),
    text: [...compatibilityPrefix, ...blocks.map((block) => block.text)].join("\n\n"),
    blocks,
    evaluationCompatibilityPrefix: compatibilityPrefix.join("\n\n")
  };
}

function buildLongFixturePage(page) {
  if (page.text.length > SMALL_PAGE_FULL_TEXT_THRESHOLD) return page;
  const blocks = page.blocks.map((block) => ({ ...block }));
  const expandableIndexes = blocks
    .map((block, index) => block.kind === "paragraph" ? index : -1)
    .filter((index) => index >= 0);
  assert(expandableIndexes.length, `${page.title} 缺少可扩成长页的正文块`);

  const remainingChars = Math.max(0, longPageTargetChars - page.text.length);
  const paddingPerBlock = Math.ceil(remainingChars / expandableIndexes.length);
  for (const index of expandableIndexes) {
    const paddingSeed = `benchmarkpadding${index + 1} loremipsumdolorsitamet `;
    const padding = paddingSeed
      .repeat(Math.ceil(paddingPerBlock / paddingSeed.length))
      .slice(0, paddingPerBlock);
    blocks[index].text = `${blocks[index].text}\n\n${padding}`;
  }

  const prefix = String(page.evaluationCompatibilityPrefix || "").trim();
  const text = [prefix, ...blocks.map((block) => block.text)].filter(Boolean).join("\n\n");
  assert(text.length > SMALL_PAGE_FULL_TEXT_THRESHOLD, `${page.title} 长页夹具未超过全文阈值`);
  return {
    ...page,
    captureId: `${page.captureId}-long`,
    text,
    blocks
  };
}

function resolveEvidenceBlocks(blocks, value, caseId) {
  const quotes = (Array.isArray(value) ? value : [])
    .map((quote) => String(quote).trim())
    .filter(Boolean);
  assert(quotes.length, `${caseId} 必须标注至少一条证据原文`);
  const blockIds = [];

  for (const quote of quotes) {
    const matches = blocks.filter((block) => block.text.includes(quote));
    assert(matches.length === 1, `${caseId} 的证据原文必须唯一命中一个块：${quote}`);
    blockIds.push(matches[0].id);
  }
  return [...new Set(blockIds)];
}

function summarizeResults(datasets) {
  const expectedCount = datasets.reduce((total, item) => total + item.expectedCount, 0);
  const matchedCount = datasets.reduce((total, item) => total + item.matchedCount, 0);
  const cases = datasets.flatMap((item) => item.cases);
  const scaleBenchmark = evaluateScaleBenchmark();
  const shortExpectedCount = datasets.reduce(
    (total, item) => total + item.shortPage.expectedCount,
    0
  );
  const shortMatchedCount = datasets.reduce(
    (total, item) => total + item.shortPage.matchedCount,
    0
  );
  const shortQuestionCount = datasets.reduce((total, item) => total + item.questionCount, 0);
  const shortCompleteContextCount = datasets.reduce(
    (total, item) => total + item.shortPage.completeContextCount,
    0
  );
  return {
    version: String(packageJson.version),
    generatedAt: new Date().toISOString().slice(0, 10),
    datasets,
    questionCount: cases.length,
    expectedCount,
    matchedCount,
    recallPercent: percent(matchedCount, expectedCount),
    medianReductionPercent: percentile(
      cases.map((item) => item.reductionPercent),
      50
    ),
    fallbackCount: datasets.reduce((total, item) => total + item.fallbackCount, 0),
    p95Milliseconds: percentile(
      datasets.flatMap((item) => item.durationSamples),
      95
    ),
    shortPage: {
      questionCount: shortQuestionCount,
      expectedCount: shortExpectedCount,
      matchedCount: shortMatchedCount,
      recallPercent: percent(shortMatchedCount, shortExpectedCount),
      completeContextCount: shortCompleteContextCount,
      passed: datasets.every((item) => item.shortPage.passed)
    },
    scaleBenchmark,
    passed:
      datasets.every((item) => item.passed) &&
      scaleBenchmark.p95Milliseconds < scaleBenchmark.thresholdMilliseconds
  };
}

function createSnapshot(report) {
  return {
    schemaVersion: "readaside/context-evaluation-snapshot/v1",
    version: report.version,
    generatedAt: report.generatedAt,
    summary: {
      questionCount: report.questionCount,
      expectedCount: report.expectedCount,
      matchedCount: report.matchedCount,
      recallPercent: report.recallPercent,
      medianReductionPercent: report.medianReductionPercent,
      fallbackCount: report.fallbackCount,
      shortPage: report.shortPage,
      passed: report.passed
    },
    scaleBenchmark: {
      blockCount: report.scaleBenchmark.blockCount,
      runs: report.scaleBenchmark.runs,
      observedP95Milliseconds: roundMilliseconds(report.scaleBenchmark.p95Milliseconds),
      thresholdMilliseconds: report.scaleBenchmark.thresholdMilliseconds
    },
    datasets: report.datasets.map((dataset) => ({
      fixtureId: dataset.fixtureId,
      dataset: dataset.dataset,
      fixture: dataset.fixture,
      shortPage: dataset.shortPage,
      pageChars: dataset.pageChars,
      blockCount: dataset.blockCount,
      sourceLayerCount: dataset.sourceLayerCount,
      questionCount: dataset.questionCount,
      expectedCount: dataset.expectedCount,
      matchedCount: dataset.matchedCount,
      recallPercent: dataset.recallPercent,
      medianReductionPercent: dataset.medianReductionPercent,
      fallbackCount: dataset.fallbackCount,
      passed: dataset.passed,
      cases: dataset.cases.map((item) => ({
        id: item.id,
        question: item.question,
        recallPercent: item.recallPercent,
        reductionPercent: item.reductionPercent,
        effectiveMode: item.effectiveMode,
        selectedBlockIds: item.selectedBlockIds,
        expectedBlockIds: item.expectedBlockIds
      }))
    }))
  };
}

function renderComparison(baseline, current, baselineLabel) {
  assert(
    baseline?.schemaVersion === "readaside/context-evaluation-snapshot/v1",
    `${baselineLabel} 的评测快照格式不受支持`
  );
  const baselineCases = snapshotCases(baseline);
  const currentCases = snapshotCases(current);
  const changed = [];
  const added = [];
  const removed = [];

  for (const [key, item] of currentCases) {
    const previous = baselineCases.get(key);
    if (!previous) {
      added.push(key);
      continue;
    }
    if (
      previous.recallPercent !== item.recallPercent ||
      previous.reductionPercent !== item.reductionPercent ||
      previous.effectiveMode !== item.effectiveMode ||
      !sameStringArray(previous.selectedBlockIds, item.selectedBlockIds)
    ) {
      changed.push({ key, previous, current: item });
    }
  }
  for (const key of baselineCases.keys()) {
    if (!currentCases.has(key)) removed.push(key);
  }

  const lines = [
    `与 ${baseline.version || "未知版本"} 基线对比（${baselineLabel}）`,
    `证据召回：${formatPercent(baseline.summary.recallPercent)} → ${formatPercent(current.summary.recallPercent)}（${formatPointDelta(current.summary.recallPercent - baseline.summary.recallPercent)}）`,
    `缩减中位数：${formatPercent(baseline.summary.medianReductionPercent)} → ${formatPercent(current.summary.medianReductionPercent)}（${formatPointDelta(current.summary.medianReductionPercent - baseline.summary.medianReductionPercent)}）`,
    `自动全文回退：${baseline.summary.fallbackCount}/${baseline.summary.questionCount} → ${current.summary.fallbackCount}/${current.summary.questionCount}`,
    `逐题采用结果变化：${changed.length}/${currentCases.size}`
  ];

  for (const item of changed) {
    lines.push(
      `- ${item.key}：Recall ${formatPercent(item.previous.recallPercent)} → ${formatPercent(item.current.recallPercent)}；缩减 ${formatPercent(item.previous.reductionPercent)} → ${formatPercent(item.current.reductionPercent)}；采用块 ${item.previous.selectedBlockIds.join(",") || "无"} → ${item.current.selectedBlockIds.join(",") || "无"}`
    );
  }
  if (added.length) lines.push(`新增问题：${added.join("、")}`);
  if (removed.length) lines.push(`移除问题：${removed.join("、")}`);
  if (!changed.length && !added.length && !removed.length) {
    lines.push("逐题证据召回、缩减、模式和采用块集合均未变化。");
  }
  return lines.join("\n");
}

function snapshotCases(snapshot) {
  const cases = new Map();
  for (const dataset of Array.isArray(snapshot?.datasets) ? snapshot.datasets : []) {
    for (const item of Array.isArray(dataset.cases) ? dataset.cases : []) {
      cases.set(`${dataset.fixtureId}/${item.id}`, item);
    }
  }
  return cases;
}

function resolveComparisonPath(value) {
  const path = String(value || "").trim();
  assert(path, "--compare 必须提供基线快照路径");
  return resolve(projectRoot, path);
}

function sameStringArray(left, right) {
  const leftValues = Array.isArray(left) ? left : [];
  const rightValues = Array.isArray(right) ? right : [];
  return leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index]);
}

function formatPointDelta(value) {
  const rounded = Math.round(Number(value) * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded} 个百分点`;
}

function roundMilliseconds(value) {
  return Math.round(Number(value) * 1_000) / 1_000;
}

function evaluateScaleBenchmark() {
  const blocks = Array.from({ length: scaleBlockCount }, (_, index) => ({
    id: `B${String(index + 1).padStart(4, "0")}`,
    order: index,
    kind: index % 20 === 0 ? "heading" : "paragraph",
    text: index % 20 === 0
      ? `组件组 ${Math.floor(index / 20) + 1}`
      : `组件 ${index + 1} 的运行记录包含容量、延迟、错误率和恢复说明。`,
    headingPath: [`组件组 ${Math.floor(index / 20) + 1}`],
    source: {
      frameId: 0,
      frameLabel: "2,000 块压力夹具",
      frameTitle: "2,000 块压力夹具",
      frameUrl: "https://fixtures.readaside.test/scale",
      isMainFrame: true,
      rootKind: "document",
      shadowDepth: 0
    },
    locator: {
      structurePath: "",
      shadowPath: [],
      textQuote: { exact: "", prefix: "", suffix: "" }
    }
  }));
  blocks[1_498].text = "组件 1499 的熔断阈值是连续五分钟错误率高于 1.2%。";
  const page = {
    title: "2,000 块压力夹具",
    url: "https://fixtures.readaside.test/scale",
    text: blocks.map((block) => block.text).join("\n\n"),
    blocks
  };
  const samples = [];

  for (let run = 0; run < timingRuns; run += 1) {
    const startedAt = performance.now();
    buildContextPlan({ page, question: "组件 1499 的熔断阈值是多少？", mode: "auto" });
    samples.push(performance.now() - startedAt);
  }

  return {
    blockCount: scaleBlockCount,
    runs: timingRuns,
    p95Milliseconds: percentile(samples, 95),
    thresholdMilliseconds: scaleP95ThresholdMilliseconds
  };
}

function renderConsole(report) {
  const lines = [
    `ReadAside ${report.version} 上下文离线评测`,
    `数据集：${report.datasets.length} · 每组问题：${report.questionCount}`,
    `短页完整性：${report.shortPage.completeContextCount}/${report.shortPage.questionCount} 发送全部结构化内容块 · 证据 ${report.shortPage.matchedCount}/${report.shortPage.expectedCount}`,
    `长页检索证据召回：${formatPercent(report.recallPercent)} (${report.matchedCount}/${report.expectedCount})`,
    `长页上下文缩减中位数：${formatPercent(report.medianReductionPercent)}`,
    `长页自动回退全文：${report.fallbackCount}/${report.questionCount}`,
    `本地检索与组装 p95：${report.p95Milliseconds.toFixed(3)} ms`,
    `${formatNumber(report.scaleBenchmark.blockCount)} 块压力测试 p95：${report.scaleBenchmark.p95Milliseconds.toFixed(3)} ms`,
    `目标状态：${report.passed ? "达到当前门槛" : "尚未达到当前门槛"}`
  ];

  for (const dataset of report.datasets) {
    lines.push(
      "",
      `${dataset.fixtureId} · 短页 ${dataset.shortPage.pageChars} 字符 / 长页 ${dataset.pageChars} 字符 · ${dataset.blockCount} 块 · ${dataset.sourceLayerCount} 个来源层`,
      `短页：${dataset.shortPage.completeContextCount}/${dataset.questionCount} 发送全部结构化内容块 · 证据召回 ${formatPercent(dataset.shortPage.recallPercent)}`,
      "ID    Recall  Reduce  Mode       Selected / Expected"
    );
    for (const item of dataset.cases) {
      lines.push([
        item.id.padEnd(5),
        formatPercent(item.recallPercent).padEnd(7),
        formatPercent(item.reductionPercent).padEnd(7),
        item.effectiveMode.padEnd(10),
        `${item.selectedBlockIds.join(",")} / ${item.expectedBlockIds.join(",")}`
      ].join(" "));
    }
  }
  return lines.join("\n");
}

function renderMarkdown(report) {
  const lines = [
    `# ReadAside ${report.version} 上下文评测结果`,
    "",
    `- 日期：${report.generatedAt}`,
    `- 数据集：${report.datasets.length}`,
    `- 每组问题：${report.questionCount}`,
    `- 短页完整性：${report.shortPage.completeContextCount}/${report.shortPage.questionCount} 发送全部结构化内容块，证据召回 ${formatPercent(report.shortPage.recallPercent)}（${report.shortPage.matchedCount}/${report.shortPage.expectedCount}）`,
    `- 长页检索证据召回：${formatPercent(report.recallPercent)}（${report.matchedCount}/${report.expectedCount}）`,
    `- 长页上下文缩减中位数：${formatPercent(report.medianReductionPercent)}`,
    `- 长页自动回退全文：${report.fallbackCount}/${report.questionCount}`,
    `- 本地检索与组装 p95：${report.p95Milliseconds.toFixed(3)} ms`,
    `- ${formatNumber(report.scaleBenchmark.blockCount)} 块压力测试 p95：${report.scaleBenchmark.p95Milliseconds.toFixed(3)} ms（目标 < ${report.scaleBenchmark.thresholdMilliseconds} ms）`,
    `- 目标状态：${report.passed ? "达到当前门槛" : "尚未达到当前门槛"}`,
    ""
  ];

  for (const dataset of report.datasets) {
    lines.push(
      `## ${dataset.fixtureId}`,
      "",
      `夹具：\`${dataset.fixture}\`；原始短页 ${dataset.shortPage.pageChars} 字符，确定性扩展长页 ${dataset.pageChars} 字符，${dataset.blockCount} 个原始内容块，${dataset.sourceLayerCount} 个来源层。`,
      "",
      `短页完整性：${dataset.shortPage.completeContextCount}/${dataset.questionCount} 发送全部结构化内容块，证据召回 ${formatPercent(dataset.shortPage.recallPercent)}。`,
      "",
      "| ID | 问题 | Recall | 缩减 | 模式 | 采用块 | 证据块 |",
      "| --- | --- | ---: | ---: | --- | --- | --- |"
    );
    for (const item of dataset.cases) {
      lines.push(
        `| ${item.id} | ${escapeTableText(item.question)} | ${formatPercent(item.recallPercent)} | ${formatPercent(item.reductionPercent)} | ${item.effectiveMode} | ${item.selectedBlockIds.join(", ")} | ${item.expectedBlockIds.join(", ")} |`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function percentile(values, target) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((target / 100) * sorted.length) - 1);
  return sorted[index];
}

function percent(numerator, denominator) {
  if (!denominator) return 100;
  return Math.round((numerator / denominator) * 1_000) / 10;
}

function formatPercent(value) {
  return `${Number(value).toFixed(Number.isInteger(value) ? 0 : 1)}%`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function escapeTableText(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function sourceLayerKey(block) {
  const source = block?.source || {};
  return [
    Number(source.frameId || 0),
    String(source.rootKind || "document"),
    Number(source.shadowDepth || 0)
  ].join(":");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
