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
  const warnings = [];

  if (page?.truncated) {
    warnings.push({
      level: "warning",
      text: "内容超过 8 万字符，模型只会收到预览中显示的截断版本。"
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

  if (!warnings.length) {
    warnings.push({
      level: "success",
      text: "未发现明显的截断、不可访问文档层或 Canvas 读取限制。"
    });
  }

  return {
    text,
    countLabel: `${formatNumber(sentChars)} 字符`,
    stats: [
      { label: "发送给模型", value: `${formatNumber(sentChars)} 字符` },
      { label: "文档层", value: `${frameCount}/${detectedDocumentCount}` },
      { label: "开放 Shadow DOM", value: formatNumber(shadowRootCount) },
      { label: "Canvas", value: formatNumber(canvasCount) }
    ],
    warnings
  };
}

function toNonNegativeInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value);
}
