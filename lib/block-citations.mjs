import { blockKindLabel } from "./context-retriever.mjs";

export const BLOCK_CITATION_PROTOCOL = "readaside/block-citation/v1";

const BLOCK_ID_PATTERN = /^B\d{4,}$/;
const BLOCK_MARKER_PATTERN = /^\[(B\d{4,})\]/;
const MAX_EVIDENCE_TEXT_CHARS = 2_000;
const MAX_EVIDENCE_EXCERPT_CHARS = 260;

export function snapshotEvidenceBlocks(blocks) {
  const snapshots = [];
  const seen = new Set();

  for (const block of Array.isArray(blocks) ? blocks : []) {
    const id = normalizeBlockId(block?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const kind = String(block?.kind || "other");
    const text = String(block?.text ?? "").trim().slice(0, MAX_EVIDENCE_TEXT_CHARS);
    const headingPath = (Array.isArray(block?.headingPath) ? block.headingPath : [])
      .map((part) => oneLine(part))
      .filter(Boolean);
    const source = block?.source && typeof block.source === "object" ? block.source : {};

    snapshots.push({
      id,
      kind,
      kindLabel: blockKindLabel(kind),
      text,
      headingPath,
      headingLabel: headingPath.length ? headingPath.join(" › ") : "未归入标题",
      source: {
        frameId: toNonNegativeInteger(source.frameId),
        isMainFrame: Boolean(source.isMainFrame),
        frameTitle: oneLine(source.frameTitle),
        frameLabel: oneLine(source.frameLabel),
        rootKind: source.rootKind === "shadow" ? "shadow" : "document",
        shadowDepth: toNonNegativeInteger(source.shadowDepth)
      },
      sourceLabel: sourceLabel(source),
      truncated: Boolean(block?.truncated)
    });
  }

  return snapshots;
}

export function parseBlockCitationMarkers(markdown) {
  const source = String(markdown ?? "");
  const occurrences = [];
  let offset = 0;
  let fence = null;

  for (const line of source.split(/(?<=\n)/)) {
    const content = line.endsWith("\n") ? line.slice(0, -1) : line;
    const fenceMatch = content.match(/^[ \t]{0,3}(`{3,}|~{3,})/);

    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = { character: marker[0], length: marker.length };
      } else if (marker[0] === fence.character && marker.length >= fence.length) {
        fence = null;
      }
      offset += line.length;
      continue;
    }

    if (!fence) parseInlineMarkers(content, offset, occurrences);
    offset += line.length;
  }

  return occurrences;
}

export function validateBlockCitations(markdown, { sentBlocks = [], pageBlocks = [] } = {}) {
  const sentById = indexEvidenceBlocks(sentBlocks);
  const pageById = indexEvidenceBlocks(pageBlocks);
  const occurrences = parseBlockCitationMarkers(markdown).map((occurrence) => {
    const block = sentById.get(occurrence.id);
    if (block) return { ...occurrence, status: "valid", block };

    if (pageById.has(occurrence.id)) {
      return {
        ...occurrence,
        status: "not-sent",
        reason: "该内容块存在于页面，但没有包含在本次发送给模型的上下文中。"
      };
    }

    return {
      ...occurrence,
      status: "unknown",
      reason: "本次页面快照中不存在该内容块。"
    };
  });

  const references = [];
  const referencesById = new Map();
  for (const occurrence of occurrences) {
    let reference = referencesById.get(occurrence.id);
    if (!reference) {
      reference = {
        id: occurrence.id,
        marker: occurrence.marker,
        status: occurrence.status,
        reason: occurrence.reason || "",
        block: occurrence.block || null,
        occurrenceCount: 0
      };
      referencesById.set(occurrence.id, reference);
      references.push(reference);
    }
    reference.occurrenceCount += 1;
  }

  return {
    occurrences,
    references,
    validReferences: references.filter((reference) => reference.status === "valid"),
    invalidReferences: references.filter((reference) => reference.status !== "valid")
  };
}

export function buildEvidenceCardModel(validation) {
  const value = validation && typeof validation === "object" ? validation : {};
  const validReferences = Array.isArray(value.validReferences) ? value.validReferences : [];
  const invalidReferences = Array.isArray(value.invalidReferences) ? value.invalidReferences : [];

  return {
    cards: validReferences.map((reference) => ({
      id: reference.id,
      status: "valid",
      kindLabel: String(reference.block?.kindLabel || blockKindLabel(reference.block?.kind)),
      headingLabel: String(reference.block?.headingLabel || "未归入标题"),
      sourceLabel: String(reference.block?.sourceLabel || "未知来源"),
      excerpt: evidenceExcerpt(reference.block?.text),
      truncated: Boolean(reference.block?.truncated)
    })),
    invalidCards: invalidReferences.map((reference) => ({
      id: reference.id,
      status: reference.status,
      reason: String(reference.reason || "无法验证该内容块引用。")
    }))
  };
}

function parseInlineMarkers(line, offset, occurrences) {
  let index = 0;
  let inlineCodeTicks = 0;

  while (index < line.length) {
    if (line[index] === "`") {
      const tickCount = countRun(line, index, "`");
      if (inlineCodeTicks === 0) inlineCodeTicks = tickCount;
      else if (tickCount === inlineCodeTicks) inlineCodeTicks = 0;
      index += tickCount;
      continue;
    }

    if (inlineCodeTicks === 0 && line[index] === "[" && !isEscaped(line, index)) {
      const match = line.slice(index).match(BLOCK_MARKER_PATTERN);
      if (match) {
        const marker = match[0];
        const end = index + marker.length;
        const followedByBlockMarker = Boolean(line.slice(end).match(BLOCK_MARKER_PATTERN));
        if (
          line[end] !== "(" &&
          line[end] !== ":" &&
          (line[end] !== "[" || followedByBlockMarker)
        ) {
          occurrences.push({
            id: match[1],
            marker,
            start: offset + index,
            end: offset + end
          });
        }
        index = end;
        continue;
      }
    }

    index += 1;
  }
}

function indexEvidenceBlocks(blocks) {
  const map = new Map();
  for (const block of snapshotEvidenceBlocks(blocks)) map.set(block.id, block);
  return map;
}

function normalizeBlockId(value) {
  const id = oneLine(value);
  return BLOCK_ID_PATTERN.test(id) ? id : "";
}

function sourceLabel(source) {
  const frame = source.isMainFrame
    ? "主页面"
    : oneLine(source.frameLabel || source.frameTitle || `Frame ${source.frameId ?? "?"}`);
  return source.rootKind === "shadow" ? `${frame} · Shadow DOM` : frame;
}

function evidenceExcerpt(value) {
  const text = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length <= MAX_EVIDENCE_EXCERPT_CHARS) return text;
  return `${text.slice(0, MAX_EVIDENCE_EXCERPT_CHARS).trimEnd()}…`;
}

function countRun(value, start, character) {
  let end = start;
  while (value[end] === character) end += 1;
  return end - start;
}

function isEscaped(value, index) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function oneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function toNonNegativeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}
