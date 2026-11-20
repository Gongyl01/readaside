import { mergeExtractedPageDocuments } from "./page-document.mjs";

// This function is serialized by chrome.scripting.executeScript. Every helper
// used while reading the page must therefore stay inside the function body.
export function extractPageContent() {
  const FRAME_DOCUMENT_SCHEMA_VERSION = "readaside/frame-document/v1";
  const MAX_FRAME_CHARS = 80_000;
  const MAX_BLOCK_CHARS = 4_000;
  const SEMANTIC_SELECTOR = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "li",
    "dt",
    "dd",
    "pre",
    "blockquote",
    "table",
    "figcaption",
    "textarea",
    "[contenteditable='true']",
    "[role='heading']",
    "[role='listitem']"
  ].join(",");
  const root = document.body || document.documentElement;

  function documentTitle() {
    const title = String(document.title || "").trim();
    if (title) return title;

    if (location.protocol === "file:") {
      const filename = String(location.pathname || "").split("/").pop();
      if (filename) {
        try {
          return decodeURIComponent(filename);
        } catch {
          return filename;
        }
      }
    }

    return "未命名网页";
  }

  function normalizeText(value) {
    const normalizedLines = String(value ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim());

    const filteredLines = [];
    let previousContentLine = null;

    for (const line of normalizedLines) {
      if (!line) {
        if (filteredLines.length && filteredLines.at(-1) !== "") filteredLines.push("");
        continue;
      }

      if (line === previousContentLine) continue;
      filteredLines.push(line);
      previousContentLine = line;
    }

    return filteredLines.join("\n").trim();
  }

  function renderedText(node, safe = false) {
    if (!node) return "";
    if (["script", "style", "noscript", "template"].includes(elementTag(node))) return "";
    if (!isVisibleElement(node)) return "";
    if (safe) return visibleDomText(node);
    if (typeof node.innerText === "string") return node.innerText;
    return typeof node.textContent === "string" ? node.textContent : "";
  }

  function visibleDomText(node) {
    if (!node || node.nodeType === 8) return "";
    if (node.nodeType === 3) return String(node.nodeValue ?? node.textContent ?? "");
    const tag = elementTag(node);
    if (["script", "style", "noscript", "template"].includes(tag)) return "";
    if (tag && !isVisibleElement(node)) return "";
    if (tag === "br") return "\n";

    const children = Array.from(node.childNodes || node.children || []);
    const text = children.length
      ? children.map(visibleDomText).join("")
      : typeof node.innerText === "string"
        ? node.innerText
        : String(node.textContent ?? "");
    return /^(?:address|article|blockquote|dd|div|dt|figcaption|figure|footer|h[1-6]|header|li|main|nav|p|pre|section|table|tr)$/.test(tag)
      ? `\n${text}\n`
      : text;
  }

  function renderedContainerText(textRoot) {
    if (typeof textRoot?.innerText !== "string") return visibleDomText(textRoot);

    const text = textRoot.innerText;
    const ignoredNodes = queryElements(textRoot, "style, script, noscript, template");
    if (!ignoredNodes.length) return text;
    const normalized = normalizeText(text);
    const hasLeakedContent = ignoredNodes.some((node) => {
      const prefix = normalizeText(String(node.textContent ?? "").slice(0, 240));
      return prefix.length >= 40 && normalized.includes(prefix);
    });
    return hasLeakedContent ? visibleDomText(textRoot) : text;
  }

  function countMatches(container, selector) {
    if (!container || typeof container.querySelectorAll !== "function") return 0;
    try {
      return container.querySelectorAll(selector).length;
    } catch {
      return 0;
    }
  }

  function queryElements(container, selector) {
    if (!container || typeof container.querySelectorAll !== "function") return [];
    try {
      return Array.from(container.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function elementTag(element) {
    return String(element?.tagName || "").toLowerCase();
  }

  function elementRole(element) {
    if (typeof element?.getAttribute !== "function") return "";
    return String(element.getAttribute("role") || "").toLowerCase();
  }

  function isVisibleElement(element) {
    if (!element || element.hidden) return false;
    if (typeof element.getAttribute === "function") {
      if (String(element.getAttribute("aria-hidden") || "").toLowerCase() === "true") {
        return false;
      }
    }

    if (typeof globalThis.getComputedStyle === "function") {
      try {
        const style = globalThis.getComputedStyle(element);
        if (style?.display === "none" || style?.visibility === "hidden") return false;
      } catch {
        // Some browser-owned elements do not expose a computed style.
      }
    }

    return true;
  }

  function hasNavigationStructure(element) {
    let current = element;
    while (current) {
      const tag = elementTag(current);
      const role = elementRole(current);
      if (
        tag === "nav" ||
        ["navigation", "toolbar", "menu", "menubar", "tablist"].includes(role) ||
        ["a", "button", "input", "select"].includes(tag)
      ) {
        return true;
      }

      if (typeof current.getAttribute === "function") {
        const contextSignal = [
          current.getAttribute("id"),
          current.getAttribute("class"),
          current.getAttribute("aria-label"),
          current.getAttribute("data-testid")
        ].filter(Boolean).join(" ");
        if (/(?:pagination|paginator|pager|toolbar|navigation|navbar|breadcrumb|分页|翻页|导航|工具栏)/i.test(contextSignal)) {
          return true;
        }
      }

      if (current === root) break;
      current = current.parentElement;
    }

    return false;
  }

  function shouldExcludeListItem(element, text) {
    const compact = String(text ?? "").normalize("NFKC").replace(/\s+/g, "");
    if (!compact) return true;
    if (/^(?:\.{2,}|…+|⋯+)$/.test(compact)) return true;
    if (/^[\/\\|¦_\-–—―~〜=+<>«»()[\]{}]+$/u.test(compact)) return true;
    return hasNavigationStructure(element);
  }

  function blockKind(element) {
    const tag = elementTag(element);
    const role = elementRole(element);
    if (/^h[1-6]$/.test(tag) || role === "heading") return "heading";
    if (tag === "p" || tag === "figcaption") return "paragraph";
    if (["li", "dt", "dd"].includes(tag) || role === "listitem") return "list";
    if (tag === "pre") return "code";
    if (tag === "table") return "table";
    if (tag === "blockquote") return "quote";
    if (tag === "textarea" || element?.isContentEditable) return "input";
    return "other";
  }

  function headingLevel(element) {
    const tag = elementTag(element);
    if (/^h[1-6]$/.test(tag)) return Number(tag.slice(1));
    if (typeof element?.getAttribute === "function") {
      const level = Number(element.getAttribute("aria-level"));
      if (Number.isInteger(level) && level >= 1 && level <= 6) return level;
    }
    return 2;
  }

  function tableRows(element) {
    if (element?.rows) return Array.from(element.rows);
    return queryElements(element, "tr").filter((row) => {
      let current = row?.parentElement;
      while (current && current !== element) {
        if (elementTag(current) === "table") return false;
        current = current.parentElement;
      }
      return current === element;
    });
  }

  function rowCells(row) {
    if (row?.cells) return Array.from(row.cells);
    return Array.from(row?.children || []).filter((cell) => (
      ["th", "td"].includes(elementTag(cell))
    ));
  }

  function hasSimpleCellSpan(cell, attributeName, propertyName) {
    if (typeof cell?.getAttribute === "function") {
      const rawValue = cell.getAttribute(attributeName);
      if (rawValue !== null && rawValue !== "") {
        const value = Number(rawValue);
        if (!Number.isInteger(value) || value !== 1) return false;
      }
    }

    const propertyValue = Number(cell?.[propertyName] ?? 1);
    return Number.isInteger(propertyValue) && propertyValue === 1;
  }

  function extractSimpleTable(element, tableText) {
    if (tableText.length > MAX_BLOCK_CHARS) return null;
    const rows = [];
    let columnCount = 0;

    for (const row of tableRows(element)) {
      if (!isVisibleElement(row)) continue;
      const cells = [];
      for (const cell of rowCells(row)) {
        if (!isVisibleElement(cell)) continue;
        if (
          !hasSimpleCellSpan(cell, "rowspan", "rowSpan") ||
          !hasSimpleCellSpan(cell, "colspan", "colSpan") ||
          countMatches(cell, "table") > 0
        ) {
          return null;
        }
        cells.push({
          text: normalizeText(renderedText(cell)),
          header: elementTag(cell) === "th"
        });
      }

      if (!cells.length) return null;
      if (!columnCount) columnCount = cells.length;
      if (cells.length !== columnCount) return null;
      rows.push({ cells });
    }

    return rows.length && columnCount ? { rows } : null;
  }

  function isInsideAtomicCandidate(element, container) {
    let parent = element?.parentElement;
    while (parent && parent !== container && parent !== root) {
      const tag = elementTag(parent);
      if (["pre", "table", "blockquote", "li"].includes(tag)) return true;
      parent = parent.parentElement;
    }
    return false;
  }

  function structureSegment(element) {
    const tag = elementTag(element) || "element";
    let index = 1;
    let sibling = element?.previousElementSibling;
    while (sibling) {
      if (elementTag(sibling) === tag) index += 1;
      sibling = sibling.previousElementSibling;
    }
    return `${tag}:nth-of-type(${index})`;
  }

  function structurePath(element, fallback = "body") {
    if (!element) return fallback;
    const segments = [];
    let current = element;

    while (current && segments.length < 12) {
      segments.push(structureSegment(current));
      const tag = elementTag(current);
      if (tag === "html") break;
      current = current.parentElement;
    }

    return segments.reverse().join(" > ") || fallback;
  }

  function textQuote(text, rootText, offset) {
    const exact = normalizeText(text).slice(0, 320);
    const hasOffset = Number.isInteger(offset) && offset >= 0;
    return {
      exact,
      prefix: hasOffset ? normalizeText(rootText.slice(Math.max(0, offset - 80), offset)).slice(-80) : "",
      suffix: hasOffset
        ? normalizeText(rootText.slice(offset + exact.length, offset + exact.length + 80)).slice(0, 80)
        : ""
    };
  }

  function findTextOffset(rootText, text, fromIndex) {
    let offset = rootText.indexOf(text, Math.max(0, fromIndex));
    if (offset < 0) offset = rootText.indexOf(text);
    return offset;
  }

  function fallbackBlockKind(text) {
    const value = normalizeText(text);
    if (/^(?:[-*+] |\d+[.)] )/m.test(value)) return "list";
    if (/^\s*>\s?/m.test(value)) return "quote";
    if (/^\s*```|\b(?:const|let|var|function|class|import|export)\b/.test(value)) return "code";
    return "paragraph";
  }

  function splitTextWithOffsets(text, baseOffset = 0) {
    const parts = [];
    const paragraphPattern = /[^\n](?:.|\n(?!\n))*[^\n]|[^\n]/g;
    const paragraphs = text.match(paragraphPattern) || [];
    let searchFrom = 0;

    for (const paragraphValue of paragraphs) {
      const paragraph = normalizeText(paragraphValue);
      if (!paragraph) continue;
      const relativeOffset = Math.max(0, text.indexOf(paragraphValue, searchFrom));
      searchFrom = relativeOffset + paragraphValue.length;

      for (let chunkOffset = 0; chunkOffset < paragraph.length; chunkOffset += MAX_BLOCK_CHARS) {
        const chunk = paragraph.slice(chunkOffset, chunkOffset + MAX_BLOCK_CHARS).trim();
        if (!chunk) continue;
        parts.push({ text: chunk, offset: baseOffset + relativeOffset + chunkOffset });
      }
    }

    return parts;
  }

  function createEntry({
    kind,
    text,
    offset,
    element = null,
    heading = 0,
    rootText,
    metadata,
    sequence,
    table = null,
    excluded = false
  }) {
    const entry = {
      kind,
      text,
      offset,
      headingLevel: heading,
      sequence,
      source: {
        rootKind: metadata.rootKind,
        shadowDepth: metadata.shadowDepth
      },
      locator: {
        structurePath: structurePath(element, metadata.rootPath),
        shadowPath: metadata.shadowPath,
        textQuote: textQuote(text, rootText, offset)
      },
      excluded
    };
    if (table) entry.table = table;
    return entry;
  }

  function collectSemanticEntries(container, rootText, metadata) {
    const entries = [];
    let searchFrom = 0;
    let sequence = 0;

    for (const element of queryElements(container, SEMANTIC_SELECTOR)) {
      if (!isVisibleElement(element) || isInsideAtomicCandidate(element, container)) continue;
      const text = normalizeText(renderedText(element, metadata.rootKind === "shadow"));
      if (!text) continue;
      const kind = blockKind(element);
      const offset = findTextOffset(rootText, text, searchFrom);
      if (offset >= 0) searchFrom = offset + text.length;
      const excluded = kind === "list" && shouldExcludeListItem(element, text);
      const table = kind === "table" ? extractSimpleTable(element, text) : null;

      entries.push(createEntry({
        kind,
        text,
        offset,
        element,
        heading: kind === "heading" ? headingLevel(element) : 0,
        rootText,
        metadata,
        sequence: sequence++,
        table,
        excluded
      }));
    }

    return entries;
  }

  function addUncoveredText(entries, rootText, metadata) {
    const placed = entries
      .filter((entry) => entry.offset >= 0)
      .sort((left, right) => left.offset - right.offset || left.sequence - right.sequence);
    const nonOverlapping = [];
    let coveredUntil = 0;

    for (const entry of placed) {
      const end = entry.offset + entry.text.length;
      if (end <= coveredUntil || entry.offset < coveredUntil) continue;
      nonOverlapping.push(entry);
      coveredUntil = end;
    }

    const result = [];
    let cursor = 0;
    let sequence = entries.length;

    for (const entry of nonOverlapping) {
      if (entry.offset > cursor) {
        for (const part of splitTextWithOffsets(rootText.slice(cursor, entry.offset), cursor)) {
          result.push(createEntry({
            kind: fallbackBlockKind(part.text),
            text: part.text,
            offset: part.offset,
            rootText,
            metadata,
            sequence: sequence++
          }));
        }
      }
      if (!entry.excluded) result.push(entry);
      cursor = entry.offset + entry.text.length;
    }

    if (cursor < rootText.length) {
      for (const part of splitTextWithOffsets(rootText.slice(cursor), cursor)) {
        result.push(createEntry({
          kind: fallbackBlockKind(part.text),
          text: part.text,
          offset: part.offset,
          rootText,
          metadata,
          sequence: sequence++
        }));
      }
    }

    for (const entry of entries.filter((item) => item.offset < 0 && !item.excluded)) {
      if (!result.some((item) => item.text === entry.text)) result.push(entry);
    }

    return result;
  }

  function applyHeadingPaths(entries) {
    const headingStack = [];
    const expanded = entries.flatMap((entry) => {
      if (entry.text.length <= MAX_BLOCK_CHARS) return [entry];
      const chunks = [];
      for (let chunkOffset = 0; chunkOffset < entry.text.length; chunkOffset += MAX_BLOCK_CHARS) {
        const text = entry.text.slice(chunkOffset, chunkOffset + MAX_BLOCK_CHARS).trim();
        if (!text) continue;
        chunks.push({
          ...entry,
          kind: entry.kind === "heading" && chunkOffset > 0 ? "paragraph" : entry.kind,
          text,
          offset: entry.offset >= 0 ? entry.offset + chunkOffset : entry.offset,
          sequence: entry.sequence + chunkOffset / MAX_BLOCK_CHARS,
          locator: {
            ...entry.locator,
            textQuote: {
              exact: text.slice(0, 320),
              prefix: chunkOffset === 0 ? entry.locator.textQuote.prefix : "",
              suffix: ""
            }
          }
        });
      }
      return chunks;
    });
    const sorted = expanded.sort((left, right) => {
      const leftOffset = left.offset >= 0 ? left.offset : Number.MAX_SAFE_INTEGER;
      const rightOffset = right.offset >= 0 ? right.offset : Number.MAX_SAFE_INTEGER;
      return leftOffset - rightOffset || left.sequence - right.sequence;
    });

    return sorted.map((entry) => {
      if (entry.kind === "heading") {
        const level = Math.min(6, Math.max(1, entry.headingLevel || 2));
        headingStack.length = level;
        headingStack[level - 1] = entry.text.replace(/^#{1,6}\s+/, "").slice(0, 300);
        for (let index = 0; index < level - 1; index += 1) {
          if (headingStack[index] === undefined) headingStack[index] = "";
        }
      }

      const block = {
        kind: entry.kind,
        text: entry.text,
        headingPath: headingStack.filter(Boolean),
        source: entry.source,
        locator: entry.locator,
        truncated: false
      };
      if (entry.table) block.table = entry.table;
      return block;
    });
  }

  function inferDocumentFormat() {
    if (location.protocol !== "file:") return "web";
    const pathname = String(location.pathname || "").toLowerCase();
    if (pathname.endsWith(".md") || pathname.endsWith(".markdown")) return "markdown";
    if (pathname.endsWith(".json")) return "json";
    if (pathname.endsWith(".txt")) return "text";
    return "html";
  }

  function markdownEntries(rootText, metadata) {
    const entries = [];
    const lines = rootText.split("\n");
    let offset = 0;
    let sequence = 0;
    let paragraphLines = [];
    let paragraphOffset = 0;
    let fenceLines = [];
    let fenceOffset = 0;
    let insideFence = false;

    function pushEntry(kind, text, entryOffset, heading = 0) {
      const normalized = normalizeText(text);
      if (!normalized) return;
      entries.push(createEntry({
        kind,
        text: normalized,
        offset: entryOffset,
        heading,
        rootText,
        metadata,
        sequence: sequence++
      }));
    }

    function flushParagraph() {
      if (!paragraphLines.length) return;
      pushEntry("paragraph", paragraphLines.join("\n"), paragraphOffset);
      paragraphLines = [];
    }

    function flushFence() {
      if (!fenceLines.length) return;
      pushEntry("code", fenceLines.join("\n"), fenceOffset);
      fenceLines = [];
    }

    for (const line of lines) {
      const lineOffset = offset;
      offset += line.length + 1;

      if (/^\s*```/.test(line)) {
        flushParagraph();
        if (!insideFence) {
          insideFence = true;
          fenceOffset = lineOffset;
          fenceLines.push(line);
        } else {
          fenceLines.push(line);
          insideFence = false;
          flushFence();
        }
        continue;
      }

      if (insideFence) {
        fenceLines.push(line);
        continue;
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        flushParagraph();
        pushEntry("heading", line, lineOffset, headingMatch[1].length);
        continue;
      }

      if (/^\s*(?:[-*+] |\d+[.)] )/.test(line)) {
        flushParagraph();
        pushEntry("list", line, lineOffset);
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        flushParagraph();
        pushEntry("quote", line, lineOffset);
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        continue;
      }

      if (!paragraphLines.length) paragraphOffset = lineOffset;
      paragraphLines.push(line);
    }

    flushParagraph();
    flushFence();
    return applyHeadingPaths(entries);
  }

  function blocksForContainer(container, textRoot, metadata, format) {
    const rootText = normalizeText(renderedContainerText(textRoot));
    if (!rootText) return [];

    if (metadata.rootKind === "document" && format === "markdown") {
      return markdownEntries(rootText, metadata);
    }

    if (metadata.rootKind === "document" && format === "json") {
      return applyHeadingPaths(splitTextWithOffsets(rootText).map((part, index) => createEntry({
        kind: "code",
        text: part.text,
        offset: part.offset,
        rootText,
        metadata,
        sequence: index
      })));
    }

    const semanticEntries = collectSemanticEntries(container, rootText, metadata);
    return applyHeadingPaths(addUncoveredText(semanticEntries, rootText, metadata));
  }

  function limitBlocks(blocks) {
    const limited = [];
    let remaining = MAX_FRAME_CHARS;
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
          locator: {
            ...block.locator,
            textQuote: textQuote(text, text, 0)
          }
        };
        delete limitedBlock.table;
        limited.push(limitedBlock);
      }
      remaining = 0;
      truncated = true;
    }

    return { blocks: limited, truncated };
  }

  if (!root) {
    return {
      schemaVersion: FRAME_DOCUMENT_SCHEMA_VERSION,
      title: documentTitle(),
      url: location.href,
      documentFormat: inferDocumentFormat(),
      text: "",
      rawLength: 0,
      originalLength: 0,
      truncated: false,
      blocks: [],
      originalBlockCount: 0,
      structuredTruncated: false,
      shadowRootCount: 0,
      embeddedFrameCount: 0,
      canvasCount: 0
    };
  }

  const format = inferDocumentFormat();
  const textParts = [];
  const allBlocks = [];
  const visitedShadowRoots = new Set();
  const containers = [{
    container: document,
    textRoot: root,
    metadata: {
      rootKind: "document",
      rootPath: elementTag(root) || "body",
      shadowDepth: 0,
      shadowPath: []
    }
  }];
  let shadowRootCount = 0;
  let embeddedFrameCount = 0;
  let canvasCount = 0;

  while (containers.length) {
    const current = containers.shift();
    const containerText = renderedContainerText(current.textRoot);
    if (containerText) textParts.push(containerText);
    allBlocks.push(
      ...blocksForContainer(
        current.container,
        current.textRoot,
        current.metadata,
        format
      )
    );
    embeddedFrameCount += countMatches(current.container, "iframe, frame");
    canvasCount += countMatches(current.container, "canvas");

    for (const element of queryElements(current.container, "*")) {
      const shadowRoot = element?.shadowRoot;
      if (!shadowRoot || visitedShadowRoots.has(shadowRoot)) continue;

      visitedShadowRoots.add(shadowRoot);
      shadowRootCount += 1;
      const hostPath = structurePath(element, current.metadata.rootPath);
      containers.push({
        container: shadowRoot,
        textRoot: shadowRoot,
        metadata: {
          rootKind: "shadow",
          rootPath: ":host",
          shadowDepth: current.metadata.shadowDepth + 1,
          shadowPath: [...current.metadata.shadowPath, hostPath]
        }
      });
    }
  }

  const normalizedParts = [];
  let accumulatedText = "";

  for (const part of textParts) {
    const normalized = normalizeText(part);
    if (!normalized) continue;
    if (accumulatedText && accumulatedText.includes(normalized)) continue;
    normalizedParts.push(normalized);
    accumulatedText = normalizedParts.join("\n\n");
  }

  const rawText = textParts.join("\n\n");
  const text = normalizedParts.join("\n\n").trim();
  const originalLength = text.length;
  const originalBlockCount = allBlocks.length;
  const limitedBlocks = limitBlocks(allBlocks);

  return {
    schemaVersion: FRAME_DOCUMENT_SCHEMA_VERSION,
    title: documentTitle(),
    url: location.href,
    documentFormat: format,
    text: text.slice(0, MAX_FRAME_CHARS),
    rawLength: rawText.length,
    originalLength,
    truncated: originalLength > MAX_FRAME_CHARS,
    blocks: limitedBlocks.blocks.map((block, order) => ({ ...block, order })),
    originalBlockCount,
    structuredTruncated: limitedBlocks.truncated,
    shadowRootCount,
    embeddedFrameCount,
    canvasCount
  };
}

export function mergePageContents(injectionResults) {
  return mergeExtractedPageDocuments(injectionResults);
}
