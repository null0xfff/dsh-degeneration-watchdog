import { detectDegeneration, normalizeConfig } from "file:///C:/dsh-home/plugins/dsh-degeneration-watchdog/lib/detector.js";
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

let pass = 0;
for (const [name, text, channel, expect] of cases) {
  const r = detectDegeneration(text, cfg, channel);
  const ok = Boolean(r) === expect;
  if (ok) pass += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} [${channel}]: ${r ? `${r.channel}/${r.reason}` : "none"} (ratio=${r ? r.ratio.toFixed(2) : "-"})`);
}
console.log(`${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
