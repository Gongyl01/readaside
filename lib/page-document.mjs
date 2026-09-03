export const PAGE_DOCUMENT_SCHEMA_VERSION = "readaside/page-document/v1";
export const MAX_STRUCTURED_PAGE_CHARS = 80_000;

const CONTENT_BLOCK_KINDS = new Set([
  "heading",
  "paragraph",
  "list",
  "table",
  "code",
  "quote",
  "input",
  "other"
]);

export function normalizeTableData(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.rows)) return null;
  const rows = [];
  let columnCount = 0;

  for (const sourceRow of value.rows) {
    if (!sourceRow || typeof sourceRow !== "object" || !Array.isArray(sourceRow.cells)) {
      return null;
    }
    const cells = sourceRow.cells.map((sourceCell) => ({
      text: normalizeText(sourceCell?.text),
      header: Boolean(sourceCell?.header)
    }));
    if (!cells.length) return null;
    if (!columnCount) columnCount = cells.length;
    if (cells.length !== columnCount) return null;
    const row = { cells };
    if (sourceRow.omitted) {
      row.omitted = true;
      row.omittedCount = toNonNegativeInteger(sourceRow.omittedCount);
    }
    rows.push(row);
  }

  return rows.length && columnCount ? { rows } : null;
}

export function parseMarkdownTableText(value) {
  const lines = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;

  const headerCells = splitMarkdownTableRow(lines[0]);
  const dividerCells = splitMarkdownTableRow(lines[1]);
  if (
    headerCells.length < 2 ||
    dividerCells.length !== headerCells.length ||
    !dividerCells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")))
  ) {
    return null;
  }

  const rows = [{
    cells: headerCells.map((text) => ({ text, header: true }))
  }];
  for (const line of lines.slice(2)) {
    const cells = splitMarkdownTableRow(line);
    if (cells.length !== headerCells.length) return null;
    rows.push({ cells: cells.map((text) => ({ text, header: false })) });
  }
  return normalizeTableData({ rows });
}

export function formatTableAsMarkdown(value) {
  const table = normalizeTableData(value);
  if (!table) return "";
  const columnCount = table.rows[0].cells.length;
  const firstRowIsHeader = table.rows[0].cells.every((cell) => cell.header);
  const headerCells = firstRowIsHeader
    ? table.rows[0].cells
    : Array.from({ length: columnCount }, (_, index) => ({
        text: `列 ${index + 1}`,
        header: true
      }));
  const bodyRows = firstRowIsHeader ? table.rows.slice(1) : table.rows;
  const lines = [
    formatMarkdownTableRow(headerCells, false),
    `| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`
  ];

  for (const row of bodyRows) {
    lines.push(formatMarkdownTableRow(row.cells, true));
  }
  return lines.join("\n");
}

