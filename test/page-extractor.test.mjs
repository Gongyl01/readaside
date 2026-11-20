import test from "node:test";
import assert from "node:assert/strict";
import { extractPageContent, mergePageContents } from "../lib/page-extractor.mjs";

function withPage({ title = "测试页", url = "https://example.com", innerText, textContent = "" }, run) {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;

  const body = { tagName: "BODY", innerText, textContent, parentElement: null };
  globalThis.document = {
    title,
    body,
    documentElement: { tagName: "HTML", innerText, textContent, parentElement: null },
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
  assert.equal(result.schemaVersion, "readaside/frame-document/v1");
  assert.ok(result.blocks.length > 0);
  assert.ok(result.blocks.every((block) => block.kind !== "other"));
});

test("extractPageContent creates typed blocks with heading paths and locators", () => {
  const result = withPage(
    { innerText: "Architecture\n\nKDA uses channel-wise gates.\n\nconst x = 1;" },
    () => {
      const body = globalThis.document.body;
      const heading = fakeElement("H1", "Architecture", body);
      const paragraph = fakeElement("P", "KDA uses channel-wise gates.", body);
      const code = fakeElement("PRE", "const x = 1;", body);
      globalThis.document.querySelectorAll = (selector) => {
        if (selector.includes("h1") && selector.includes("blockquote")) {
          return [heading, paragraph, code];
        }
        return [];
      };
      return extractPageContent();
    }
  );

  assert.deepEqual(result.blocks.map((block) => block.kind), ["heading", "paragraph", "code"]);
  assert.deepEqual(result.blocks[1].headingPath, ["Architecture"]);
  assert.match(result.blocks[1].locator.structurePath, /body:nth-of-type\(1\).*p:nth-of-type\(1\)/);
  assert.equal(result.blocks[1].locator.textQuote.exact, "KDA uses channel-wise gates.");
  assert.equal(result.blocks[1].source.rootKind, "document");
});

test("arXiv HTML extraction preserves section roles and paragraph numbers through page merge", () => {
  const titleText = "A Paper About Context";
  const authorText = "Sample Author, Example University";
  const introText = "Introduction text that spans two content blocks. ".repeat(100).trim();
  const continuationText = "Continuation of the first paragraph.";
  const result = withPage({
    url: "https://arxiv.org/html/0000.00000v1",
    innerText: [titleText, authorText, "Abstract", "Brief overview.", "1Introduction", introText,
      continuationText, "Figure caption.", "Next paragraph."].join("\n\n")
  }, () => {
    const article = fakeElement("ARTICLE", "", globalThis.document.body);
    const title = fakeElement("H1", titleText, article);
    const authors = fakeElement("DIV", authorText, article);
    const abstract = fakeElement("DIV", "", article);
    const introduction = fakeElement("SECTION", "", article);
    const abstractHeading = fakeElement("H6", "Abstract", abstract);
    const summary = fakeElement("P", "Brief overview.", abstract);
    const introHeading = fakeElement("H2", "1Introduction", introduction);
    const paragraphGroup = fakeElement("DIV", "", introduction);
    const first = fakeElement("P", introText, paragraphGroup);
    const continuation = fakeElement("P", continuationText, paragraphGroup);
    const caption = fakeElement("FIGCAPTION", "Figure caption.", introduction);
    const second = fakeElement("P", "Next paragraph.", introduction);
    const nodes = [title, authors, abstractHeading, summary, introHeading, first, continuation, caption, second];
    globalThis.document.querySelectorAll = (selector) => {
      if (selector === "article.ltx_document") return [article];
      return selector.includes("blockquote") ? nodes : [];
    };
    article.querySelectorAll = (selector) => ({
      ":scope > .ltx_title_document": [title],
      ":scope > .ltx_authors": [authors],
      ":scope > .ltx_abstract": [abstract],
      ":scope > section.ltx_section": [introduction]
    }[selector] || []);
    abstract.querySelectorAll = (selector) => selector.includes("p.ltx_p") ? [summary] : [abstractHeading];
    introduction.querySelectorAll = (selector) => selector.includes("p.ltx_p") ? [paragraphGroup, second] : [introHeading];
    paragraphGroup.querySelectorAll = () => [first, continuation];
    return extractPageContent();
  });

  const page = mergePageContents([{ frameId: 0, result }]);
  assert.equal(page.documentFormat, "web");
  assert.equal(page.documentType, "paper");
  assert.deepEqual(page.blocks.map((item) => item.paper), [
    { role: "title" }, { role: "authors" },
    { role: "abstract" }, { role: "abstract", paragraph: 1 },
    { role: "introduction" }, { role: "introduction", paragraph: 1 },
    { role: "introduction", paragraph: 1 }, { role: "introduction", paragraph: 1 },
    undefined, { role: "introduction", paragraph: 2 }
  ]);
});

