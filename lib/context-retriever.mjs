import { formatTableAsMarkdown, normalizeTableData } from "./page-document.mjs";

export const AUTO_CONTEXT_CHAR_BUDGET = 16_000;
export const AUTO_CONTEXT_BLOCK_LIMIT = 10;
export const SMALL_PAGE_FULL_TEXT_THRESHOLD = 2_000;

const LATIN_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with"
]);

const BLOCK_KIND_LABELS = {
  heading: "标题",
  paragraph: "正文",
  list: "列表",
  table: "表格",
  code: "代码",
  quote: "引用",
  input: "输入",
  other: "其他"
};

export function buildContextPlan({
  page,
  selection = null,
  history = [],
  question,
  mode = "auto"
}, options = {}) {
  const pageText = String(page?.text ?? "").trim();
  const normalizedQuestion = normalizeText(question);
  const query = buildRetrievalQuery(normalizedQuestion, history);
  if (!pageText) throw new Error("当前网页没有可读取的正文。");
  if (!normalizedQuestion) throw new Error("问题不能为空。");

  const requestedMode = mode === "full" ? "full" : "auto";
  const blocks = normalizeBlocks(page?.blocks);
  const pageChars = pageText.length;
  const smallPageThreshold = positiveInteger(
    options.smallPageThreshold,
    SMALL_PAGE_FULL_TEXT_THRESHOLD
  );
  const charBudget = positiveInteger(options.charBudget, AUTO_CONTEXT_CHAR_BUDGET);
  const blockLimit = positiveInteger(options.blockLimit, AUTO_CONTEXT_BLOCK_LIMIT);
  const selectionText = normalizeText(selection?.text);

  if (requestedMode === "full") {
    return fullContextPlan({
      requestedMode,
      reason: "已选择结合全文，本次发送完整页面文本。",
      pageText,
      blocks
    });
  }

  if (!blocks.length) {
    return fullContextPlan({
      requestedMode,
      reason: "当前页面没有可用的结构化内容块，已自动回退到完整文本。",
      pageText,
      blocks
    });
  }

  if (pageChars <= smallPageThreshold && !selectionText) {
    return fullContextPlan({
      requestedMode,
      reason: `页面只有 ${formatNumber(pageChars)} 字符，自动保留全文，避免过度裁剪。`,
      pageText,
      blocks
    });
  }

  const broadQuestion = isBroadQuestion(normalizedQuestion);
  if (broadQuestion && pageChars <= charBudget) {
    return fullContextPlan({
      requestedMode,
      reason: "这是面向整页的总结或概览问题，页面在预算内，自动保留全文。",
      pageText,
      blocks
    });
  }

  const scored = scoreBlocks(blocks, query, selectionText);
  const selected = broadQuestion
    ? selectOverviewBlocks(blocks, blockLimit)
    : selectContextBlocks(scored, blocks, blockLimit);
  const fitted = fitSelectedBlocks(selected, charBudget);

  if (!fitted.length) {
    return fullContextPlan({
      requestedMode,
      reason: "没有找到可安全发送的相关内容块，已自动回退到完整文本。",
      pageText,
      blocks
    });
  }

  const ordered = [...fitted].sort((left, right) => left.block.order - right.block.order);
  const contextText = ordered.map((entry) => formatBlockSection(entry)).join("\n\n");
  const sentChars = contextText.length;

  return {
    requestedMode,
    effectiveMode: "retrieved",
    reason: broadQuestion
      ? "这是面向整页的概览问题，已按章节抽取标题和代表性内容块。"
      : selectionText
        ? "已固定当前选区，并补充与问题相关的标题和邻近内容块。"
        : "已根据问题选择相关标题、正文和必要的邻近内容块。",
    pageChars,
    sentChars,
    reductionPercent: calculateReduction(pageChars, sentChars),
    totalBlockCount: blocks.length,
    selectedBlockCount: ordered.length,
    selectedBlocks: ordered.map(toPublicSelectedBlock),
    contextText,
    trace: {
      queryTokens: tokenize(query),
      candidateCount: scored.filter((entry) => entry.score > 0).length,
      selectedBlockIds: ordered.map((entry) => entry.block.id),
      charBudget,
      blockLimit
    }
  };
}

export function blockKindLabel(kind) {
  return BLOCK_KIND_LABELS[String(kind || "other")] || BLOCK_KIND_LABELS.other;
}

function fullContextPlan({ requestedMode, reason, pageText, blocks }) {
  return {
    requestedMode,
    effectiveMode: "full",
    reason,
    pageChars: pageText.length,
    sentChars: pageText.length,
    reductionPercent: 0,
    totalBlockCount: blocks.length,
    selectedBlockCount: blocks.length,
    selectedBlocks: blocks.map((block) => ({
      ...block,
      score: 0,
      reasons: ["完整页面"],
      matchedTokens: [],
      truncated: false
    })),
    contextText: pageText,
    trace: {
      queryTokens: [],
      candidateCount: blocks.length,
      selectedBlockIds: blocks.map((block) => block.id),
      charBudget: pageText.length,
      blockLimit: blocks.length
    }
  };
}