export function mergeExtractedPageDocuments(injectionResults, options = {}) {
  const results = Array.isArray(injectionResults) ? injectionResults : [];
  const readableResults = results
    .filter((entry) => entry?.result && typeof entry.result === "object")
    .sort(compareFrameEntries);

  const mainEntry = readableResults.find((entry) => entry.frameId === 0) || readableResults[0];
  const mainPage = mainEntry?.result || {};
  const sections = [];
  const includedEntries = [];
  const seenFrameTexts = new Set();

  for (const entry of readableResults) {
    const frame = entry.result;
    const frameText = normalizeText(frame.text);
    if (!frameText || seenFrameTexts.has(frameText)) continue;
    seenFrameTexts.add(frameText);
    includedEntries.push(entry);

    if (entry.frameId === 0) {
      sections.push(frameText);
      continue;
    }

    const label = frameLabel(entry);
    sections.push(`[嵌入页面：${label}]\n${frameText}`);
  }

  const combinedText = sections.join("\n\n").trim();
  const frameBlockGroups = includedEntries.map((entry) => normalizeFrameBlocks(entry));
  const allBlocks = frameBlockGroups.flat();
  const originalBlockCount = includedEntries.reduce((total, entry, index) => {
    const reported = toNonNegativeInteger(entry.result.originalBlockCount);
    return total + Math.max(reported, frameBlockGroups[index].length);
  }, 0);
  const limited = limitContentBlocks(allBlocks, MAX_STRUCTURED_PAGE_CHARS);
  const blocks = limited.blocks.map((block, index) => ({
    ...block,
    id: formatBlockId(index + 1),
    order: index
  }));
  const blockTypeCounts = summarizeBlockKinds(blocks);
  const embeddedFrameCount = readableResults.reduce(
    (total, entry) => total + toNonNegativeInteger(entry.result.embeddedFrameCount),
    0
  );
  const frameCount = readableResults.length;
  const detectedDocumentCount = Math.max(frameCount, 1 + embeddedFrameCount);
  const originalLength = readableResults.reduce(
    (total, entry) => total + toNonNegativeInteger(entry.result.originalLength),
    0
  );
  const shadowRootCount = readableResults.reduce(
    (total, entry) => total + toNonNegativeInteger(entry.result.shadowRootCount),
    0
  );
  const canvasCount = readableResults.reduce(
    (total, entry) => total + toNonNegativeInteger(entry.result.canvasCount),
    0
  );
  const textTruncated =
    combinedText.length > MAX_STRUCTURED_PAGE_CHARS ||
    readableResults.some((entry) => Boolean(entry.result.truncated));
  const structuredTruncated =
    limited.truncated ||
    readableResults.some((entry) => Boolean(entry.result.structuredTruncated));
  const captureId = String(options.captureId || createCaptureId());
  const capturedAt = String(options.capturedAt || new Date().toISOString());

  return {
    schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
    captureId,
    capturedAt,
    title: String(mainPage.title || "未命名网页"),
    url: String(mainPage.url || ""),
    documentFormat: String(mainPage.documentFormat || "web"),
    text: combinedText.slice(0, MAX_STRUCTURED_PAGE_CHARS),
    rawLength: readableResults.reduce(
      (total, entry) => total + toNonNegativeInteger(entry.result.rawLength),
      0
    ),
    originalLength,
    truncated: textTruncated,
    blocks,
    blockCount: blocks.length,
    originalBlockCount,
    structuredChars: blocks.reduce((total, block) => total + block.text.length, 0),
    structuredTruncated,
    blockTypeCounts,
    frameCount,
    detectedDocumentCount,
    shadowRootCount,
    canvasCount,
    diagnostics: {
      blockCount: blocks.length,
      originalBlockCount,
      blockTypeCounts,
      frameCount,
      detectedDocumentCount,
      unreadableDocumentCount: Math.max(0, detectedDocumentCount - frameCount),
      shadowRootCount,
      canvasCount,
      textTruncated,
      structuredTruncated
    }
  };
}