test("extractPageContent filters list items from structural navigation regions", () => {
  const result = withPage(
    { innerText: "Issues\n代码评审\n持续集成\nWiki\n报表" },
    () => {
      const body = globalThis.document.body;
      const navigation = fakeElement("NAV", "Issues\n代码评审\n持续集成", body, {
        "aria-label": "Repository"
      });
      const tablist = fakeElement("DIV", "Wiki\n报表", body, { role: "tablist" });
      const items = [
        ...["Issues", "代码评审", "持续集成"]
          .map((text) => fakeElement("LI", text, navigation)),
        ...["Wiki", "报表"].map((text) => fakeElement("LI", text, tablist))
      ];
      globalThis.document.querySelectorAll = (selector) => (
        selector.includes("[role='listitem']") ? items : []
      );
      return extractPageContent();
    }
  );

  assert.match(result.text, /^Issues\n代码评审/);
  assert.deepEqual(result.blocks, []);
});

test("extractPageContent keeps meaningful short lists outside navigation regions", () => {
  const result = withPage(
    { innerText: "是\n否\n1%" },
    () => {
      const body = globalThis.document.body;
      const list = fakeElement("UL", "是\n否\n1%", body);
      const items = ["是", "否", "1%"]
        .map((text) => fakeElement("LI", text, list));
      globalThis.document.querySelectorAll = (selector) => (
        selector.includes("[role='listitem']") ? items : []
      );
      return extractPageContent();
    }
  );

  assert.deepEqual(result.blocks.map((block) => block.text), ["是", "否", "1%"]);
  assert.ok(result.blocks.every((block) => block.kind === "list"));
});

test("extractPageContent filters punctuation-only list noise outside navigation regions", () => {
  const result = withPage(
    { innerText: "/\n..." },
    () => {
      const body = globalThis.document.body;
      const list = fakeElement("UL", "/\n...", body);
      const items = ["/", "..."].map((text) => fakeElement("LI", text, list));
      globalThis.document.querySelectorAll = (selector) => (
        selector.includes("[role='listitem']") ? items : []
      );
      return extractPageContent();
    }
  );

  assert.match(result.text, /^\/\n\.\.\./);
  assert.deepEqual(result.blocks, []);
});

test("extractPageContent stores simple native table rows and cells", () => {
  const result = withPage(
    { innerText: "指标 数值\nRecall@K 85%" },
    () => {
      const body = globalThis.document.body;
      const table = fakeElement("TABLE", "指标 数值\nRecall@K 85%", body);
      table.rows = [
        fakeTableRow(table, [["TH", "指标"], ["TH", "数值"]]),
        fakeTableRow(table, [["TD", "Recall@K"], ["TD", "85%"]])
      ];
      globalThis.document.querySelectorAll = (selector) => (
        selector.includes("table") && selector.includes("blockquote") ? [table] : []
      );
      return extractPageContent();
    }
  );

  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].kind, "table");
  assert.deepEqual(result.blocks[0].table, {
    rows: [
      { cells: [{ text: "指标", header: true }, { text: "数值", header: true }] },
      { cells: [{ text: "Recall@K", header: false }, { text: "85%", header: false }] }
    ]
  });
});

