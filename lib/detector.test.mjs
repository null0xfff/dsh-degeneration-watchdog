import { detectDegeneration, findLineCycle, normalizeConfig } from "./detector.js";
import assert from "node:assert/strict";
import fs from "node:fs";
const cfg = normalizeConfig({});
const cases = [];
// normal text channel
const vocab = ["架构演进","模块边界","依赖方向","状态机迁移","并发安全","缓存失效","事务边界","幂等性保证","错误传播","资源回收"];
let normal = Array.from({length: 60}, (_, i) => `第${i}章讨论${vocab[i % vocab.length]}问题，给出的方案是结合${vocab[(i*3+1) % vocab.length]}与${vocab[(i*7+2) % vocab.length]}在实践中折中，并附带了三个不同规模下的基准数据结论。`).join("\n");
cases.push(["normal-text", normal, "text", false]);
// line loop period 1 (long line, 12 repeats)
let loop1 = Array.from({length: 12}, () => "现在我们来看看这个函数的实现细节，重点关注参数校验和错误处理路径与边界条件的覆盖情况").join("\n");
cases.push(["loop-period-1", loop1, "text", true]);
// line loop period 3
const pat = ["首先解析输入并构建语法树的根节点结构", "然后执行变换矩阵运算得到中间表示", "最后将优化后的结果输出到目标缓冲区"];
let loop3 = Array.from({length: 12}, () => pat.join("\n")).join("\n");
cases.push(["loop-period-3", loop3, "text", true]);
// repeated paragraph without newlines
let para = "该模块负责处理用户请求并返回响应数据结构，同时维护会话状态的一致性约束。".repeat(25);
cases.push(["para-collapse", para, "text", true]);
// templated code should NOT trigger on text channel
let code = Array.from({length: 40}, (_, i) => `  mov eax, ${i} ; load register value from offset table`).join("\n");
cases.push(["code-varied", code, "text", false]);

// --- reasoning channel: synthetic sample matching the observed degradation
// pattern (short-line cycle), sanitized — no real conversation content ---
const realSample = ["执行。","好。","(执行。)","好。"];
let reasoningLoop = Array.from({length: 100}, () => realSample.join("\n")).join("\n");
cases.push(["reasoning-real-sample", reasoningLoop, "reasoning", true]);
// same short-line pattern, but only 2 cycles -> must NOT trigger (threshold 5)
let reasoningShort = Array.from({length: 2}, () => realSample.join("\n")).join("\n");
cases.push(["reasoning-2-cycles-noise", reasoningShort, "reasoning", false]);
// normal reasoning: varied deliberation, short sentences
let reasoningNormal = Array.from({length: 80}, (_, i) => `先验证第${i}步的前提：输入${vocab[i % vocab.length]}是否满足约束，再决定走快路径还是回退到保守实现。`).join("\n");
cases.push(["reasoning-normal", reasoningNormal, "reasoning", false]);
// reasoning without newlines, degenerate repeat
let reasoningPara = "我应该先检查这个条件然后决定是否继续执行下一步操作流程。".repeat(30);
cases.push(["reasoning-para-collapse", reasoningPara, "reasoning", true]);
// --- cross-language: English degradation, same structure as the captured sample ---
const enSample = ["Execute.", "OK.", "(Execute.)", "OK."];
let enLoop = Array.from({length: 100}, () => enSample.join("\n")).join("\n");
cases.push(["reasoning-english-loop", enLoop, "reasoning", true]);
// English single-line loop
let enLoop1 = Array.from({length: 30}, () => "Let me verify the function signature once more before proceeding").join("\n");
cases.push(["reasoning-english-single", enLoop1, "reasoning", true]);
// English paragraph collapse without newlines
let enPara = "I should check the input constraints first and then decide whether to continue. ".repeat(30);
cases.push(["reasoning-english-para", enPara, "reasoning", true]);
// normal English deliberation must NOT trigger (realistic variety: numbers vary per line)
let enNormal = Array.from({length: 60}, (_, i) => `Step ${i}: consider parser edge case ${i % 7} against cache entry ${i * 13 % 29}, measure against the ${i % 3 === 0 ? "fast" : "conservative"} baseline from run ${1000 + i}, and note the delta of ${(i * 17 % 90) / 10}ms before choosing the implementation path.`).join("\n");
cases.push(["reasoning-english-normal", enNormal, "reasoning", false]);
// mixed-language loop (Chinese/English interleaved)
let mixLoop = Array.from({length: 40}, () => "Execute.\n好。\n(Execute.)\n好。").join("\n");
cases.push(["reasoning-mixed-loop", mixLoop, "reasoning", true]);
// real captured edge case: heavy filler ("Hmm。"/"让me…") but content keeps
// progressing — must NOT trigger. Sample is a sanitized synthetic rewrite
// (file sits next to this test).
let filler = fs.readFileSync(new URL("./filler-sample.txt", import.meta.url), "utf8");
cases.push(["reasoning-filler-progressing", filler, "reasoning", false]);
// edge case: heavy short-line filler period-2 alternation "好。/执行。" with no
// content between repetitions — stalled, must trigger
let altLoop = "任务确认：列表已就绪。\n\n先核对输入清单。\n\n执行。\n\n好。\n\n" + "好。\n\n执行。\n\n".repeat(60);
cases.push(["reasoning-alternation-loop", altLoop, "reasoning", true]);
// same alternation but only 4 cycles (< threshold 5) — must NOT trigger yet
let altShort = "先确认状态。\n\n" + "好。\n\n执行。\n\n".repeat(4);
cases.push(["reasoning-alternation-4-cycles", altShort, "reasoning", false]);

