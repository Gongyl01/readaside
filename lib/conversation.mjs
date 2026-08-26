export const MAX_STORED_HISTORY_MESSAGES = 40;
export const MAX_RENDERED_MESSAGES = 40;

export function appendBoundedHistory(history, question, answer, limit = MAX_STORED_HISTORY_MESSAGES) {
  const safeHistory = Array.isArray(history) ? history : [];
  const next = [
    ...safeHistory,
    { role: "user", content: String(question ?? "") },
    { role: "assistant", content: String(answer ?? "") }
  ].filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      String(message.content ?? "").trim()
  );
  return next.slice(-normalizeLimit(limit));
}

export function countConversationTurns(history) {
  if (!Array.isArray(history)) return 0;
  return history.filter((message) => message?.role === "user").length;
}

function normalizeLimit(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 2) return MAX_STORED_HISTORY_MESSAGES;
  return number;
}
