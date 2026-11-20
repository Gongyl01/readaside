export function parseOpenAiSseChunk(previousBuffer, chunk, flush = false) {
  const joined = `${previousBuffer ?? ""}${chunk ?? ""}`;
  const lines = joined.split(/\r?\n/);
  const buffer = flush ? "" : lines.pop() ?? "";
  const events = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith(":") || line.startsWith("event:")) continue;
    const data = line.startsWith("data:") ? line.slice(5).trim() : line.startsWith("{") ? line : "";
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed?.error) {
        events.push({ type: "error", error: String(parsed.error.message ?? "模型服务返回错误。") });
        continue;
      }
      const choice = parsed?.choices?.[0];
      const content = choice?.delta?.content ?? choice?.message?.content;
      if (typeof content === "string" && content) events.push({ type: "delta", delta: content });
    } catch {
      events.push({ type: "malformed", data });
    }
  }

  return { buffer, events };
}