function scoreBlocks(blocks, query, selectionText) {
  const queryTokens = tokenize(query);
  const queryClauses = splitRetrievalClauses(query).map((clause) => ({
    text: clause,
    tokens: tokenize(clause)
  })).filter((clause) => clause.tokens.length);
  const blockFeatures = blocks.map((block) => {
    const text = normalizeText(block.text);
    const headingText = normalizeText(block.headingPath.join(" "));
    return {
      block,
      normalizedText: text,
      textTokens: new Set(tokenize(text)),
      headingTokens: new Set(tokenize(headingText))
    };
  });
  const documentFrequency = new Map();

  for (const token of queryTokens) {
    const count = blockFeatures.filter((entry) => (
      entry.textTokens.has(token) || entry.headingTokens.has(token)
    )).length;
    documentFrequency.set(token, count);
  }

  return blockFeatures.map((entry) => {
    let score = 0;
    const matchedTokens = [];
    const reasons = [];

    for (const token of queryTokens) {
      const inText = entry.textTokens.has(token);
      const inHeading = entry.headingTokens.has(token);
      if (!inText && !inHeading) continue;
      const frequency = documentFrequency.get(token) || 0;
      const inverseFrequency = Math.log(1 + (blocks.length + 0.5) / (frequency + 0.5));
      score += inverseFrequency * (inHeading ? 1.8 : 1);
      matchedTokens.push(token);
    }

    if (query.length >= 3 && entry.normalizedText.includes(query)) score += 8;
    if (entry.block.kind === "heading" && matchedTokens.length) score += 0.5;

    const selectionMatched = matchesSelection(entry.normalizedText, selectionText);
    if (selectionMatched) {
      score += 100;
      reasons.push("包含当前选区");
    }
    if (matchedTokens.length) {
      reasons.push(`命中问题：${matchedTokens.slice(0, 4).join("、")}`);
    }

    const clauseScores = queryClauses.map((clause) => {
      let clauseScore = 0;
      for (const token of clause.tokens) {
        const inText = entry.textTokens.has(token);
        const inHeading = entry.headingTokens.has(token);
        if (!inText && !inHeading) continue;
        const frequency = documentFrequency.get(token) || 0;
        const inverseFrequency = Math.log(1 + (blocks.length + 0.5) / (frequency + 0.5));
        clauseScore += inverseFrequency * (inHeading ? 1.8 : 1);
      }
      if (clause.text.length >= 3 && entry.normalizedText.includes(clause.text)) {
        clauseScore += 8;
      }
      if (entry.block.kind === "heading" && clauseScore > 0) clauseScore += 0.5;
      return clauseScore;
    });

    return {
      block: entry.block,
      score,
      priority: selectionMatched ? 1_000 + score : 100 + score,
      matchedTokens,
      clauseScores,
      reasons
    };
  });
}

function selectContextBlocks(scored, blocks, blockLimit) {
  const selected = new Map();
  const seedLimit = Math.min(2, blockLimit);
  const globallyRanked = scored
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.priority - left.priority || left.block.order - right.block.order);
  const ranked = [];
  const rankedIds = new Set();

  const pinned = globallyRanked.find((entry) => entry.priority >= 1_000);
  addRankedSeed(ranked, rankedIds, pinned, seedLimit);

  const clauseCount = Math.max(0, ...scored.map((entry) => entry.clauseScores.length));
  for (let clauseIndex = clauseCount - 1; clauseIndex >= 0; clauseIndex -= 1) {
    const clauseMatch = scored
      .filter((entry) => !rankedIds.has(entry.block.id) && entry.clauseScores[clauseIndex] > 0)
      .sort((left, right) => (
        right.clauseScores[clauseIndex] - left.clauseScores[clauseIndex] ||
        right.priority - left.priority ||
        left.block.order - right.block.order
      ))[0];
    addRankedSeed(ranked, rankedIds, clauseMatch, seedLimit);
  }

  for (const entry of globallyRanked) {
    addRankedSeed(ranked, rankedIds, entry, seedLimit);
  }

  if (!ranked.length) {
    const fallback = [
      blocks.find((block) => block.kind === "heading"),
      ...blocks.filter((block) => block.kind !== "heading").slice(0, 2)
    ].filter(Boolean);
    for (const block of fallback) {
      addSelected(selected, {
        block,
        score: 0,
        priority: 10,
        matchedTokens: [],
        reasons: ["无关键词命中，保留页面开头"]
      });
    }
    return [...selected.values()];
  }

  for (const entry of ranked) {
    addSelected(selected, entry);
    const index = blocks.findIndex((block) => block.id === entry.block.id);
    const precedingHeading = findPrecedingHeading(blocks, index);
    if (precedingHeading) {
      addSelected(selected, {
        block: precedingHeading,
        score: entry.score,
        priority: entry.priority - 1,
        matchedTokens: [],
        reasons: ["相关内容所属标题"]
      });
    }

    const neighbor = findContextNeighbor(blocks, index);
    if (neighbor) {
      addSelected(selected, {
        block: neighbor,
        score: entry.score,
        priority: entry.priority - 2,
        matchedTokens: [],
        reasons: ["相关段落的邻近上下文"]
      });
    }
  }

  return [...selected.values()]
    .sort((left, right) => right.priority - left.priority || left.block.order - right.block.order)
    .slice(0, blockLimit);
}

