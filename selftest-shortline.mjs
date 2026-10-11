import { detectDegeneration, normalizeConfig } from "./lib/detector.js";
import assert from "node:assert/strict";
const cfg = normalizeConfig({});

// Case 1: the previously-missed sample — "循环甲乙丙丁" (6 chars < minLineLength 8)
// repeated ~80 times as separate lines. ngram ratio was 0.1377 > 0.12, line-cycle filtered.
const missed = Array(80).fill("循环甲乙丙丁").join("\n");
const r1 = detectDegeneration(missed, cfg, "text");
console.log("case1 (should hit line-cycle):", r1?.reason, r1?.sample?.slice(0, 30), "ratio=", r1?.ratio?.toFixed(4));

// Case 2: short line repeated only 7 times (< shortLineRepeatThreshold 8) — should stay null.
const few = Array(7).fill("循环甲乙丙丁").join("\n") + "\n" + "正常的一行正文内容足够长。".repeat(20);
const r2 = detectDegeneration(few, cfg, "text");
console.log("case2 (should be null):", r2?.reason ?? "null");

// Case 3: normal prose — must stay null.
const prose = "这是一段正常的正文内容，讨论系统架构与模块划分，没有重复。".repeat(10);
const r3 = detectDegeneration(prose, cfg, "text");
console.log("case3 (should be null):", r3?.reason ?? "null");

// Case 4: reasoning channel unchanged — still hits with its own thresholds.
const think = Array(61).fill("执行。").join("\n");
const r4 = detectDegeneration(think, cfg, "reasoning");
console.log("case4 (should hit reasoning line-cycle):", r4?.reason);

// Case 5: short identical lines but varied others interleaved — should be null.
const mixed = [];
for (let i = 0; i < 10; i++) { mixed.push("等一下。"); mixed.push(`第${i}条各不相同的较长叙述内容在这里。`); }
const r5 = detectDegeneration(mixed.join("\n"), cfg, "text");
console.log("case5 (should be null):", r5?.reason ?? "null");

assert.equal(r1?.reason, "line-cycle", "case1: repeated short lines");
assert.equal(r1?.channel, "text");
assert.equal(r1?.sample, "循环甲乙丙丁");
assert.equal(r2, null, "case2: below short-line threshold");
assert.equal(r3, null, "case3: prose sample");
assert.equal(r4?.reason, "line-cycle", "case4: reasoning repetition");
assert.equal(r4?.channel, "reasoning");
assert.equal(r5, null, "case5: short filler with progressing content");
console.log("5/5 short-line scenarios passed");
