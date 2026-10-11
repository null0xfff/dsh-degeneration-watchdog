import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeConfig, detectDegeneration } from "./detector.js";

let serviceForAgent = null;
try {
  ({ serviceForAgent } = await import("@deepseek-ai/dsh-agent-preset-registry"));
} catch {
  // Optional on hosts exposing services directly through agent.ctx.
}

export const name = "dsh-degeneration-watchdog";
export const inject = [];

const AUDIT_LOG = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, "plugins", name, "watchdog.log")
  : join(process.env.TEMP || process.env.TMP || ".", `${name}.log`);
let logReady = false;
let logErrorReported = false;

function audit(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((value) => {
    if (value instanceof Error) return `${value.name}:${value.message}`;
    if (value && typeof value === "object") {
      try { return JSON.stringify(value).slice(0, 400); } catch { return String(value); }
    }
    return String(value);
  }).join(" ")}\n`;
  try {
    if (!logReady) {
      mkdirSync(dirname(AUDIT_LOG), { recursive: true });
      logReady = true;
    }
    appendFileSync(AUDIT_LOG, line);
  } catch (error) {
    if (!logErrorReported) {
      logErrorReported = true;
      console.error(`[${name}] file audit unavailable: ${AUDIT_LOG}`, error);
    }
  }
  console.log(`[${name}]`, ...args);
}

function resolveService(carrier, key) {
  if (!carrier) return null;
  try {
    const service = carrier.get?.(key);
    if (service) return service;
  } catch { /* Service may be unresolved in this scope. */ }
  try { return carrier[key] ?? null; } catch { return null; }
}

function serviceOf(agent, ctx, key, method) {
  if (typeof serviceForAgent === "function") {
    try {
      const service = serviceForAgent(ctx, agent, key);
      if (typeof service?.[method] === "function") return service;
    } catch (error) {
      if (ctx && agent) audit(`resolver(${key}) failed`, error);
    }
  }
  for (const carrier of [agent?.ctx, agent?.loopCtx, agent?.scope, ctx]) {
    const service = resolveService(carrier, key);
    if (typeof service?.[method] === "function") return service;
  }
  if (key === "commands") {
    try {
      const store = ctx?.reflect?.store;
      for (const symbol of store ? Object.getOwnPropertySymbols(store) : []) {
        const impl = store[symbol];
        if (impl?.name === key && typeof impl.value?.[method] === "function") return impl.value;
      }
    } catch (error) { audit("root service scan failed", error); }
  }
  return null;
}

function sessionIdOf(agent) {
  return agent?.id || agent?.session?.id || "";
}

function isIdle(agent) {
  try {
    if (agent?.status !== "idle") return false;
    const inbox = agent.inbox;
    if (inbox?.hasPending?.()) return false;
    return !(typeof inbox?.size === "number" && inbox.size > 0);
  } catch { return false; }
}

function stoppedError() {
  const error = new Error("watchdog operation cancelled");
  error.name = "AbortError";
  return error;
}

function checkActive(signal) {
  if (signal.aborted) throw signal.reason ?? stoppedError();
}

// The timeout also bounds providers that ignore AbortSignal. Their promise is
// still observed and retained by the caller until it really settles.
async function bounded(signal, timeoutMs, operation, observe) {
  checkActive(signal);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason ?? stoppedError());
  signal.addEventListener("abort", abort, { once: true });
  let rejectAbort;
  const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason ?? stoppedError());
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    const error = new Error(`watchdog operation timed out after ${timeoutMs}ms`);
    error.name = "TimeoutError";
    controller.abort(error);
  }, timeoutMs);
  try {
    const pending = Promise.resolve(operation(controller.signal));
    observe?.(pending);
    return await Promise.race([pending, cancelled]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

function delay(ms, signal) {
  checkActive(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? stoppedError());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function waitForIdle(agent, signal, timeoutMs) {
  await bounded(signal, timeoutMs, async (stepSignal) => {
    if (typeof agent.whenIdle === "function") await agent.whenIdle();
    while (!isIdle(agent)) await delay(100, stepSignal);
  });
}

function makeMessage(text) {
  return {
    id: `${name}-${randomUUID()}`,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: name, form: "notice", summary: "rescue" },
  };
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  let version = "unknown";
  try { version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version; }
  catch (error) { audit("package metadata unavailable", error); }
  audit(`plugin loaded v${version} selftestReasoning=${cfg.selftestReasoning}`);

  const attempts = new Map(); // agent -> Map<attemptId, buffers>
  const budgets = new Map();
  const rescuing = new Map(); // sessionId -> { agent, controller }
  const pendingCompactions = new Map(); // agent -> { pending, controller }
  const selftests = new Map();
  const disposers = [];
  let disposed = false;

  function listen(event, handler) {
    try { disposers.push(ctx.on(event, handler, { global: true })); }
    catch { disposers.push(ctx.on(event, handler)); }
  }

  function observeCompaction(agent, controller, pending) {
    const entry = { pending, controller };
    pendingCompactions.set(agent, entry);
    const retire = () => {
      if (pendingCompactions.get(agent) === entry) pendingCompactions.delete(agent);
    };
    void pending.then(retire, retire);
  }

  async function rescue(agent, finding) {
    const sessionId = sessionIdOf(agent);
    if (disposed || (!cfg.autoAbort && !cfg.autoCompact) || !sessionId || rescuing.has(sessionId) || pendingCompactions.has(agent)) return;
    let budget = budgets.get(sessionId);
    if (!budget || Date.now() - budget.lastAt > cfg.cooldownMs) budget = { count: 0, lastAt: 0 };
    if (cfg.maxRescues > 0 && budget.count >= cfg.maxRescues) return;
    budget.count++;
    budget.lastAt = Date.now();
    budgets.set(sessionId, budget);
    const controller = new AbortController();
    const signal = controller.signal;
    const entry = { agent, controller };
    rescuing.set(sessionId, entry);
    audit("rescue start", { sessionId, channel: finding.channel, reason: finding.reason, ratio: finding.ratio });
    try {
      if (cfg.autoAbort) {
        agent.cancel({ kind: "user" });
        audit("cancel issued");
        await waitForIdle(agent, signal, cfg.idleTimeoutMs);
      }
      checkActive(signal);
      if (cfg.autoCompact) {
        let compacted = false;
        const commands = serviceOf(agent, ctx, "commands", "execute");
        if (commands) {
          const execution = await bounded(signal, cfg.compactTimeoutMs,
            (stepSignal) => commands.execute(agent, "/compact", [], stepSignal),
            (pending) => observeCompaction(agent, controller, pending));
          checkActive(signal);
          if (execution !== undefined) {
            // Current hosts wrap results; older hosts returned CommandResult.
            const result = execution?.result ?? execution;
            if (result?.kind !== "success") throw new Error(result?.text || "compact command did not succeed");
            compacted = true;
            audit("compacted (command)", result);
          }
        }
        if (!compacted) {
          const compaction = serviceOf(agent, ctx, "compaction", "compactNow");
          if (!compaction) throw new Error("no executable compaction service; rescue stopped");
          const result = await bounded(signal, cfg.compactTimeoutMs,
            (stepSignal) => compaction.compactNow(agent, stepSignal, `${name}-${randomUUID()}`),
            (pending) => observeCompaction(agent, controller, pending));
          checkActive(signal);
          audit("compacted (direct)", result === null ? "nothing to compact" : `${result?.shadowedSeqs?.length ?? 0} items`);
        }
      }
      await delay(cfg.settleDelayMs, signal);
      checkActive(signal);
      if (disposed || !isIdle(agent)) throw new Error("agent is no longer idle; continue skipped");
      agent.followup(makeMessage(cfg.continueText));
      audit("continue message sent");
    } catch (error) {
      audit("rescue stopped", error);
    } finally {
      if (rescuing.get(sessionId) === entry) rescuing.delete(sessionId);
      audit("rescue done", sessionId);
    }
  }

  function onStream({ agent, frame } = {}) {
    if (disposed || !cfg.enabled || !agent || !frame) return;
    let slots = attempts.get(agent);
    if (frame.type === "start" || frame.type === "end") {
      slots?.delete(frame.attemptId);
      if (slots?.size === 0) attempts.delete(agent);
      return;
    }
    if (rescuing.has(sessionIdOf(agent)) || pendingCompactions.has(agent)) return;
    if (frame.type !== "chunk" || typeof frame.chunk?.text !== "string") return;
    const channel = frame.chunk.type === "reasoning-delta" ? "reasoning" : "text";
    if (channel === "text" && frame.chunk.type !== "text-delta") return;
    if (!slots) attempts.set(agent, slots = new Map());
    let slot = slots.get(frame.attemptId);
    if (!slot) slots.set(frame.attemptId, slot = { text: "", reasoning: "" });
    slot[channel] += frame.chunk.text;
    const window = channel === "reasoning" ? cfg.reasoningWindowChars : cfg.windowChars;
    const minLength = channel === "reasoning" ? cfg.reasoningMinTextLength : cfg.minTextLength;
    const keep = Math.max(window * 2, minLength);
    if (slot[channel].length > keep * 2) slot[channel] = slot[channel].slice(-keep);
    const finding = detectDegeneration(slot[channel], cfg, channel);
    if (finding) {
      if (cfg.verbose) audit("detection buffers", { sessionId: sessionIdOf(agent), attemptId: frame.attemptId, textChars: slot.text.length, reasoningChars: slot.reasoning.length });
      slots.delete(frame.attemptId);
      if (slots.size === 0) attempts.delete(agent);
      void rescue(agent, finding).catch((error) => audit("rescue error", error));
    }
  }

  let selftestDone = false;
  listen("agent/assistant-stream", (event) => {
    onStream(event);
    if (disposed || !cfg.enabled || !cfg.selftestReasoning || selftestDone || !event?.agent || event.frame?.type !== "end") return;
    selftestDone = true;
    const agent = event.agent;
    const timer = setTimeout(() => {
      selftests.delete(agent);
      if (disposed) return;
      const attemptId = `${name}-${randomUUID()}`;
      onStream({ agent, frame: { type: "chunk", attemptId, chunk: { type: "reasoning-delta", text: "Execute.\n".repeat(72) } } });
      onStream({ agent, frame: { type: "end", attemptId } });
    }, 1000);
    selftests.set(agent, timer);
  });

  listen("agent/disposed", ({ agent } = {}) => {
    if (!agent) return;
    attempts.delete(agent);
    const sessionId = sessionIdOf(agent);
    budgets.delete(sessionId);
    const entry = rescuing.get(sessionId);
    if (entry?.agent === agent) entry.controller.abort(stoppedError());
    pendingCompactions.get(agent)?.controller.abort(stoppedError());
    clearTimeout(selftests.get(agent));
    selftests.delete(agent);
  });

  ctx.effect(() => () => {
    disposed = true;
    for (const off of disposers.splice(0)) {
      try { off?.(); } catch (error) { audit("listener cleanup failed", error); }
    }
    for (const { controller } of rescuing.values()) controller.abort(stoppedError());
    for (const { controller } of pendingCompactions.values()) controller.abort(stoppedError());
    for (const timer of selftests.values()) clearTimeout(timer);
    selftests.clear();
    attempts.clear();
    budgets.clear();
    pendingCompactions.clear();
  }, "degeneration-watchdog lifecycle");
}
