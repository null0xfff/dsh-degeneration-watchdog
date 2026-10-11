// Degeneration detector: pure functions over accumulated streaming text.
//
// Two independent channels with separate thresholds:
//  - text channel: final visible output (text-delta). Loops are usually long lines.
//  - reasoning channel: thinking-chain (reasoning-delta). Real-world DeepSeek
//    degradation starts here first: very short lines ("执行。/好。") cycle for
//    hundreds of repetitions while the body never starts. So this channel has a
//    larger window, a much lower line-length floor, and allows longer cycles.

export const DEFAULTS = Object.freeze({
  enabled: true,
  verbose: false,
  // text channel
  windowChars: 8192,
  minTextLength: 400,
  repeatThreshold: 3,
  maxCycle: 4,
  minLineLength: 8,
  dedupRatio: 0.12,
  ngramSize: 8,
  // text channel short-line fast path: lines shorter than minLineLength but
  // identical and repeated many times (e.g. "循环甲乙丙丁" x N) evade both
  // line-cycle (length filter) and ngram (ratio stays ~0.13). Catch them with
  // a lower length floor but a much higher repeat bar.
  shortLineMinLength: 2,
  shortLineRepeatThreshold: 8,
  // reasoning channel
  reasoningWindowChars: 16384,
  reasoningMinTextLength: 240,
  reasoningRepeatThreshold: 5,
  reasoningMaxCycle: 8,
  reasoningMinLineLength: 2,
  reasoningDedupRatio: 0.12,
  selftestReasoning: false,
  // actions
  autoAbort: true,
  autoCompact: true,
  continueText: "继续",
  maxRescues: 3,
  cooldownMs: 60000,
  idleTimeoutMs: 15000,
  compactTimeoutMs: 90000,
  settleDelayMs: 450,
});

export function normalizeConfig(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const number = (v) => typeof v === "number" || (typeof v === "string" && v.trim())
    ? Number(v) : NaN;
  const clamp = (v, lo, hi, fb) => {
    const n = number(v);
    if (!Number.isFinite(n)) return fb;
    return Math.max(lo, Math.min(hi, Math.trunc(n)));
  };
  const ratio = (v, fb) => {
    const n = number(v);
    return Number.isFinite(n) ? Math.max(0.05, Math.min(0.95, n)) : fb;
  };
  const boolean = (v, fb) => typeof v === "boolean" ? v : fb;
  const windowChars = clamp(src.windowChars, 256, 131072, DEFAULTS.windowChars);
  const reasoningWindowChars = clamp(src.reasoningWindowChars, 512, 262144, DEFAULTS.reasoningWindowChars);
  return {
    ...DEFAULTS,
    ...src,
    enabled: boolean(src.enabled, DEFAULTS.enabled),
    verbose: boolean(src.verbose, DEFAULTS.verbose),
    selftestReasoning: boolean(src.selftestReasoning, DEFAULTS.selftestReasoning),
    autoAbort: boolean(src.autoAbort, DEFAULTS.autoAbort),
    autoCompact: boolean(src.autoCompact, DEFAULTS.autoCompact),
    continueText: typeof src.continueText === "string" && src.continueText.trim()
      ? src.continueText : DEFAULTS.continueText,
    windowChars,
    minTextLength: clamp(src.minTextLength, 0, 131072, DEFAULTS.minTextLength),
    repeatThreshold: clamp(src.repeatThreshold, 2, 10, DEFAULTS.repeatThreshold),
    maxCycle: clamp(src.maxCycle, 1, 8, DEFAULTS.maxCycle),
    minLineLength: clamp(src.minLineLength, 1, 64, DEFAULTS.minLineLength),
    reasoningWindowChars,
    reasoningMinTextLength: clamp(src.reasoningMinTextLength, 0, 131072, DEFAULTS.reasoningMinTextLength),
    reasoningRepeatThreshold: clamp(src.reasoningRepeatThreshold, 2, 20, DEFAULTS.reasoningRepeatThreshold),
    reasoningMaxCycle: clamp(src.reasoningMaxCycle, 1, 16, DEFAULTS.reasoningMaxCycle),
    reasoningMinLineLength: clamp(src.reasoningMinLineLength, 1, 64, DEFAULTS.reasoningMinLineLength),
    ngramSize: clamp(src.ngramSize, 4, 32, DEFAULTS.ngramSize),
    dedupRatio: ratio(src.dedupRatio, DEFAULTS.dedupRatio),
    reasoningDedupRatio: ratio(src.reasoningDedupRatio, DEFAULTS.reasoningDedupRatio),
    shortLineMinLength: clamp(src.shortLineMinLength, 1, 64, DEFAULTS.shortLineMinLength),
    shortLineRepeatThreshold: clamp(src.shortLineRepeatThreshold, 3, 30, DEFAULTS.shortLineRepeatThreshold),
    cooldownMs: clamp(src.cooldownMs, 1000, 3600000, DEFAULTS.cooldownMs),
    maxRescues: clamp(src.maxRescues, 0, 100, DEFAULTS.maxRescues),
    idleTimeoutMs: clamp(src.idleTimeoutMs, 100, 300000, DEFAULTS.idleTimeoutMs),
    compactTimeoutMs: clamp(src.compactTimeoutMs, 100, 600000, DEFAULTS.compactTimeoutMs),
    settleDelayMs: clamp(src.settleDelayMs, 0, 5000, DEFAULTS.settleDelayMs),
  };
}

