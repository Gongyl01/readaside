import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotEvidenceTargets, validateEvidenceReport } from "../lib/evidence-report.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataset = JSON.parse(await readFile(
  resolve(projectRoot, "test/evaluation/evidence-reports.cases.json"),
  "utf8"
));

assert(
  dataset.schemaVersion === "readaside/evidence-report-evaluation/v1",
  "隐藏证据评测数据格式不受支持"
);
const targets = snapshotEvidenceTargets(dataset.targets);
let expectedAccepted = 0;
let accepted = 0;
let expectedRejected = 0;
let rejected = 0;
let passedCases = 0;

for (const item of dataset.cases) {
  const result = validateEvidenceReport(item.report, { targets });
  const expectedValid = Number(item.expectedValid || 0);
  const expectedInvalid = Number(item.expectedRejected || 0);
  expectedAccepted += expectedValid;
  accepted += result.valid.length;
  expectedRejected += expectedInvalid;
  rejected += result.rejected.length;
  const passed = result.valid.length === expectedValid && result.rejected.length === expectedInvalid;
  if (passed) passedCases += 1;
  console.log(`${passed ? "PASS" : "FAIL"} ${item.id} ${item.name}`);
}

console.log("");
console.log(`隐藏证据用例：${passedCases}/${dataset.cases.length}`);
console.log(`合法证据接受：${accepted}/${expectedAccepted}`);
console.log(`非法或歧义证据拦截：${rejected}/${expectedRejected}`);
console.log(`错误放行：${Math.max(0, accepted - expectedAccepted)}`);

if (passedCases !== dataset.cases.length) process.exitCode = 1;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
