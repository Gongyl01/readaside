export const EVIDENCE_REPORT_PROTOCOL = "readaside/evidence-report/v1";
export const EVIDENCE_REPORT_TOOL_NAME = "report_page_evidence";

const BLOCK_ID_PATTERN = /^B\d{4,}$/;
const MAX_EVIDENCE_ITEMS = 3;
const MAX_QUOTE_CHARS = 320;

export function buildEvidenceReportTool() {
  return {
    name: EVIDENCE_REPORT_TOOL_NAME,
    description: [
      "在完成用户可见回答后，提交支撑回答的当前网页核心原文。",
      "只提交逐字复制的最短完整证据，不要概括或改写；普通正文优先一条句子，必要时最多两条相邻句子。",
      "列表只提交相关列表项，表格只提交相关单元格或一行。",
      "最多三条；网页没有直接证据时提交空数组。",
      "不要在用户可见回答中输出内容块编号。"
    ].join(" "),
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        evidence: {
          type: "array",
          maxItems: MAX_EVIDENCE_ITEMS,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              blockId: {
                type: "string",
                description: "证据所属的允许网页内容块编号，例如 B0007。"
              },
              exactQuote: {
                type: "string",
                description: "从该内容块逐字复制的核心原文，不能改写。"
              },
              supports: {
                type: "string",
                description: "这条原文所支撑的回答要点；仅供系统内部使用。"
              }
            },
            required: ["blockId", "exactQuote", "supports"]
          }
        }
      },
      required: ["evidence"]
    }
  };
}

export function snapshotEvidenceTargets(blocks) {
  const targets = [];
  const seen = new Set();

  for (const block of Array.isArray(blocks) ? blocks : []) {
    const blockId = normalizeBlockId(block?.id || block?.blockId);
    if (!blockId || seen.has(blockId)) continue;
    seen.add(blockId);

    const text = normalizeText(block?.text).slice(0, 4_000);
    if (!text) continue;
    const source = block?.source && typeof block.source === "object" ? block.source : {};
    const locator = normalizeLocator(block?.locator, text);
    targets.push({
      blockId,
      kind: normalizeKind(block?.kind),
      text,
      source: {
        frameId: toNonNegativeInteger(source.frameId),
        frameUrl: String(source.frameUrl || "").slice(0, 2_000),
        rootKind: source.rootKind === "shadow" ? "shadow" : "document",
        shadowDepth: toNonNegativeInteger(source.shadowDepth)
      },
      locator
    });
  }

  return targets;
}

export function normalizeEvidenceReport(value) {
  const evidence = Array.isArray(value?.evidence) ? value.evidence : [];
  return {
    evidence: evidence.slice(0, MAX_EVIDENCE_ITEMS).map((item) => ({
      blockId: normalizeBlockId(item?.blockId),
      exactQuote: normalizeText(item?.exactQuote).slice(0, MAX_QUOTE_CHARS),
      supports: oneLine(item?.supports).slice(0, 240)
    }))
  };
}

export function stripInternalBlockMarkers(value) {
  return String(value ?? "")
    .replace(/[ \t]*\[(?:B\d{4,})(?:\]\[(?:B\d{4,}))*\]/g, "")
    .replace(/[ \t]*\[B\d{0,3}$/g, "")
    .trimEnd();
}

export function validateEvidenceReport(value, { targets = [] } = {}) {
  const report = normalizeEvidenceReport(value);
  const targetsById = new Map(snapshotEvidenceTargets(targets).map((target) => [
    target.blockId,
    target
  ]));
  const valid = [];
  const rejected = [];
  const seen = new Set();

  for (const item of report.evidence) {
    const target = targetsById.get(item.blockId);
    if (!item.blockId || !target) {
      rejected.push({ ...item, reason: "内容块不属于本次发送范围。" });
      continue;
    }
    if (!item.exactQuote) {
      rejected.push({ ...item, reason: "证据原文为空。" });
      continue;
    }

    const occurrenceCount = countOccurrences(target.text, item.exactQuote);
    if (!occurrenceCount) {
      rejected.push({ ...item, reason: "证据不是该内容块中的逐字原文。" });
      continue;
    }
    if (occurrenceCount > 1) {
      rejected.push({ ...item, reason: "该原文在内容块中重复出现，无法唯一定位。" });
      continue;
    }

    const key = `${item.blockId}\u0000${item.exactQuote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push({
      ...item,
      occurrenceCount: 1,
      target
    });
  }

  return { valid, rejected };
}

function normalizeLocator(value, fallbackText) {
  const locator = value && typeof value === "object" ? value : {};
  const quote = locator.textQuote && typeof locator.textQuote === "object"
    ? locator.textQuote
    : {};
  return {
    structurePath: String(locator.structurePath || "").slice(0, 2_000),
    shadowPath: (Array.isArray(locator.shadowPath) ? locator.shadowPath : [])
      .map((part) => String(part).slice(0, 1_000))
      .filter(Boolean)
      .slice(0, 16),
    textQuote: {
      exact: normalizeText(quote.exact || fallbackText).slice(0, MAX_QUOTE_CHARS),
      prefix: normalizeText(quote.prefix).slice(-80),
      suffix: normalizeText(quote.suffix).slice(0, 80)
    }
  };
}

function countOccurrences(text, quote) {
  let count = 0;
  let offset = 0;
  while (offset <= text.length - quote.length) {
    const index = text.indexOf(quote, offset);
    if (index < 0) break;
    count += 1;
    offset = index + Math.max(1, quote.length);
  }
  return count;
}

function normalizeBlockId(value) {
  const id = oneLine(value);
  return BLOCK_ID_PATTERN.test(id) ? id : "";
}

function normalizeKind(value) {
  const kind = String(value || "other");
  return ["heading", "paragraph", "list", "table", "code", "quote", "input", "other"]
    .includes(kind) ? kind : "other";
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function oneLine(value) {
  return normalizeText(value).replace(/\s+/g, " ").trim();
}

function toNonNegativeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}