export function summarizeBlockKinds(blocks) {
  const counts = {};
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const kind = normalizeBlockKind(block?.kind);
    counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

function normalizeFrameBlocks(entry) {
  const frame = entry.result || {};
  const sourceBlocks = Array.isArray(frame.blocks) && frame.blocks.length
    ? frame.blocks
    : createFallbackBlocks(frame.text);
  const label = frameLabel(entry);
  const frameId = Number.isFinite(Number(entry.frameId)) ? Number(entry.frameId) : 0;
  const frameTitle = String(frame.title || "").trim();
  const frameUrl = String(frame.url || "").trim();
  const normalized = [];

  for (const sourceBlock of sourceBlocks) {
    const text = normalizeText(sourceBlock?.text);
    if (!text) continue;
    const kind = normalizeBlockKind(sourceBlock?.kind);
    const locator = normalizeLocator(sourceBlock?.locator, text);
    const source = sourceBlock?.source && typeof sourceBlock.source === "object"
      ? sourceBlock.source
      : {};
    const table = kind === "table" ? normalizeTableData(sourceBlock?.table) : null;

    const block = {
      kind,
      text,
      headingPath: normalizeHeadingPath(sourceBlock?.headingPath),
      source: {
        frameId,
        frameLabel: label,
        frameTitle,
        frameUrl,
        isMainFrame: frameId === 0,
        rootKind: source.rootKind === "shadow" ? "shadow" : "document",
        shadowDepth: toNonNegativeInteger(source.shadowDepth)
      },
      locator,
      truncated: Boolean(sourceBlock?.truncated)
    };
    if (table) block.table = table;
    normalized.push(block);
  }

  return normalized;
}

function createFallbackBlocks(value) {
  const text = normalizeText(value);
  if (!text) return [];
  const chunks = splitIntoChunks(text, 4_000);
  return chunks.map((chunk) => ({
    kind: "other",
    text: chunk,
    headingPath: [],
    source: { rootKind: "document", shadowDepth: 0 },
    locator: {
      structurePath: "body",
      shadowPath: [],
      textQuote: createTextQuote(chunk)
    }
  }));
}

function normalizeLocator(locator, text) {
  const value = locator && typeof locator === "object" ? locator : {};
  const quote = value.textQuote && typeof value.textQuote === "object"
    ? value.textQuote
    : {};

  return {
    structurePath: String(value.structurePath || "").slice(0, 2_000),
    shadowPath: (Array.isArray(value.shadowPath) ? value.shadowPath : [])
      .map((part) => String(part).slice(0, 1_000))
      .filter(Boolean)
      .slice(0, 16),
    textQuote: {
      exact: normalizeText(quote.exact || text).slice(0, 320),
      prefix: normalizeText(quote.prefix).slice(-80),
      suffix: normalizeText(quote.suffix).slice(0, 80)
    }
  };
}

function limitContentBlocks(blocks, maxChars) {
  const limited = [];
  let remaining = maxChars;
  let truncated = false;

  for (const block of blocks) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    if (block.text.length <= remaining) {
      limited.push(block);
      remaining -= block.text.length;
      continue;
    }

    const text = block.text.slice(0, remaining).trim();
    if (text) {
      const limitedBlock = {
        ...block,
        text,
        truncated: true,
        locator: normalizeLocator(block.locator, text)
      };
      delete limitedBlock.table;
      limited.push(limitedBlock);
    }
    remaining = 0;
    truncated = true;
  }

  return { blocks: limited, truncated };
}

function normalizeHeadingPath(value) {
  return (Array.isArray(value) ? value : [])
    .map((part) => normalizeText(part).slice(0, 300))
    .filter(Boolean)
    .slice(0, 6);
}

function normalizeBlockKind(value) {
  const kind = String(value || "other").toLowerCase();
  return CONTENT_BLOCK_KINDS.has(kind) ? kind : "other";
}

function compareFrameEntries(left, right) {
  if (left.frameId === 0) return -1;
  if (right.frameId === 0) return 1;
  return Number(left.frameId ?? 0) - Number(right.frameId ?? 0);
}

function frameLabel(entry) {
  const frame = entry.result || {};
  return String(frame.title || frame.url || `Frame ${entry.frameId}`).trim();
}

function formatBlockId(index) {
  return `B${String(index).padStart(4, "0")}`;
}

function createCaptureId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `capture-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createTextQuote(text) {
  return {
    exact: normalizeText(text).slice(0, 320),
    prefix: "",
    suffix: ""
  };
}

function formatMarkdownTableRow(cells, emphasizeHeaders) {
  const values = cells.map((cell) => {
    const text = escapeMarkdownTableCell(cell.text) || " ";
    return emphasizeHeaders && cell.header ? `**${text}**` : text;
  });
  return `| ${values.join(" | ")} |`;
}

function escapeMarkdownTableCell(value) {
  return normalizeText(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, "<br>");
}

function splitIntoChunks(text, maxChars) {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];

  for (const paragraph of paragraphs.length ? paragraphs : [text]) {
    for (let offset = 0; offset < paragraph.length; offset += maxChars) {
      const chunk = paragraph.slice(offset, offset + maxChars).trim();
      if (chunk) chunks.push(chunk);
    }
  }

  return chunks;
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

function splitMarkdownTableRow(value) {
  let source = String(value ?? "").trim();
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|") && !source.endsWith("\\|")) source = source.slice(0, -1);

  const cells = [];
  let current = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && source[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

function toNonNegativeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}
