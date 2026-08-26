const MAX_PAGE_CHARS = 80_000;

// This function is serialized by chrome.scripting.executeScript, so every helper
// it needs must stay inside the function body.
export function extractPageContent() {
  const MAX_FRAME_CHARS = 80_000;
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

  function renderedText(node) {
    if (!node) return "";
    if (typeof node.innerText === "string") return node.innerText;
    return typeof node.textContent === "string" ? node.textContent : "";
  }

  function countMatches(container, selector) {
    if (!container || typeof container.querySelectorAll !== "function") return 0;
    try {
      return container.querySelectorAll(selector).length;
    } catch {
      return 0;
    }
  }

  if (!root) {
    return {
      title: documentTitle(),
      url: location.href,
      text: "",
      rawLength: 0,
      originalLength: 0,
      truncated: false,
      shadowRootCount: 0,
      embeddedFrameCount: 0,
      canvasCount: 0
    };
  }

  const textParts = [renderedText(root)];
  const visitedShadowRoots = new Set();
  const containers = [document];
  let shadowRootCount = 0;
  let embeddedFrameCount = countMatches(document, "iframe, frame");
  let canvasCount = countMatches(document, "canvas");

  while (containers.length) {
    const container = containers.shift();
    if (!container || typeof container.querySelectorAll !== "function") continue;

    let elements = [];
    try {
      elements = container.querySelectorAll("*");
    } catch {
      continue;
    }

    for (const element of elements) {
      const shadowRoot = element?.shadowRoot;
      if (!shadowRoot || visitedShadowRoots.has(shadowRoot)) continue;

      visitedShadowRoots.add(shadowRoot);
      shadowRootCount += 1;
      embeddedFrameCount += countMatches(shadowRoot, "iframe, frame");
      canvasCount += countMatches(shadowRoot, "canvas");

      const shadowParts = [];
      const children = shadowRoot.children ? Array.from(shadowRoot.children) : [];
      for (const child of children) {
        const text = renderedText(child);
        if (text) shadowParts.push(text);
      }
      if (!children.length) shadowParts.push(renderedText(shadowRoot));
      if (shadowParts.length) textParts.push(shadowParts.join("\n"));

      containers.push(shadowRoot);
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

  return {
    title: documentTitle(),
    url: location.href,
    text: text.slice(0, MAX_FRAME_CHARS),
    rawLength: rawText.length,
    originalLength,
    truncated: originalLength > MAX_FRAME_CHARS,
    shadowRootCount,
    embeddedFrameCount,
    canvasCount
  };
}

export function mergePageContents(injectionResults) {
  const results = Array.isArray(injectionResults) ? injectionResults : [];
  const readableResults = results
    .filter((entry) => entry?.result && typeof entry.result === "object")
    .sort((left, right) => {
      if (left.frameId === 0) return -1;
      if (right.frameId === 0) return 1;
      return Number(left.frameId ?? 0) - Number(right.frameId ?? 0);
    });

  const mainEntry = readableResults.find((entry) => entry.frameId === 0) || readableResults[0];
  const mainPage = mainEntry?.result || {};
  const sections = [];
  const seenFrameTexts = new Set();

  for (const entry of readableResults) {
    const frame = entry.result;
    const frameText = String(frame.text ?? "").trim();
    if (!frameText || seenFrameTexts.has(frameText)) continue;
    seenFrameTexts.add(frameText);

    if (entry.frameId === 0) {
      sections.push(frameText);
      continue;
    }

    const label = String(frame.title || frame.url || `Frame ${entry.frameId}`).trim();
    sections.push(`[嵌入页面：${label}]\n${frameText}`);
  }

  const combinedText = sections.join("\n\n").trim();
  const embeddedFrameCount = readableResults.reduce(
    (total, entry) => total + Number(entry.result.embeddedFrameCount || 0),
    0
  );
  const frameCount = readableResults.length;
  const detectedDocumentCount = Math.max(frameCount, 1 + embeddedFrameCount);
  const originalLength = readableResults.reduce(
    (total, entry) => total + Number(entry.result.originalLength || 0),
    0
  );

  return {
    title: String(mainPage.title || "未命名网页"),
    url: String(mainPage.url || ""),
    text: combinedText.slice(0, MAX_PAGE_CHARS),
    rawLength: readableResults.reduce(
      (total, entry) => total + Number(entry.result.rawLength || 0),
      0
    ),
    originalLength,
    truncated:
      combinedText.length > MAX_PAGE_CHARS ||
      readableResults.some((entry) => Boolean(entry.result.truncated)),
    frameCount,
    detectedDocumentCount,
    shadowRootCount: readableResults.reduce(
      (total, entry) => total + Number(entry.result.shadowRootCount || 0),
      0
    ),
    canvasCount: readableResults.reduce(
      (total, entry) => total + Number(entry.result.canvasCount || 0),
      0
    )
  };
}
