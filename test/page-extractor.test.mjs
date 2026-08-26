import test from "node:test";
import assert from "node:assert/strict";
import { extractPageContent, mergePageContents } from "../lib/page-extractor.mjs";

function withPage({ title = "测试页", url = "https://example.com", innerText, textContent = "" }, run) {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;

  globalThis.document = {
    title,
    body: { innerText, textContent },
    documentElement: { innerText, textContent },
    querySelectorAll() {
      return [];
    }
  };
  const parsedUrl = new URL(url);
  globalThis.location = {
    href: parsedUrl.href,
    pathname: parsedUrl.pathname,
    protocol: parsedUrl.protocol
  };

  try {
    return run();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;

    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  }
}

test("extractPageContent keeps visible text from the whole page", () => {
  const result = withPage(
    {
      innerText: [
        "Models",
        "",
        "1. Model Introduction",
        "Kimi K3 is a multimodal model.",
        "",
        "Kimi K3 Collection",
        "Open Frontier Intelligence"
      ].join("\n")
    },
    () => extractPageContent()
  );

  assert.match(result.text, /1\. Model Introduction/);
  assert.match(result.text, /Kimi K3 Collection/);
  assert.equal(result.truncated, false);
});

test("extractPageContent normalizes whitespace and adjacent duplicate lines", () => {
  const result = withPage(
    { innerText: "  标题  \n标题\n\n\n 正文\u00a0内容 \n" },
    () => extractPageContent()
  );

  assert.equal(result.text, "标题\n\n正文 内容");
});

test("extractPageContent keeps the length guard for very long pages", () => {
  const result = withPage(
    { innerText: "长".repeat(80_010) },
    () => extractPageContent()
  );

  assert.equal(result.text.length, 80_000);
  assert.equal(result.originalLength, 80_010);
  assert.equal(result.truncated, true);
});

test("local files use the filename when the document has no title", () => {
  const result = withPage(
    {
      title: "",
      url: "file:///Users/test/%E7%AC%94%E8%AE%B0.md",
      innerText: "# 本地 Markdown"
    },
    () => extractPageContent()
  );

  assert.equal(result.title, "笔记.md");
  assert.equal(result.text, "# 本地 Markdown");
});

test("extractPageContent includes text from open shadow roots", () => {
  const shadowRoot = {
    children: [{ innerText: "Shadow 日志内容" }],
    querySelectorAll() {
      return [];
    }
  };
  const host = { shadowRoot };

  const result = withPage({ innerText: "普通页面" }, () => {
    globalThis.document.querySelectorAll = (selector) => {
      if (selector === "*") return [host];
      return [];
    };
    return extractPageContent();
  });

  assert.match(result.text, /普通页面/);
  assert.match(result.text, /Shadow 日志内容/);
  assert.equal(result.shadowRootCount, 1);
});

test("extractPageContent reports embedded frames and canvases", () => {
  const result = withPage({ innerText: "页面" }, () => {
    globalThis.document.querySelectorAll = (selector) => {
      if (selector === "iframe, frame") return [{}, {}];
      if (selector === "canvas") return [{}];
      return [];
    };
    return extractPageContent();
  });

  assert.equal(result.embeddedFrameCount, 2);
  assert.equal(result.canvasCount, 1);
});

test("mergePageContents combines the main page and accessible frames", () => {
  const page = mergePageContents([
    {
      frameId: 0,
      result: {
        title: "流水线",
        url: "https://example.com/run",
        text: "运行成功",
        originalLength: 4,
        embeddedFrameCount: 1
      }
    },
    {
      frameId: 8,
      result: {
        title: "任务日志",
        url: "https://logs.example.com/task",
        text: "callback SUCCESS",
        originalLength: 16,
        shadowRootCount: 1,
        canvasCount: 1
      }
    }
  ]);

  assert.equal(page.title, "流水线");
  assert.match(page.text, /运行成功/);
  assert.match(page.text, /\[嵌入页面：任务日志\]/);
  assert.match(page.text, /callback SUCCESS/);
  assert.equal(page.frameCount, 2);
  assert.equal(page.detectedDocumentCount, 2);
  assert.equal(page.shadowRootCount, 1);
  assert.equal(page.canvasCount, 1);
});

test("mergePageContents reports inaccessible detected frames", () => {
  const page = mergePageContents([
    {
      frameId: 0,
      result: {
        title: "页面",
        url: "https://example.com",
        text: "正文",
        embeddedFrameCount: 2
      }
    }
  ]);

  assert.equal(page.frameCount, 1);
  assert.equal(page.detectedDocumentCount, 3);
});