const normalizeLine = (line) =>
  line.replace(/\s+/g, " ").trim().toLowerCase();

/** Detect a repeated line-cycle in the trailing lines. Returns sample or null. */
export function findLineCycle(lines, opts) {
  const { repeatThreshold, maxCycle, minLineLength } = opts;
  const norm = lines.map(normalizeLine).filter((l) => l.length > 0);
  if (norm.length < repeatThreshold) return null;
  const tail = norm.slice(-maxCycle * repeatThreshold);
  for (let cycle = 1; cycle <= maxCycle; cycle += 1) {
    if (tail.length < cycle * repeatThreshold) break;
    const pattern = tail.slice(tail.length - cycle);
    if (pattern.some((l) => l.length < minLineLength)) continue;
    let repeats = 1;
    for (let i = tail.length - cycle * 2; i >= 0; i -= cycle) {
      let match = true;
      for (let j = 0; j < cycle; j += 1) {
        if (tail[i + j] !== pattern[j]) { match = false; break; }
      }
      if (!match) break;
      repeats += 1;
    }
    if (repeats >= repeatThreshold) return pattern.join(" / ");
  }
  return null;
}

/** distinct n-grams / total n-grams over the trailing window. */
export function dedupRatioOf(text, windowChars, ngramSize) {
  if (text.length < ngramSize * 4) return 1;
  const window = text.slice(-windowChars);
  const total = window.length - ngramSize + 1;
  const seen = new Set();
  for (let i = 0; i < total; i += 1) seen.add(window.slice(i, i + ngramSize));
  return seen.size / total;
}

/**
 * Text channel: normal pass first; if it misses, retry with the short-line
 * fast path (lower length floor, much higher repeat bar). Returns sample or null.
 */
function findLineCycleText(text, cfg, cycleOpts) {
  const lines = text.split(/\r?\n/);
  const sample = findLineCycle(lines, cycleOpts);
  if (sample) return sample;
  return findLineCycle(lines, {
    ...cycleOpts,
    minLineLength: cfg.shortLineMinLength,
    repeatThreshold: cfg.shortLineRepeatThreshold,
  });
}

/**
 * @param {string} text full text of the current streaming attempt
 * @param {object} cfg normalized config
 * @param {"text"|"reasoning"} channel
 * @returns {null | {reason: string, channel: string, sample: string, ratio: number}}
 */
export function detectDegeneration(text, cfg, channel = "text") {
  if (!cfg.enabled || typeof text !== "string") return null;
  const isReasoning = channel === "reasoning";
  const minLen = isReasoning ? cfg.reasoningMinTextLength : cfg.minTextLength;
  if (text.length < minLen) return null;
  const cycleOpts = {
    repeatThreshold: isReasoning ? cfg.reasoningRepeatThreshold : cfg.repeatThreshold,
    maxCycle: isReasoning ? cfg.reasoningMaxCycle : cfg.maxCycle,
    minLineLength: isReasoning ? cfg.reasoningMinLineLength : cfg.minLineLength,
  };
  const window = isReasoning ? cfg.reasoningWindowChars : cfg.windowChars;
  const threshold = isReasoning ? cfg.reasoningDedupRatio : cfg.dedupRatio;
  const sample = isReasoning
    ? findLineCycle(text.split(/\r?\n/), cycleOpts)
    : findLineCycleText(text, cfg, cycleOpts);
  const ratio = dedupRatioOf(text, window, cfg.ngramSize);
  if (sample) return { reason: "line-cycle", channel, sample, ratio };
  if (ratio < threshold) {
    const tail = text.slice(-160).replace(/\s+/g, " ");
    return { reason: "ngram-collapse", channel, sample: tail, ratio };
  }
  return null;
}