const repeatedLong = "现在我们来看看这个函数的实现细节，重点关注参数校验和错误处理路径与边界条件的覆盖情况";
for (const channel of ["text", "reasoning"]) {
  const labels = Array.from({ length: 10 }, (_, i) => [`标签${i}`, repeatedLong]).flat();
  const chars = Array.from({ length: 10 }, (_, i) => [String.fromCharCode(65 + i), repeatedLong]).flat();
  const minLength = channel === "reasoning" ? cfg.reasoningMinTextLength : cfg.minTextLength;
  assert.ok(labels.join("\n").length >= minLength);
  assert.ok(chars.join("\n").length >= minLength);
  const labelCfg = channel === "reasoning" ? normalizeConfig({ reasoningMinLineLength: 4 }) : cfg;
  cases.push([`${channel}-changing-short-labels`, labels.join("\n"), channel, false, labelCfg]);
  cases.push([`${channel}-changing-single-characters`, chars.join("\n"), channel, false]);
}
cases.push(["long-loop-with-blank-lines", Array(12).fill(repeatedLong).join("\n \t\n"), "text", true]);
cases.push(["short-loop-with-blank-lines", Array(80).fill("循环甲乙丙丁").join("\n \t\n"), "text", true]);

const cycleOpts = { repeatThreshold: 3, maxCycle: 4, minLineLength: 8 };
assert.equal(findLineCycle([repeatedLong, "a", repeatedLong, "b", repeatedLong], cycleOpts), null);
assert.equal(findLineCycle([repeatedLong, repeatedLong, repeatedLong, "x"], cycleOpts), null);
assert.equal(findLineCycle([repeatedLong, "", repeatedLong, " \t", repeatedLong], cycleOpts), repeatedLong);
assert.equal(findLineCycle(["短句", "短句", "短句"], cycleOpts), null);

const ranges = [
  ["maxRescues", 0, 100, 3],
  ["idleTimeoutMs", 100, 300000, 15000],
  ["compactTimeoutMs", 100, 600000, 90000],
  ["settleDelayMs", 0, 5000, 450],
];
const invalidNumbers = [undefined, NaN, Infinity, "invalid", null, true, false, "", " \t\n", [], {}, [1]];
for (const [key, lo, hi, fallback] of ranges) {
  for (const value of invalidNumbers) {
    assert.equal(normalizeConfig({ [key]: value })[key], fallback, `${key} fallback`);
  }
  assert.equal(cfg[key], fallback, `${key} default`);
  assert.equal(normalizeConfig({ [key]: lo - 1 })[key], lo, `${key} lower bound`);
  assert.equal(normalizeConfig({ [key]: hi + 1 })[key], hi, `${key} upper bound`);
  assert.equal(normalizeConfig({ [key]: lo + 1.9 })[key], lo + 1, `${key} integer`);
  assert.equal(normalizeConfig({ [key]: String(hi) })[key], hi, `${key} numeric string`);
}
for (const key of Object.keys(cfg).filter((key) => typeof cfg[key] === "number")) {
  for (const value of invalidNumbers) {
    assert.equal(normalizeConfig({ [key]: value })[key], cfg[key], `${key} invalid numeric type`);
  }
}
for (const key of ["dedupRatio", "reasoningDedupRatio"]) {
  assert.equal(normalizeConfig({ [key]: " 0.25 " })[key], 0.25);
  assert.equal(normalizeConfig({ [key]: 0 })[key], 0.05);
  assert.equal(normalizeConfig({ [key]: 1 })[key], 0.95);
}
for (const key of ["enabled", "verbose", "selftestReasoning", "autoAbort", "autoCompact", "resumeGoal"]) {
  for (const value of [true, false]) assert.equal(normalizeConfig({ [key]: value })[key], value);
  for (const value of [undefined, null, "false", "true", 0, 1, {}]) {
    assert.equal(normalizeConfig({ [key]: value })[key], cfg[key], `${key} strict boolean`);
  }
}
for (const value of [undefined, null, 42, {}, "", " \t\n"]) {
  assert.equal(normalizeConfig({ continueText: value }).continueText, cfg.continueText);
}
assert.equal(normalizeConfig({ continueText: "继续正文" }).continueText, "继续正文");
assert.equal(normalizeConfig({ continueText: " keep spacing " }).continueText, " keep spacing ");
for (const [windowKey, minKey, windowSize] of [
  ["windowChars", "minTextLength", 256],
  ["reasoningWindowChars", "reasoningMinTextLength", 512],
]) {
  for (const threshold of [0, 10000, 131072]) {
    const normalized = normalizeConfig({ [windowKey]: windowSize, [minKey]: threshold });
    assert.equal(normalized[minKey], threshold, `${minKey} preserves explicit threshold with small window`);
  }
  assert.equal(normalizeConfig({ [windowKey]: windowSize, [minKey]: -1 })[minKey], 0);
  assert.equal(normalizeConfig({ [windowKey]: windowSize, [minKey]: 131073 })[minKey], 131072);
}
console.log("PASS line-cycle boundaries and configuration assertions");

let pass = 0;
for (const [name, text, channel, expect, caseCfg = cfg] of cases) {
  const r = detectDegeneration(text, caseCfg, channel);
  const ok = Boolean(r) === expect;
  if (ok) pass += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} [${channel}]: ${r ? `${r.channel}/${r.reason}` : "none"} (ratio=${r ? r.ratio.toFixed(2) : "-"})`);
}
console.log(`${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
