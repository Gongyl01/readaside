import test from "node:test";
import assert from "node:assert/strict";
import { parseMarkdownToHtml, prepareMarkdown } from "../lib/markdown-parser.mjs";

test("standard Markdown renders emphasis and inline code", () => {
  const html = parseMarkdownToHtml("关于 **KDA**，变量为 `alpha_t`。");

  assert.match(html, /<strong>KDA<\/strong>/);
  assert.match(html, /<code>alpha_t<\/code>/);
});

test("GitHub-style Markdown tables become real table elements", () => {
  const html = parseMarkdownToHtml(
    [
      "| 传统门控 | KDA 通道级门控 |",
      "| --- | --- |",
      "| 标量衰减 | 按通道衰减 |"
    ].join("\n")
  );

  assert.match(html, /<table>/);
  assert.match(html, /<th>传统门控<\/th>/);
  assert.match(html, /<td>按通道衰减<\/td>/);
});

test("math delimiters remain available for the KaTeX browser pass", () => {
  const html = parseMarkdownToHtml(
    "$$S_t = \\alpha_t(I - \\beta_t k_t k_t^T)S_{t-1}$$\n\n其中 $\\alpha_t$ 是标量。"
  );

  assert.match(html, /\$\$S_t = \\alpha_t/);
  assert.match(html, /\$\\alpha_t\$/);
});

test("citation markers render as readable superscripts without metadata", () => {
  const markdown = prepareMarkdown("KDA 改进了门控。[^1]");

  assert.match(markdown, /<sup class="citation-ref">\[1\]<\/sup>/);
});

test("streamed citation metadata becomes linked footnotes", () => {
  const html = parseMarkdownToHtml("KDA 改进了门控。[^1]", [
    { title: "Kimi Linear Paper", url: "https://example.com/paper" }
  ]);

  assert.match(html, /class="footnotes"/);
  assert.match(html, /href="https:\/\/example\.com\/paper"/);
  assert.match(html, /Kimi Linear Paper/);
});

test("citations without inline markers are appended as a sources section", () => {
  const html = parseMarkdownToHtml("KDA 是一种线性注意力机制。", [
    { title: "Source", url: "https://example.com/source" }
  ]);

  assert.match(html, /<h2>来源<\/h2>/);
  assert.match(html, /href="https:\/\/example\.com\/source"/);
});

test("citation URLs containing parentheses remain intact", () => {
  const html = parseMarkdownToHtml("引用。[^1]", [
    { title: "Paper", url: "https://example.com/paper_(draft)" }
  ]);

  assert.match(html, /href="https:\/\/example\.com\/paper_%28draft%29"/);
});
