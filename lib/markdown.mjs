import DOMPurify from "dompurify";
import renderMathInElement from "katex/dist/contrib/auto-render.mjs";
import "katex/dist/katex.min.css";
import { parseMarkdownToHtml } from "./markdown-parser.mjs";

const ALLOWED_TAGS = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "strong",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul"
];

const ALLOWED_ATTR = [
  "aria-describedby",
  "aria-label",
  "class",
  "data-footnote-backref",
  "data-footnote-ref",
  "data-footnotes",
  "href",
  "id",
  "title"
];

export function renderMarkdown(container, markdown, citations = []) {
  const dirtyHtml = parseMarkdownToHtml(markdown, citations);
  const cleanHtml = DOMPurify.sanitize(dirtyHtml, {
    ALLOWED_ATTR,
    ALLOWED_TAGS,
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false
  });

  container.innerHTML = cleanHtml;
  secureRenderedLinks(container);
  renderMathInElement(container, {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "\\[", right: "\\]", display: true },
      { left: "\\(", right: "\\)", display: false },
      { left: "$", right: "$", display: false }
    ],
    ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
    strict: "warn",
    throwOnError: false,
    trust: false
  });
}

function secureRenderedLinks(container) {
  for (const link of container.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href") || "";
    if (href.startsWith("#")) continue;

    let url;
    try {
      url = new URL(href);
    } catch {
      link.removeAttribute("href");
      continue;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      link.removeAttribute("href");
      continue;
    }

    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
}
