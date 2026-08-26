import { Marked } from "marked";
import markedFootnote from "marked-footnote";

const markdownParser = new Marked({
  gfm: true,
  breaks: true
}).use(
  markedFootnote({
    description: "参考来源",
    footnoteDivider: true,
    keepLabels: true,
    refMarkers: true
  })
);

export function prepareMarkdown(markdown, citations = []) {
  const source = String(markdown ?? "");
  const safeCitations = normalizeCitations(citations);

  if (!safeCitations.length) {
    return source.replace(/\[\^([^\]\n]+)\]/g, '<sup class="citation-ref">[$1]</sup>');
  }

  const definitions = safeCitations.map(
    (citation, index) =>
      `[^${index + 1}]: [${escapeMarkdownLabel(citation.title || citation.url)}](<${escapeMarkdownDestination(citation.url)}>)`
  );
  const hasMatchingReference = safeCitations.some((_, index) =>
    source.includes(`[^${index + 1}]`)
  );

  if (hasMatchingReference) {
    return `${source.trim()}\n\n${definitions.join("\n")}`;
  }

  const sourceList = safeCitations.map(
    (citation) =>
      `- [${escapeMarkdownLabel(citation.title || citation.url)}](<${escapeMarkdownDestination(citation.url)}>)`
  );
  return `${source.trim()}\n\n## 来源\n\n${sourceList.join("\n")}`;
}

export function parseMarkdownToHtml(markdown, citations = []) {
  return String(markdownParser.parse(prepareMarkdown(markdown, citations)));
}

function normalizeCitations(citations) {
  const seen = new Set();
  const normalized = [];

  for (const citation of Array.isArray(citations) ? citations : []) {
    const url = String(citation?.url ?? "").trim();
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      continue;
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") continue;
    if (seen.has(parsedUrl.href)) continue;

    seen.add(parsedUrl.href);
    normalized.push({
      url: parsedUrl.href,
      title: String(citation?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
    });
  }

  return normalized;
}

function escapeMarkdownLabel(value) {
  return String(value).replace(/([\\\[\]])/g, "\\$1");
}

function escapeMarkdownDestination(value) {
  return String(value).replace(/\(/g, "%28").replace(/\)/g, "%29");
}
