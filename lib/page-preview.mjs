import { blockKindLabel } from "./context-retriever.mjs";
import { normalizeTableData, parseMarkdownTableText } from "./page-document.mjs";

export function buildPagePreviewModel(page) {
  const text = String(page?.text ?? "");
  const sentChars = text.length;
  const frameCount = toNonNegativeInteger(page?.frameCount, sentChars ? 1 : 0);
  const detectedDocumentCount = Math.max(
    frameCount,
    toNonNegativeInteger(page?.detectedDocumentCount, frameCount)
  );
  const shadowRootCount = toNonNegativeInteger(page?.shadowRootCount, 0);
  const canvasCount = toNonNegativeInteger(page?.canvasCount, 0);
  const blockCount = toNonNegativeInteger(
    page?.blockCount,
    Array.isArray(page?.blocks) ? page.blocks.length : 0
  );
  const blockTypeSummary = formatBlockTypeSummary(page?.blockTypeCounts);
  const warnings = [];

  if (page?.truncated) {
    warnings.push({
      level: "warning",
      text: "页面超过 8 万字符保护范围；完整文本和自动检索都只处理当前保留的部分。"
    });
  }

  const unreadableDocuments = Math.max(0, detectedDocumentCount - frameCount);
  if (unreadableDocuments > 0) {
    warnings.push({
      level: "warning",
      text: `检测到 ${unreadableDocuments} 个文档层未能读取，可能受到跨域或浏览器安全限制。`
    });
  }

  if (canvasCount > 0) {
    warnings.push({
      level: "warning",
      text: `检测到 ${canvasCount} 个 Canvas；其中肉眼可见的文字不会出现在当前文本中。`
    });
  }

  if (page?.structuredTruncated && !page?.truncated) {
    warnings.push({
      level: "warning",
      text: "结构化内容块超过 8 万字符保护范围，自动模式只能在当前保留的内容块中选择。"
    });
  }

  if (!warnings.length) {
    warnings.push({
      level: "success",
      text: "未发现明显的截断、不可访问文档层或 Canvas 读取限制。"
    });
  }

  return {
    text,
    countLabel: `${formatNumber(sentChars)} 字符`,
    blocks: sortBlocksForPreview(page?.blocks).map(buildBlockPreviewModel),
    stats: [
      { label: "完整页面文本", value: `${formatNumber(sentChars)} 字符` },
      { label: "文档层", value: `${frameCount}/${detectedDocumentCount}` },
      { label: "开放 Shadow DOM", value: formatNumber(shadowRootCount) },
      { label: "Canvas", value: formatNumber(canvasCount) },
      { label: "结构化内容块", value: `${formatNumber(blockCount)} 个` },
      { label: "内容块类型", value: blockTypeSummary }
    ],
    warnings
  };
}

export function buildContextPreviewModel(plan) {
  if (!plan || typeof plan !== "object") return null;
  const pageChars = toNonNegativeInteger(plan.pageChars, 0);
  const sentChars = toNonNegativeInteger(plan.sentChars, 0);
  const selectedBlockCount = toNonNegativeInteger(plan.selectedBlockCount, 0);
  const totalBlockCount = toNonNegativeInteger(plan.totalBlockCount, 0);
  const reductionPercent = toNonNegativeInteger(plan.reductionPercent, 0);
  const automaticallyKeptFull = plan.requestedMode === "auto" && plan.effectiveMode === "full";

  return {
    modeLabel: plan.effectiveMode === "retrieved"
      ? "自动选择"
      : plan.effectiveMode === "structured"
        ? "全部内容块"
      : automaticallyKeptFull
        ? "自动保留全文"
        : "结合全文",
    countLabel: `${formatNumber(sentChars)} / ${formatNumber(pageChars)} 字符`,
    summary: String(plan.reason || ""),
    stats: [
      { label: "本次页面上下文", value: `${formatNumber(sentChars)} 字符` },
      { label: "原页面文本", value: `${formatNumber(pageChars)} 字符` },
      { label: "采用内容块", value: `${formatNumber(selectedBlockCount)}/${formatNumber(totalBlockCount)}` },
      { label: "减少发送", value: reductionPercent > 0 ? `${reductionPercent}%` : "0%" }
    ],
    blocks: sortBlocksForPreview(plan.selectedBlocks).map(buildBlockPreviewModel)
  };
}

export function buildBlockPreviewModel(block) {
  const source = block?.source && typeof block.source === "object" ? block.source : {};
  const kind = String(block?.kind || "other");
  const headingPath = (Array.isArray(block?.headingPath) ? block.headingPath : [])
    .map((part) => String(part).trim())
    .filter(Boolean);
  const frameLabel = source.isMainFrame
    ? "主页面"
    : String(source.frameLabel || source.frameTitle || `Frame ${source.frameId ?? "?"}`).trim();
  const table = kind === "table"
    ? normalizeTableData(block?.table) || parseMarkdownTableText(block?.text)
    : null;

  return {
    id: String(block?.id || "未编号"),
    kind,
    kindLabel: blockKindLabel(kind),
    text: String(block?.text ?? ""),
    previewText: formatBlockPreviewText(block?.text, kind),
    headingLabel: headingPath.length ? headingPath.join(" › ") : "未归入标题",
    sourceLabel: source.rootKind === "shadow" ? `${frameLabel} · Shadow DOM` : frameLabel,
    reasons: (Array.isArray(block?.reasons) ? block.reasons : [])
      .map((reason) => String(reason).trim())
      .filter(Boolean),
    truncated: Boolean(block?.truncated),
    table
  };
}

function sortBlocksForPreview(value) {
  return (Array.isArray(value) ? value : [])
    .map((block, index) => ({ block, index }))
    .sort((left, right) => {
      const idDifference = blockIdOrder(left.block) - blockIdOrder(right.block);
      if (Number.isFinite(idDifference) && idDifference !== 0) return idDifference;

      const leftOrder = Number(left.block?.order);
      const rightOrder = Number(right.block?.order);
      if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) && leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.block);
}

function blockIdOrder(block) {
  const match = String(block?.id || "").match(/^B(\d+)$/);
  return match ? Number(match[1]) : Number.NaN;
}

export function formatBlockPreviewText(value, kind = "other") {
  const text = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");

  if (["code", "table", "input"].includes(String(kind))) {
    return text.replace(/^\n+|\n+$/g, "");
  }

  if (String(kind) === "list") {
    return text
      .split("\n")
      .map((line) => normalizePreviewLine(line))
      .filter(Boolean)
      .join("\n");
  }

  return text
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph
      .split("\n")
      .map((line) => normalizePreviewLine(line))
      .filter(Boolean)
      .join(" ")
    )
    .filter(Boolean)
    .join("\n\n")
    .replace(/\s+([，。！？；：、,.!?;:])/g, "$1")
    .trim();
}

function normalizePreviewLine(value) {
  return String(value ?? "").replace(/[ \t]+/g, " ").trim();
}

function toNonNegativeInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatBlockTypeSummary(value) {
  const counts = value && typeof value === "object" ? value : {};
  const labels = {
    heading: "标题",
    paragraph: "正文",
    list: "列表",
    table: "表格",
    code: "代码",
    quote: "引用",
    input: "输入",
    other: "其他"
  };
  const parts = Object.entries(labels)
    .map(([kind, label]) => [label, toNonNegativeInteger(counts[kind], 0)])
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label} ${formatNumber(count)}`);

  return parts.length ? parts.join(" · ") : "暂无";
}