function addRankedSeed(ranked, rankedIds, entry, limit) {
  if (!entry || ranked.length >= limit || rankedIds.has(entry.block.id)) return;
  ranked.push(entry);
  rankedIds.add(entry.block.id);
}

function findContextNeighbor(blocks, index) {
  const target = blocks[index];
  const candidates = target.kind === "heading"
    ? [blocks[index + 1]]
    : [blocks[index + 1], blocks[index - 1]];

  return candidates.find((candidate) => (
    candidate &&
    candidate.kind !== "heading" &&
    sameDocumentLayer(target, candidate) &&
    sameHeadingPath(target, candidate)
  )) || null;
}

function sameHeadingPath(left, right) {
  return left.headingPath.length === right.headingPath.length &&
    left.headingPath.every((part, index) => part === right.headingPath[index]);
}

function selectOverviewBlocks(blocks, blockLimit) {
  const candidates = [];
  const seen = new Set();

  function add(block) {
    if (!block || seen.has(block.id)) return;
    seen.add(block.id);
    candidates.push(block);
  }

  add(blocks[0]);
  for (let index = 0; index < blocks.length; index += 1) {
    if (blocks[index].kind !== "heading") continue;
    add(blocks[index]);
    const nextContent = blocks.slice(index + 1).find((block) => (
      block.kind !== "heading" && sameDocumentLayer(blocks[index], block)
    ));
    add(nextContent);
  }
  add(blocks.at(-1));

  if (candidates.length < Math.min(blockLimit, 4)) {
    const desired = Math.min(blockLimit, blocks.length);
    for (let sample = 0; sample < desired; sample += 1) {
      const index = Math.round((sample * (blocks.length - 1)) / Math.max(1, desired - 1));
      add(blocks[index]);
    }
  }

  const sampled = candidates.length <= blockLimit
    ? candidates
    : Array.from({ length: blockLimit }, (_, sample) => {
        const index = Math.round((sample * (candidates.length - 1)) / Math.max(1, blockLimit - 1));
        return candidates[index];
      });

  return uniqueById(sampled).map((block) => ({
    block,
    score: 0,
    priority: 50,
    matchedTokens: [],
    reasons: ["整页概览的代表内容"]
  }));
}

function fitSelectedBlocks(selected, charBudget) {
  const fitted = [];
  let remaining = charBudget;

  for (const entry of selected) {
    const header = formatBlockHeader(entry.block);
    const overhead = header.length + 2;
    if (remaining <= overhead) continue;
    const availableText = remaining - overhead;
    const structuredText = formatBlockContextText(entry.block);
    const fitsStructuredTable = Boolean(entry.block.table) && structuredText.length <= availableText;
    const sourceText = structuredText.length <= availableText
      ? structuredText
      : entry.block.text;
    const text = sourceText.slice(0, availableText).trim();
    if (!text) continue;
    const sentEntry = {
      ...entry,
      sentText: text,
      sentTable: fitsStructuredTable ? entry.block.table : null,
      truncated: text.length < sourceText.length || (
        Boolean(entry.block.table) && !fitsStructuredTable
      )
    };
    fitted.push(sentEntry);
    remaining -= formatBlockSection(sentEntry).length + 2;
    if (remaining <= 0) break;
  }

  return fitted;
}

function addSelected(selected, candidate) {
  const existing = selected.get(candidate.block.id);
  if (!existing) {
    selected.set(candidate.block.id, { ...candidate, reasons: [...candidate.reasons] });
    return;
  }

  existing.score = Math.max(existing.score, candidate.score);
  existing.priority = Math.max(existing.priority, candidate.priority);
  existing.matchedTokens = unique([...existing.matchedTokens, ...candidate.matchedTokens]);
  existing.reasons = unique([...existing.reasons, ...candidate.reasons]);
}

