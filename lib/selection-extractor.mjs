export function extractSelectionContent() {
  // This function is serialized by chrome.scripting.executeScript, so every
  // helper and limit it uses must remain inside the function body.
  const MAX_SELECTION_CHARS = 20_000;

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/[\t\f\v\u00a0 ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function deepestActiveElement(root) {
    let activeElement = root?.activeElement ?? null;
    const visited = new Set();

    while (
      activeElement?.shadowRoot?.activeElement &&
      !visited.has(activeElement.shadowRoot.activeElement)
    ) {
      activeElement = activeElement.shadowRoot.activeElement;
      visited.add(activeElement);
    }

    return activeElement;
  }

  function selectedControlText() {
    const activeElement = deepestActiveElement(document);
    const tagName = String(activeElement?.tagName ?? "").toLowerCase();
    if (tagName !== "textarea" && tagName !== "input") return "";

    try {
      const start = Number(activeElement.selectionStart);
      const end = Number(activeElement.selectionEnd);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start === end) return "";
      return String(activeElement.value ?? "").slice(Math.min(start, end), Math.max(start, end));
    } catch {
      return "";
    }
  }

  let documentSelection = "";
  try {
    if (typeof globalThis.getSelection === "function") {
      documentSelection = globalThis.getSelection()?.toString() ?? "";
    }
  } catch {
    documentSelection = "";
  }

  const controlSelection = selectedControlText();
  const parts = [documentSelection, controlSelection]
    .map(normalizeText)
    .filter(Boolean);
  const text = [...new Set(parts)].join("\n\n");
  const originalLength = text.length;

  return {
    title: String(document.title || location.href || "当前页面"),
    url: String(location.href || ""),
    text: text.slice(0, MAX_SELECTION_CHARS),
    originalLength,
    truncated: originalLength > MAX_SELECTION_CHARS
  };
}

export function mergeSelectionContents(injectionResults) {
  const MAX_SELECTION_CHARS = 20_000;
  const results = Array.isArray(injectionResults) ? injectionResults : [];
  const readableResults = results
    .filter((entry) => entry?.result && typeof entry.result === "object")
    .sort((left, right) => {
      if (left.frameId === 0) return -1;
      if (right.frameId === 0) return 1;
      return Number(left.frameId ?? 0) - Number(right.frameId ?? 0);
    });
  const selections = [];
  const seenTexts = new Set();

  for (const entry of readableResults) {
    const selection = entry.result;
    const text = String(selection.text ?? "").trim();
    if (!text || seenTexts.has(text)) continue;
    seenTexts.add(text);
    selections.push({
      frameId: Number(entry.frameId ?? 0),
      title: String(selection.title || selection.url || `Frame ${entry.frameId}`).trim(),
      text,
      truncated: Boolean(selection.truncated)
    });
  }

  const sections = selections.map((selection) => {
    if (selections.length === 1 || selection.frameId === 0) return selection.text;
    return `[选区来源：${selection.title}]\n${selection.text}`;
  });
  const combinedText = sections.join("\n\n").trim();

  return {
    text: combinedText.slice(0, MAX_SELECTION_CHARS),
    originalLength: combinedText.length,
    truncated:
      combinedText.length > MAX_SELECTION_CHARS ||
      selections.some((selection) => selection.truncated),
    sourceCount: selections.length
  };
}
