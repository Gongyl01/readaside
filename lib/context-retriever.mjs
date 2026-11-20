import { formatTableAsMarkdown, normalizeTableData } from "./page-document.mjs";

export const AUTO_CONTEXT_CHAR_BUDGET = 16_000;
export const AUTO_CONTEXT_BLOCK_LIMIT = 10;
export const SMALL_PAGE_FULL_TEXT_THRESHOLD = AUTO_CONTEXT_CHAR_BUDGET;

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

  const positioned = !selectionText && page?.documentType === "paper"
    ? selectPaperParagraphs(blocks, normalizedQuestion, blockLimit)
    : [];
  if (!positioned.length && pageChars <= smallPageThreshold) {
    return structuredFullContextPlan({
      requestedMode,
      reason: `页面只有 ${formatNumber(pageChars)} 字符，自动发送全部结构化内容块，内容不做检索缩减。`,
      pageText,
      blocks
    });
  }

  const broadQuestion = !positioned.length && isBroadQuestion(normalizedQuestion);
  const candidates = blocks.filter((block) =>
    !["title", "authors"].includes(block.paper?.role) || matchesSelection(normalizeText(block.text), selectionText)
  );
  const relatedSections = positioned.length || selectionText || broadQuestion
    ? []
    : selectRelatedSections(candidates, normalizedQuestion, query);
  if (broadQuestion && pageChars <= charBudget) {
    return structuredFullContextPlan({
      requestedMode,
      reason: "这是面向整页的总结或概览问题，页面在预算内，自动发送全部结构化内容块。",
      pageText,
      blocks
    });
  }

  const paperTitles = new Set(blocks.filter((block) => block.paper?.role === "title")
    .map((block) => normalizeText(block.text.slice(0, 300))));
  const scored = positioned.length ? [] : scoreBlocks(candidates, query, selectionText, paperTitles);
  const selected = positioned.length ? positioned : relatedSections.length
    ? relatedSections
    : broadQuestion
      ? selectOverviewBlocks(candidates, blockLimit)
      : selectContextBlocks(scored, candidates, blockLimit);
  const fitted = fitSelectedBlocks(selected, charBudget);

  if (!fitted.length || (positioned.length && !fitted.some((entry) => entry.essential))) {
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
  const retrievalReason = positioned.length
    ? "已按问题中的段落位置选取论文原文。"
    : "已根据问题选择相关标题、正文和必要的邻近内容块。";

  return {
    requestedMode,
    effectiveMode: "retrieved",
    reason: relatedSections.length
      ? "问题涉及多个同类章节，已优先选取各章节的标题、正文和可用的适用场景说明。"
      : broadQuestion
        ? "这是面向整页的概览问题，已按章节抽取标题和代表性内容块。"
        : selectionText
          ? "已固定当前选区，并补充与问题相关的标题和邻近内容块。"
          : retrievalReason,
    pageChars,
    sentChars,
    reductionPercent: calculateReduction(pageChars, sentChars),
    totalBlockCount: blocks.length,
    selectedBlockCount: ordered.length,
    selectedBlocks: ordered.map(toPublicSelectedBlock),
    contextText,
    trace: {
      queryTokens: tokenize(query),
      candidateCount: positioned.length || scored.filter((entry) => entry.score > 0).length,
      selectedBlockIds: ordered.map((entry) => entry.block.id),
      charBudget,
      blockLimit: relatedSections.length ? relatedSections.length : blockLimit
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

function structuredFullContextPlan({ requestedMode, reason, pageText, blocks }) {
  const selectedBlocks = blocks.map((block) => ({
    ...block,
    score: 0,
    reasons: ["全部结构化内容"],
    matchedTokens: [],
    truncated: false
  }));
  const contextText = blocks.map((block) => formatBlockSection({ block })).join("\n\n");
  return {
    requestedMode,
    effectiveMode: "structured",
    reason,
    pageChars: pageText.length,
    sentChars: contextText.length,
    reductionPercent: 0,
    totalBlockCount: blocks.length,
    selectedBlockCount: blocks.length,
    selectedBlocks,
    contextText,
    trace: {
      queryTokens: [],
      candidateCount: blocks.length,
      selectedBlockIds: blocks.map((block) => block.id),
      charBudget: contextText.length,
      blockLimit: blocks.length
    }
  };
}

function selectPaperParagraphs(blocks, question, blockLimit) {
  const references = question.matchAll(/(开头|开篇|引言|绪论|introduction|摘要|abstract)\s*(?:部分\s*)?的?\s*第\s*([一二两三四五六七八九]?十[一二三四五六七八九]?|[一二两三四五六七八九]|\d+)\s*(?:个?自然)?段/g);
  const targets = new Map();
  const nearby = new Map();
  for (const [, label, ordinal] of references) {
    const role = label === "摘要" || label === "abstract" ? "abstract" : "introduction";
    const name = role === "abstract" ? "Abstract" : "Introduction";
    const paragraph = parseParagraphNumber(ordinal);
    const section = blocks.filter((block) => block.paper?.role === role && !block.source.frameId);
    const matches = section.filter((block) => block.paper.paragraph === paragraph);
    if (!matches.length) continue;

    for (const block of matches) {
      targets.set(block.id, { block, reason: `按位置命中 · ${name} 第 ${paragraph} 段` });
    }
    for (const block of section) {
      if (block.kind === "heading") {
        nearby.set(block.id, { block, reason: "目标段落所属章节" });
      } else if (Math.abs(block.paper.paragraph - paragraph) === 1) {
        nearby.set(block.id, { block, reason: "目标段落的同节邻段" });
      }
    }
  }

  return [...targets.values(), ...[...nearby.values()].filter(({ block }) => !targets.has(block.id))]
    .slice(0, blockLimit)
    .map(({ block, reason }) => ({
      block,
      score: 0,
      reasons: [reason],
      matchedTokens: [],
      essential: targets.has(block.id)
    }));
}

function parseParagraphNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = "〇一二三四五六七八九";
  const [tens, ones] = value.replaceAll("两", "二").split("十");
  if (ones === undefined) return digits.indexOf(tens);
  return (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0);
}

function scoreBlocks(blocks, query, selectionText, paperTitles) {
  const queryTokens = tokenize(query);
  const queryClauses = splitRetrievalClauses(query).map((clause) => ({
    text: clause,
    tokens: tokenize(clause)
  })).filter((clause) => clause.tokens.length);
  const blockFeatures = blocks.map((block) => {
    const text = normalizeText(block.text);
    const hasPaperTitle = paperTitles.size && paperTitles.has(normalizeText(block.headingPath[0]));
    const headingText = hasPaperTitle
      ? normalizeText(block.headingPath.length > 1 ? block.headingPath.at(-1) : "")
      : normalizeText(block.headingPath.join(" "));
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
  const clauseCount = Math.max(0, ...scored.map((entry) => entry.clauseScores.length));
  const seedLimit = Math.min(Math.max(2, clauseCount), blockLimit, 4);
  const globallyRanked = scored
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.priority - left.priority || left.block.order - right.block.order);
  const ranked = [];
  const rankedIds = new Set();

  const pinned = globallyRanked.find((entry) => entry.priority >= 1_000);
  addRankedSeed(ranked, rankedIds, pinned, seedLimit);

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
    return [];
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

function selectRelatedSections(blocks, question, query) {
  if (!/(?:总结|概括|概述|梳理|介绍|[一二三四五六七八九十两\d]+种|哪几种|多少种|每种|各(?:种|类)|(?:所有|全部).{0,6}(?:种|类|架构|类型)|\b(?:summarize|summary|overview|types|kinds|patterns)\b)/i.test(question)) {
    return [];
  }

  const headings = blocks.filter((block) => block.kind === "heading");
  const tokens = tokenize(query).filter((token) =>
    /^[a-z][a-z0-9_./-]{3,}$/.test(token) || /^[\u3400-\u9fff]{2,}$/.test(token)
  );
  const groups = tokens.map((token) => ({
    token,
    matches: headings.filter((block) => tokenize(block.text).includes(token))
  })).filter((group) => group.matches.length >= 2 && group.matches.length <= 12);
  groups.sort((left, right) => right.matches.length - left.matches.length);
  const matchingHeadings = groups[0]?.matches || [];
  if (!matchingHeadings.length) return [];

  const specificTokens = tokenize(question).filter((token) =>
    /^[a-z][a-z0-9_./-]{3,}$/.test(token) || /^[\u3400-\u9fff]{2,}$/.test(token)
  );
  const uniquelyNamed = matchingHeadings.filter((heading) => specificTokens.some((token) =>
    tokenize(heading.text).includes(token) &&
    headings.filter((candidate) => tokenize(candidate.text).includes(token)).length === 1
  ));
  if (uniquelyNamed.length) return [];

  const sections = matchingHeadings.map((heading) => {
    const start = blocks.findIndex((block) => block.id === heading.id);
    const depth = heading.headingPath.length || 1;
    let end = start + 1;
    while (end < blocks.length && sameDocumentLayer(heading, blocks[end])) {
      const next = blocks[end];
      if (next.kind === "heading" && (next.headingPath.length || 1) <= depth) break;
      end += 1;
    }
    return blocks.slice(start, end);
  });

  const selected = new Map();
  const add = (block, reason, essential = false) => {
    if (!block || selected.has(block.id)) return;
    selected.set(block.id, {
      block,
      score: 0,
      priority: 100,
      matchedTokens: [],
      reasons: [reason],
      essential
    });
  };

  for (const section of sections) add(section[0], "相关章节标题", true);
  for (const section of sections) add(section.find((block) => block.kind !== "heading"), "章节定义", true);
  for (const section of sections) {
    add(section.find((block) => /when to use|适用场景|何时使用|使用场景/i.test(block.text)), "章节适用场景", true);
  }
  for (let offset = 1; offset < Math.max(...sections.map((section) => section.length)); offset += 1) {
    for (const section of sections) add(section[offset], "章节相关正文");
  }
  return [...selected.values()];
}

function fitSelectedBlocks(selected, charBudget) {
  const fitted = [];
  let remaining = charBudget;

  for (let index = 0; index < selected.length; index += 1) {
    const entry = selected[index];
    const header = formatBlockHeader(entry.block);
    const overhead = header.length + 2;
    if (remaining <= overhead) continue;
    const reserved = selected.slice(index + 1).filter((candidate) => candidate.essential)
      .reduce((total, candidate) => total + formatBlockHeader(candidate.block).length + 202, 0);
    const availableText = Math.max(0, remaining - overhead - reserved);
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
  if (/(?:全文|整篇|整页|全篇|整个网页|整篇文章|这篇.{0,6}(?:讲|说|内容)|本文.{0,6}(?:讲|说|内容)|(?:这|该|本)(?:篇)?(?:文章|网页|页面)(?:的(?:主要内容|核心观点|内容))?[。！？.!?]*$|\b(?:whole|entire)\s+(?:page|article)\b)/i.test(question)) {
    return true;
  }
  return /^(?:(?:请|帮我|简单|简要|大致|概括|总结|梳理|概述|一下|主要内容|核心观点|内容|重点|摘要|summary|summarize|overview)[\s，。！？,.!?]*)+$/i.test(question);
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
      if (block?.paper) normalized.paper = block.paper;
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
