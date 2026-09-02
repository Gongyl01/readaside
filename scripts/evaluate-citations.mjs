import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateBlockCitations } from "../lib/block-citations.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const datasetPath = resolve(projectRoot, "test/evaluation/block-citations.cases.json");
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));

assert(
  dataset.schemaVersion === "readaside/block-citation-evaluation/v1",
  "块引用评测集 schemaVersion 不受支持"
);
assert(Array.isArray(dataset.cases) && dataset.cases.length, "块引用评测集不能为空");

const pageBlocks = (Array.isArray(dataset.pageBlockIds) ? dataset.pageBlockIds : [])
  .map((id) => ({ id }));
const results = dataset.cases.map((evaluationCase) => {
  const validation = validateBlockCitations(evaluationCase.answer, {
    sentBlocks: dataset.sentBlocks,
    pageBlocks
  });
  const actual = validation.references.map(({ id, status }) => ({ id, status }));
  const expected = Array.isArray(evaluationCase.expected) ? evaluationCase.expected : [];
  return {
    id: String(evaluationCase.id || "unnamed"),
    passed: JSON.stringify(actual) === JSON.stringify(expected),
    expected,
    actual
  };
});

const passedCount = results.filter((result) => result.passed).length;
const invalidReferences = results.flatMap((result) => result.actual)
  .filter((reference) => reference.status !== "valid");
const expectedInvalidCount = results.flatMap((result) => result.expected)
  .filter((reference) => reference.status !== "valid").length;
const falseValidCount = results.reduce((total, result) => {
  const expectedStatuses = new Map(result.expected.map((item) => [item.id, item.status]));
  return total + result.actual.filter(
    (item) => item.status === "valid" && expectedStatuses.get(item.id) !== "valid"
  ).length;
}, 0);

console.log("ReadAside 块引用确定性评测");
console.log(`用例通过：${passedCount}/${results.length}`);
console.log(`无效引用被拦截：${invalidReferences.length}/${expectedInvalidCount}`);
console.log(`错误放行：${falseValidCount}`);
for (const result of results.filter((item) => !item.passed)) {
  console.log(`FAIL ${result.id}`);
  console.log(`  预期：${JSON.stringify(result.expected)}`);
  console.log(`  实际：${JSON.stringify(result.actual)}`);
}

if (passedCount !== results.length || falseValidCount !== 0) process.exitCode = 1;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
