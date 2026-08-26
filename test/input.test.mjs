import test from "node:test";
import assert from "node:assert/strict";
import { shouldSubmitOnEnter } from "../lib/input.mjs";

test("Enter submits only when an IME composition is not active", () => {
  assert.equal(shouldSubmitOnEnter({ key: "Enter", shiftKey: false }), true);
  assert.equal(shouldSubmitOnEnter({ key: "Enter", shiftKey: true }), false);
  assert.equal(shouldSubmitOnEnter({ key: "Enter", isComposing: true }), false);
  assert.equal(shouldSubmitOnEnter({ key: "Enter", keyCode: 229 }), false);
  assert.equal(shouldSubmitOnEnter({ key: "Enter" }, true), false);
  assert.equal(shouldSubmitOnEnter({ key: "a" }), false);
});