test("extractPageContent falls back to table text for merged cells", () => {
  const result = withPage(
    { innerText: "分类\nA 1\nB 2" },
    () => {
      const body = globalThis.document.body;
      const table = fakeElement("TABLE", "分类\nA 1\nB 2", body);
      const firstRow = fakeTableRow(table, [["TH", "分类"], ["TH", "数值"]]);
      firstRow.cells[0].rowSpan = 2;
      firstRow.cells[0].getAttribute = (name) => name === "rowspan" ? "2" : null;
      table.rows = [
        firstRow,
        fakeTableRow(table, [["TD", "A"], ["TD", "1"]])
      ];
      globalThis.document.querySelectorAll = (selector) => (
        selector.includes("table") && selector.includes("blockquote") ? [table] : []
      );
      return extractPageContent();
    }
  );

  assert.equal(result.blocks[0].kind, "table");
  assert.equal(result.blocks[0].text, "分类\nA 1\nB 2");
  assert.equal(result.blocks[0].table, undefined);
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
  assert.ok(result.blocks.every((block) => block.text.length <= 4_000));
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

test("local Markdown becomes heading, paragraph, list and code blocks", () => {
  const result = withPage(
    {
      title: "",
      url: "file:///Users/test/notes.md",
      innerText: [
        "# Context Engine",
        "",
        "正文内容。",
        "",
        "- 第一项",
        "",
        "```js",
        "const answer = 42;",
        "```"
      ].join("\n")
    },
    () => extractPageContent()
  );

  assert.equal(result.documentFormat, "markdown");
  assert.deepEqual(
    result.blocks.map((block) => block.kind),
    ["heading", "paragraph", "list", "code"]
  );
  assert.deepEqual(result.blocks[3].headingPath, ["Context Engine"]);
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
  const shadowBlock = result.blocks.find((block) => block.source.rootKind === "shadow");
  assert.equal(shadowBlock.text, "Shadow 日志内容");
  assert.equal(shadowBlock.source.shadowDepth, 1);
  assert.equal(shadowBlock.locator.shadowPath.length, 1);
});

test("extractPageContent ignores injected styles inside open shadow roots", () => {
  const css = ":root { --immersive-translate-theme-underline-borderColor: #72ece9; }";
  const wrapper = fakeElement("DIV", `${css}\n可见译文`, null);
  const style = fakeElement("STYLE", css, wrapper);
  const translation = fakeElement("P", "可见译文", wrapper);
  wrapper.children = [style, translation];
  const shadowRoot = {
    children: [wrapper],
    querySelectorAll() { return []; }
  };
  const result = withPage({ innerText: "Building effective agents" }, () => {
    const host = { shadowRoot };
    globalThis.document.querySelectorAll = (selector) => selector === "*" ? [host] : [];
    return extractPageContent();
  });

  assert.match(result.text, /可见译文/);
  assert.doesNotMatch(result.text, /immersive-translate/);
  assert.ok(result.blocks.every((block) => !block.text.includes("immersive-translate")));
});

test("extractPageContent removes stylesheet text if a page exposes it through body.innerText", () => {
  const css = ":root { --immersive-translate-theme-underline-borderColor: #72ece9; }";
  const result = withPage({ innerText: `Building effective agents\n${css}` }, () => {
    const body = globalThis.document.body;
    const style = fakeElement("STYLE", css, body);
    const article = fakeElement("ARTICLE", "Building effective agents", body);
    body.children = [article, style];
    body.querySelectorAll = (selector) => selector.includes("style") ? [style] : [];
    return extractPageContent();
  });

  assert.equal(result.text, "Building effective agents");
  assert.ok(result.blocks.every((block) => !block.text.includes("immersive-translate")));
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
  assert.equal(page.schemaVersion, "readaside/page-document/v1");
  assert.match(page.captureId, /\S+/);
  assert.equal(page.blocks[0].id, "B0001");
  assert.equal(page.blocks.at(-1).source.frameId, 8);
  assert.equal(page.blockCount, page.blocks.length);
  assert.equal(page.diagnostics.blockCount, page.blocks.length);
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

function fakeElement(tagName, innerText, parentElement, attributes = {}) {
  return {
    tagName,
    innerText,
    textContent: innerText,
    parentElement,
    previousElementSibling: null,
    hidden: false,
    isContentEditable: false,
    getAttribute(name) {
      return attributes[name] ?? null;
    }
  };
}

function fakeTableRow(table, cellValues) {
  const row = fakeElement("TR", cellValues.map(([, text]) => text).join(" "), table);
  row.cells = cellValues.map(([tagName, text]) => {
    const cell = fakeElement(tagName, text, row);
    cell.rowSpan = 1;
    cell.colSpan = 1;
    return cell;
  });
  row.children = row.cells;
  return row;
}