function findPrecedingHeading(blocks, index) {
  const target = blocks[index];
  for (let current = index - 1; current >= 0; current -= 1) {
    const candidate = blocks[current];
    if (!sameDocumentLayer(target, candidate)) break;
    if (candidate.kind === "heading") return candidate;
  }
  return null;
}

function sameDocumentLayer(left, right) {
  return Number(left?.source?.frameId || 0) === Number(right?.source?.frameId || 0) &&
    String(left?.source?.rootKind || "document") === String(right?.source?.rootKind || "document") &&
    Number(left?.source?.shadowDepth || 0) === Number(right?.source?.shadowDepth || 0);
}

function matchesSelection(blockText, selectionText) {
  if (!selectionText || selectionText.length < 4) return false;
  if (blockText.includes(selectionText)) return true;
  return blockText.length >= 8 && selectionText.includes(blockText);
}

function isBroadQuestion(question) {
  return /(?:总结|概括|概述|梳理|全文|整篇|主要内容|核心观点|这篇.{0,6}(?:讲|说|内容)|summary|summarize|overview)/i.test(question);
}

function formatBlockSection(entry) {
  return `${formatBlockHeader(entry.block)}\n${entry.sentText ?? formatBlockContextText(entry.block)}`;
}

function formatBlockContextText(block) {
  if (block?.kind === "table" && block.table) {
    return formatTableAsMarkdown(block.table) || block.text;
  }
  return block.text;
}

function formatBlockHeader(block) {
  const parts = [`网页内容块 ${block.id}`, `类型：${blockKindLabel(block.kind)}`];
  if (block.headingPath.length) parts.push(`标题路径：${oneLine(block.headingPath.join(" > "))}`);
  parts.push(`来源：${sourceLabel(block)}`);
  return `[${parts.join("｜")}]`;
}

function sourceLabel(block) {
  const source = block.source || {};
  const frame = source.isMainFrame
    ? "主页面"
    : oneLine(source.frameLabel || source.frameTitle || `Frame ${source.frameId}`);
  return source.rootKind === "shadow" ? `${frame} / Shadow DOM` : frame;
}

function toPublicSelectedBlock(entry) {
  const block = {
    ...entry.block,
    text: entry.sentText ?? entry.block.text,
    score: Number(entry.score.toFixed(3)),
    reasons: entry.reasons,
    matchedTokens: entry.matchedTokens,
    truncated: Boolean(entry.truncated)
  };
  if (entry.sentTable) block.table = entry.sentTable;
  else if (entry.sentTable === null) delete block.table;
  return block;
}

function normalizeBlocks(value) {
  return (Array.isArray(value) ? value : [])
    .map((block, index) => {
      const kind = BLOCK_KIND_LABELS[block?.kind] ? block.kind : "other";
      const normalized = {
        id: oneLine(block?.id || `B${String(index + 1).padStart(4, "0")}`),
        order: Number.isFinite(Number(block?.order)) ? Number(block.order) : index,
        kind,
        text: String(block?.text ?? "").trim(),
        headingPath: (Array.isArray(block?.headingPath) ? block.headingPath : [])
          .map(oneLine)
          .filter(Boolean),
        source: block?.source && typeof block.source === "object" ? block.source : {},
        locator: block?.locator && typeof block.locator === "object" ? block.locator : {}
      };
      const table = kind === "table" ? normalizeTableData(block?.table) : null;
      if (table) normalized.table = table;
      return normalized;
    })
    .filter((block) => block.text)
    .sort((left, right) => left.order - right.order);
}

function tokenize(value) {
  const normalized = normalizeText(value);
  const tokens = [];
  const latinWords = normalized.match(/[a-z0-9][a-z0-9_./-]*/g) || [];
  for (const word of latinWords) {
    if (word.length >= 2 && !LATIN_STOP_WORDS.has(word)) tokens.push(word);
  }

  const cjkRuns = normalized.match(/[\u3400-\u9fff]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    if (run.length <= 8) tokens.push(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.push(run.slice(index, index + 2));
    }
  }

  return unique(tokens);
}

function buildRetrievalQuery(question, history) {
  const recentUserQuestions = (Array.isArray(history) ? history : [])
    .filter((message) => message?.role === "user")
    .slice(-2)
    .map((message) => normalizeText(message.content).slice(0, 1_000))
    .filter(Boolean);
  return [...recentUserQuestions, question].join("。 ").trim();
}

function splitRetrievalClauses(value) {
  return normalizeText(value)
    .split(/[，,。；;！？!?]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function oneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueById(blocks) {
  const seen = new Set();
  return blocks.filter((block) => {
    if (!block || seen.has(block.id)) return false;
    seen.add(block.id);
    return true;
  });
}

function calculateReduction(original, sent) {
  if (!original || sent >= original) return 0;
  return Math.round((1 - sent / original) * 100);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value);
}
