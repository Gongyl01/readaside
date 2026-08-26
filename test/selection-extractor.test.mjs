import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSelectionContent,
  mergeSelectionContents
} from "../lib/selection-extractor.mjs";

function withSelection({ selectionText = "", activeElement = null }, run) {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousGetSelection = globalThis.getSelection;

  globalThis.document = {
    title: "测试文章",
    activeElement
  };
  globalThis.location = { href: "https://example.com/article" };
  globalThis.getSelection = () => ({ toString: () => selectionText });

  try {
    return run();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;

    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;

    if (previousGetSelection === undefined) delete globalThis.getSelection;
    else globalThis.getSelection = previousGetSelection;
  }
}

test("extractSelectionContent reads and normalizes a document selection", () => {
  const selection = withSelection(
    { selectionText: "  第一行  \n\n\n 第二行\u00a0内容 " },
    () => extractSelectionContent()
  );

  assert.equal(selection.text, "第一行\n\n第二行 内容");
  assert.equal(selection.url, "https://example.com/article");
  assert.equal(selection.truncated, false);
});

test("extractSelectionContent reads selections inside text controls", () => {
  const selection = withSelection(
    {
      activeElement: {
        tagName: "TEXTAREA",
        value: "前面需要解释的文字后面",
        selectionStart: 2,
        selectionEnd: 9
      }
    },
    () => extractSelectionContent()
  );

  assert.equal(selection.text, "需要解释的文字");
});

test("mergeSelectionContents combines unique selections from accessible frames", () => {
  const selection = mergeSelectionContents([
    {
      frameId: 0,
      result: { title: "文章", text: "顶层选区", truncated: false }
    },
    {
      frameId: 5,
      result: { title: "日志", text: "iframe 选区", truncated: false }
    },
    {
      frameId: 6,
      result: { title: "重复内容", text: "iframe 选区", truncated: false }
    }
  ]);

  assert.match(selection.text, /^顶层选区/);
  assert.match(selection.text, /\[选区来源：日志\]/);
  assert.match(selection.text, /iframe 选区/);
  assert.equal(selection.sourceCount, 2);
});

test("selection extraction and merging enforce the 20,000 character limit", () => {
  const extracted = withSelection(
    { selectionText: "选".repeat(20_010) },
    () => extractSelectionContent()
  );
  const merged = mergeSelectionContents([{ frameId: 0, result: extracted }]);

  assert.equal(extracted.text.length, 20_000);
  assert.equal(extracted.truncated, true);
  assert.equal(merged.text.length, 20_000);
  assert.equal(merged.truncated, true);
});
