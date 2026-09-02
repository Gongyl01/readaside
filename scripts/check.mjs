import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
  ".gitignore",
  "manifest.json",
  "background.mjs",
  "sidepanel.html",
  "sidepanel.css",
  "sidepanel.mjs",
  "lib/conversation.mjs",
  "lib/block-citations.mjs",
  "lib/context-retriever.mjs",
  "lib/deepseek.mjs",
  "lib/input.mjs",
  "lib/markdown.mjs",
  "lib/markdown-parser.mjs",
  "lib/page-extractor.mjs",
  "lib/page-document.mjs",
  "lib/page-preview.mjs",
  "lib/port-client.mjs",
  "lib/request-error.mjs",
  "lib/selection-extractor.mjs",
  "lib/tab-access.mjs",
  "scripts/evaluate-context.mjs",
  "scripts/evaluate-citations.mjs",
  "dist/markdown-renderer.mjs",
  "dist/markdown-renderer.css",
  "test/fixtures/context/technical-doc.html",
  "test/fixtures/context/technical-doc.json",
  "test/fixtures/context/long-article.html",
  "test/fixtures/context/long-article.json",
  "test/fixtures/context/complex-dom.html",
  "test/fixtures/context/complex-dom.json",
  "test/evaluation/technical-doc.questions.json",
  "test/evaluation/long-article.questions.json",
  "test/evaluation/complex-dom.questions.json",
  "test/evaluation/block-citations.cases.json",
  "docs/evaluation/baseline-0.9.0.md",
  "docs/evaluation/retrieval-baseline-0.9.1.md",
  "docs/evaluation/evaluation-0.9.2.md",
  "docs/evaluation/citation-validation-0.10.0.md",
  "docs/evaluation/README.md",
  "docs/evaluation/manual-validation-template.md",
  "docs/evaluation/snapshots/0.9.2.json",
  "README.md",
  "PRIVACY.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "licenses/DOMPURIFY-APACHE-2.0.txt",
  "licenses/KATEX-MIT.txt",
  "licenses/MARKED-LICENSE.txt",
  "licenses/MARKED-FOOTNOTE-MIT.txt",
  ".github/workflows/ci.yml"
];

const contents = new Map();
for (const relativePath of requiredFiles) {
  contents.set(relativePath, await readFile(resolve(projectRoot, relativePath), "utf8"));
}

const manifest = JSON.parse(contents.get("manifest.json"));
const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
const screenshot = await stat(resolve(projectRoot, "docs/screenshots/readaside-hero.png"));

assert(manifest.manifest_version === 3, "manifest_version 必须为 3");
assert(manifest.name.startsWith("ReadAside"), "扩展名称必须使用 ReadAside");
assert(manifest.version === packageJson.version, "Manifest 与 package.json 版本必须一致");
assert(packageJson.license === "MIT", "package.json 必须声明 MIT 许可证");
assert(screenshot.size > 10_000, "README 截图缺失或内容异常");
assert(manifest.side_panel?.default_path === "sidepanel.html", "缺少 side panel 配置");
assert(manifest.background?.service_worker === "background.mjs", "缺少 service worker 配置");
assert(!manifest.content_scripts, "页面读取必须按用户操作注入，不允许常驻 content script");
assert(!manifest.externally_connectable, "不允许网页直接连接扩展");
assert(!manifest.host_permissions?.includes("<all_urls>"), "不允许申请 <all_urls>");
assert(
  JSON.stringify(manifest.host_permissions) ===
    JSON.stringify(["https://api.deepseek.com/*", "file:///*"]),
  "固定访问权限只能包含 DeepSeek API 和本地文件"
);
assert(
  JSON.stringify(manifest.optional_host_permissions) ===
    JSON.stringify(["http://*/*", "https://*/*"]),
  "普通网页必须通过可选权限申请"
);

const gitignore = contents.get(".gitignore");
assert(/^node_modules\/$/m.test(gitignore), ".gitignore 必须排除 node_modules");
assert(/^release\/$/m.test(gitignore), ".gitignore 必须排除 release 产物");

const sourceText = [
  contents.get("background.mjs"),
  contents.get("sidepanel.html"),
  contents.get("sidepanel.mjs"),
  ...[...contents.entries()]
    .filter(([name]) => name.startsWith("lib/"))
    .map(([, content]) => content)
].join("\n");

const sidepanelHtml = contents.get("sidepanel.html");
const sidepanelScript = contents.get("sidepanel.mjs");
const queriedElementIds = [...sidepanelScript.matchAll(/document\.querySelector\("#([A-Za-z][\w-]*)"\)/g)]
  .map((match) => match[1]);
for (const id of queriedElementIds) {
  assert(
    new RegExp(`id=["']${id}["']`).test(sidepanelHtml),
    `sidepanel.mjs 引用了不存在的界面元素：#${id}`
  );
}

const declaredElementIds = [...sidepanelHtml.matchAll(/\sid=["']([^"']+)["']/g)]
  .map((match) => match[1]);
assert(
  new Set(declaredElementIds).size === declaredElementIds.length,
  "sidepanel.html 中存在重复 id"
);

assert(!/backend-api\//.test(sourceText), "不允许调用网页内部 API");
assert(!/https:\/\/(?:cdn|unpkg|jsdelivr)\./.test(sourceText), "运行时依赖必须本地打包，不允许使用 CDN");
assert(
  contents.get("THIRD_PARTY_NOTICES.md").includes(`| DOMPurify | ${packageJson.dependencies.dompurify} |`),
  "第三方许可证清单中的 DOMPurify 版本必须与依赖一致"
);
assert(
  contents.get("dist/markdown-renderer.mjs").includes(`DOMPurify ${packageJson.dependencies.dompurify}`),
  "dist 中的 DOMPurify 版本不是当前锁定版本，请重新构建"
);

const textFiles = await collectTextFiles(projectRoot);
const secretPatterns = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /AIza[0-9A-Za-z_-]{30,}/
];

for (const filePath of textFiles) {
  const text = await readFile(filePath, "utf8");
  assert(
    !secretPatterns.some((pattern) => pattern.test(text)),
    `文件中疑似包含凭证：${relative(projectRoot, filePath)}`
  );
}

console.log(
  `检查通过：${requiredFiles.length} 个必要文件，${textFiles.length} 个文本文件；版本、权限、许可证和凭证检查正常。`
);

async function collectTextFiles(directory) {
  const ignoredDirectories = new Set([".git", "node_modules", "release"]);
  const textExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".mjs", ".txt", ".yaml", ".yml"]);
  const files = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTextFiles(entryPath));
    else if (textExtensions.has(extname(entry.name))) files.push(entryPath);
  }

  return files;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
