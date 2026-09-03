// This function is serialized by chrome.scripting.executeScript. Keep every
// runtime helper inside the function body.
export function locatePageEvidence(input) {
  const HIGHLIGHT_NAME = "readaside-current-evidence";
  const STYLE_ID = "readaside-evidence-highlight-style";
  const OVERLAY_ID = "readaside-evidence-highlight-overlay";
  const HIGHLIGHT_DURATION_MS = 5_000;
  const target = input && typeof input === "object" ? input : {};
  const exactQuote = normalizeText(target.exactQuote).slice(0, 320);
  const locator = target.locator && typeof target.locator === "object" ? target.locator : {};

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function safeQuery(root, selector) {
    if (!root || !selector || typeof root.querySelector !== "function") return null;
    try {
      return root.querySelector(selector);
    } catch {
      return null;
    }
  }

  function resolveRoot() {
    let currentRoot = document;
    for (const hostPath of Array.isArray(locator.shadowPath) ? locator.shadowPath : []) {
      const host = safeQuery(currentRoot, String(hostPath || ""));
      if (!host) return { error: "shadow_host_missing" };
      if (!host.shadowRoot) return { error: "shadow_root_closed" };
      currentRoot = host.shadowRoot;
    }
    return { root: currentRoot };
  }

  function visibleTextNodes(element) {
    const nodes = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest("script, style, noscript, template")) return NodeFilter.FILTER_REJECT;
        try {
          const style = getComputedStyle(parent);
          if (style.display === "none" || style.visibility === "hidden") {
            return NodeFilter.FILTER_REJECT;
          }
        } catch {
          // Continue for browser-owned nodes that do not expose computed style.
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function mappedText(element) {
    const characters = [];
    const positions = [];
    let pendingSpace = null;

    for (const node of visibleTextNodes(element)) {
      const value = String(node.nodeValue || "")
        .replace(/\u00a0/g, " ")
        .replace(/[\u200B-\u200D\uFEFF]/g, "");
      for (let offset = 0; offset < value.length; offset += 1) {
        const character = value[offset];
        if (/\s/.test(character)) {
          if (characters.length && characters.at(-1) !== " ") {
            pendingSpace = { node, offset };
          }
          continue;
        }
        if (pendingSpace && characters.length) {
          characters.push(" ");
          positions.push({
            startNode: pendingSpace.node,
            startOffset: pendingSpace.offset,
            endNode: pendingSpace.node,
            endOffset: pendingSpace.offset + 1
          });
        }
        pendingSpace = null;
        characters.push(character);
        positions.push({
          startNode: node,
          startOffset: offset,
          endNode: node,
          endOffset: offset + 1
        });
      }
    }

    return { text: characters.join("").trim(), positions };
  }

  function findRanges(element, quote) {
    const mapped = mappedText(element);
    const ranges = [];
    let offset = 0;
    while (offset <= mapped.text.length - quote.length) {
      const index = mapped.text.indexOf(quote, offset);
      if (index < 0) break;
      const first = mapped.positions[index];
      const last = mapped.positions[index + quote.length - 1];
      if (first && last) {
        const range = document.createRange();
        range.setStart(first.startNode, first.startOffset);
        range.setEnd(last.endNode, last.endOffset);
        ranges.push(range);
      }
      offset = index + Math.max(1, quote.length);
    }
    return ranges;
  }

  function semanticCandidates(root) {
    const selector = [
      "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "dt", "dd",
      "pre", "blockquote", "table", "figcaption", "textarea",
      "[contenteditable='true']", "[role='heading']", "[role='listitem']"
    ].join(",");
    const candidates = [];
    try {
      candidates.push(...root.querySelectorAll(selector));
    } catch {
      return [];
    }
    return candidates.filter((element) => normalizeText(element.innerText || element.textContent)
      .includes(exactQuote));
  }

  function candidateScore(element) {
    const text = normalizeText(element.innerText || element.textContent);
    const locatorExact = normalizeText(locator.textQuote?.exact);
    const prefix = normalizeText(locator.textQuote?.prefix);
    const suffix = normalizeText(locator.textQuote?.suffix);
    let score = 0;
    if (locatorExact && (text.includes(locatorExact) || locatorExact.includes(text))) score += 4;
    if (prefix && text.includes(prefix)) score += 1;
    if (suffix && text.includes(suffix)) score += 1;
    if (text === exactQuote) score += 2;
    return score;
  }

  function chooseFallbackCandidate(root) {
    const candidates = semanticCandidates(root);
    if (!candidates.length) return { error: "quote_missing" };
    if (candidates.length === 1) return { element: candidates[0], strategy: "unique_quote" };

    const ranked = candidates
      .map((element) => ({ element, score: candidateScore(element) }))
      .sort((left, right) => right.score - left.score);
    if (ranked[0].score > 0 && ranked[0].score > ranked[1].score) {
      return { element: ranked[0].element, strategy: "quote_context" };
    }
    return { error: "ambiguous_quote" };
  }

  function clearPreviousHighlight() {
    try {
      CSS.highlights?.delete(HIGHLIGHT_NAME);
    } catch {
      // Ignore unsupported Custom Highlight implementations.
    }
    document.getElementById(OVERLAY_ID)?.remove();
    if (globalThis.__readAsideEvidenceTimer) {
      clearTimeout(globalThis.__readAsideEvidenceTimer);
      globalThis.__readAsideEvidenceTimer = null;
    }
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      `::highlight(${HIGHLIGHT_NAME}) {`,
      "  background: #fde68a;",
      "  color: inherit;",
      "  text-decoration: underline 2px #b45309;",
      "  text-underline-offset: 3px;",
      "}"
    ].join("\n");
    (document.head || document.documentElement).append(style);
  }

  function drawOverlay(range) {
    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:2147483647;";
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const marker = document.createElement("span");
      marker.style.cssText = [
        "position:absolute",
        `left:${rect.left + scrollX}px`,
        `top:${rect.top + scrollY}px`,
        `width:${rect.width}px`,
        `height:${rect.height}px`,
        "background:rgba(253,230,138,.72)",
        "box-shadow:inset 0 -2px #b45309",
        "border-radius:2px"
      ].join(";");
      overlay.append(marker);
    }
    document.documentElement.append(overlay);
  }

  function showHighlight(range) {
    clearPreviousHighlight();
    ensureStyle();
    let highlighted = false;
    try {
      if (CSS.highlights && typeof Highlight === "function") {
        CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range));
        highlighted = true;
      }
    } catch {
      highlighted = false;
    }
    if (!highlighted) drawOverlay(range);

    const focusElement = range.startContainer.parentElement;
    focusElement?.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    globalThis.__readAsideEvidenceTimer = setTimeout(clearPreviousHighlight, HIGHLIGHT_DURATION_MS);
  }

  if (!exactQuote) return { ok: false, reason: "empty_quote" };
  const rootResult = resolveRoot();
  if (!rootResult.root) return { ok: false, reason: rootResult.error };
  const root = rootResult.root;
  const structureCandidate = safeQuery(root, String(locator.structurePath || ""));
  let chosen = null;
  let strategy = "";

  if (structureCandidate) {
    const ranges = findRanges(structureCandidate, exactQuote);
    if (ranges.length === 1) {
      chosen = { element: structureCandidate, range: ranges[0] };
      strategy = "structure_exact";
    } else if (ranges.length > 1) {
      return { ok: false, reason: "ambiguous_quote" };
    }
  }

  if (!chosen) {
    const fallback = chooseFallbackCandidate(root);
    if (!fallback.element) return { ok: false, reason: fallback.error };
    const ranges = findRanges(fallback.element, exactQuote);
    if (ranges.length !== 1) {
      return { ok: false, reason: ranges.length ? "ambiguous_quote" : "quote_missing" };
    }
    chosen = { element: fallback.element, range: ranges[0] };
    strategy = fallback.strategy;
  }

  showHighlight(chosen.range);
  return { ok: true, strategy, quote: exactQuote };
}
