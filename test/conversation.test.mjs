import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_STORED_HISTORY_MESSAGES,
  appendBoundedHistory,
  countConversationTurns
} from "../lib/conversation.mjs";

test("conversation history keeps only the newest 20 turns", () => {
  let history = [];
  for (let index = 1; index <= 30; index += 1) {
    history = appendBoundedHistory(history, `问题 ${index}`, `回答 ${index}`);
  }

  assert.equal(history.length, MAX_STORED_HISTORY_MESSAGES);
  assert.equal(countConversationTurns(history), 20);
  assert.equal(history[0].content, "问题 11");
  assert.equal(history.at(-1).content, "回答 30");
});
