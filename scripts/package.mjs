import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const releaseRoot = join(projectRoot, "release");
const bundleName = `readaside-${packageJson.version}`;
const stagingDirectory = join(releaseRoot, bundleName);
const archivePath = join(releaseRoot, `${bundleName}.zip`);

const entries = [
  "manifest.json",
  "background.mjs",
  "sidepanel.html",
  "sidepanel.css",
  "sidepanel.mjs",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "PRIVACY.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "lib",
  "dist",
  "licenses",
  "docs"
];

await mkdir(releaseRoot, { recursive: true });
await rm(stagingDirectory, { recursive: true, force: true });
await rm(archivePath, { force: true });
await mkdir(stagingDirectory, { recursive: true });

for (const entry of entries) {
  await cp(join(projectRoot, entry), join(stagingDirectory, entry), { recursive: true });
}

try {
  await execFileAsync("zip", ["-qr", archivePath, bundleName], { cwd: releaseRoot });
} catch (error) {
  throw new Error("无法创建 zip，请确认系统已安装 zip 命令。", { cause: error });
}

console.log(`发布包已生成：${archivePath}`);
