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

// Retain unresolved provider ownership across reloads in the same host realm.
const pendingKey = Symbol.for("dsh-degeneration-watchdog.pending-compactions");
const pendingCompactions = globalThis[pendingKey] ??= new WeakMap();

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
  try {
    const presets = resolveService(ctx, "agentPresets");
    const service = presets?.serviceFor?.(agent, key);
    if (typeof service?.[method] === "function") return service;
  } catch (error) { audit(`preset resolver(${key}) failed`, error); }
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

let inboxReadErrors = 0;
function hasPendingInput(agent) {
  try {
    const inbox = agent?.inbox;
    if (inbox?.hasPending?.()) return true;
    if (typeof inbox?.size === "number" && inbox.size > 0) return true;
    return Boolean(inbox?.nextTurn?.length || inbox?.nextStep?.length);
  } catch (error) {
    // local fix: an inbox projection read failure during the host's abort
    // handling is not queued input. Real inserts still abort the rescue via
    // the agent/inbox/inserted listener.
    inboxReadErrors += 1;
    if (inboxReadErrors <= 5) console.warn("[dsh-degeneration-watchdog] inbox read failed (treated as no pending input):", error?.message ?? error);
    return false;
  }
}

function isIdle(agent) {
  try {
    return agent?.status === "idle" && (!agent.phase || agent.phase.kind === "idle") && !hasPendingInput(agent);
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
    const pending = Promise.resolve().then(() => {
      checkActive(controller.signal);
      return operation(controller.signal);
    });
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
  // local fix: the pre-idle inbox probe raced with the host's abort handling
  // (inbox projection re-entry threw -> hasPendingInput catch -> false
  // "pending input" -> rescue yielded before compaction). Wait for idle
  // first; real queued input is still guarded by the post-idle loop below
  // and by the agent/inbox/inserted listener.
  await bounded(signal, timeoutMs, async (stepSignal) => {
    if (typeof agent.whenIdle === "function") await agent.whenIdle();
    while (!isIdle(agent)) {
      if (hasPendingInput(agent)) throw new Error("pending input preserved; rescue yields to queued work");
      await delay(100, stepSignal);
    }
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
  const retiredAgents = new WeakSet();
  const budgets = new Map();
  const rescuing = new Map(); // sessionId -> { agent, controller }
  const ownedCompactions = new Set();
  const selftests = new Map();
  const disposers = [];
  let disposed = false;

  function listen(event, handler) {
    try { disposers.push(ctx.on(event, handler, { global: true })); }
    catch { disposers.push(ctx.on(event, handler)); }
  }

  async function runCompaction(agent, controller, operation) {
    checkActive(controller.signal);
    if (pendingCompactions.has(agent)) throw new Error("compaction already in progress for this agent");
    const entry = { controller, pending: null };
    pendingCompactions.set(agent, entry);
    ownedCompactions.add(entry);
    const retire = () => {
      if (pendingCompactions.get(agent) === entry) pendingCompactions.delete(agent);
      ownedCompactions.delete(entry);
    };
    try {
      return await bounded(controller.signal, cfg.compactTimeoutMs, operation, (pending) => {
        entry.pending = pending;
        void pending.then(retire, retire);
      });
    } finally {
      if (!entry.pending) retire();
    }
  }

  function mutateGoal(agent, goals, method, ref) {
    const agents = resolveService(ctx, "agents");
    const mutate = () => goals[method](agent, ref);
    return typeof agents?.withInitiator === "function" ? agents.withInitiator(agent, mutate) : mutate();
  }

  function pauseActiveGoal(agent, goals) {
    const goal = goals?.get(agent);
    if (goal?.phase !== "active" || goal.activation === "disarmed") return null;
    if (!cfg.autoAbort) throw new Error("active goal rescue requires autoAbort");
    if (typeof goals.pause !== "function" || typeof goals.resume !== "function") throw new Error("goal service lacks pause/resume");
    const paused = mutateGoal(agent, goals, "pause", { id: goal.id, revision: goal.revision });
    if (paused?.phase !== "paused" || paused.id !== goal.id) throw new Error("goal pause returned no paused view");
    audit("goal paused", { id: paused.id, revision: paused.revision });
    return { id: paused.id, revision: paused.revision };
  }

  function recoverGoal(agent, goals, ref) {
    if (!cfg.resumeGoal) { audit("goal recovery disabled", ref); return; }
    const current = goals.get(agent);
    if (current?.id !== ref.id || current.revision !== ref.revision || current.phase !== "paused") {
      audit("goal recovery skipped: goal changed", ref);
      return;
    }
    const result = mutateGoal(agent, goals, "resume", ref);
    audit("goal resumed", { id: result.id, revision: result.revision });
  }

  async function rescue(agent, finding) {
    const sessionId = sessionIdOf(agent);
    if (disposed || retiredAgents.has(agent) || (!cfg.autoAbort && !cfg.autoCompact) || !sessionId || rescuing.has(sessionId) || pendingCompactions.has(agent)) return;
    let budget = budgets.get(sessionId);
    if (!budget || Date.now() - budget.lastAt > cfg.cooldownMs) budget = { count: 0, lastAt: 0 };
    if (cfg.maxRescues > 0 && budget.count >= cfg.maxRescues) return;
    budget.count++;
    budget.lastAt = Date.now();
    budgets.set(sessionId, budget);
    const controller = new AbortController();
    const signal = controller.signal;
    const entry = { agent, controller, cancelIssued: false };
    rescuing.set(sessionId, entry);
    audit("rescue start", { sessionId, channel: finding.channel, reason: finding.reason, ratio: finding.ratio });
    try {
      const goals = serviceOf(agent, ctx, "goals", "get");
      let pausedGoal = null;
      let goalError;
      try { pausedGoal = pauseActiveGoal(agent, goals); }
      catch (error) { goalError = error; audit("goal preparation failed", error); }
      checkActive(signal);
      if (cfg.autoAbort) {
        entry.cancelIssued = true;
        agent.cancel({ kind: "parent" }, { keepInbox: true });
        audit("cancel issued (inbox preserved)");
        await waitForIdle(agent, signal, cfg.idleTimeoutMs);
      }
      checkActive(signal);
      if (goalError) throw goalError;
      if (!isIdle(agent)) throw new Error("agent is not idle or has pending input; rescue stopped");
      if (cfg.autoCompact) {
        let compacted = false;
        const commands = serviceOf(agent, ctx, "commands", "execute");
        if (commands) {
          const execution = await runCompaction(agent, controller,
            (stepSignal) => commands.execute(agent, "/compact", [], stepSignal));
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
          const result = await runCompaction(agent, controller,
            (stepSignal) => compaction.compactNow(agent, stepSignal, `${name}-${randomUUID()}`));
          checkActive(signal);
          audit("compacted (direct)", result === null ? "nothing to compact" : `${result?.shadowedSeqs?.length ?? 0} items`);
        }
      }
      await delay(cfg.settleDelayMs, signal);
      checkActive(signal);
      if (disposed || !isIdle(agent)) throw new Error("agent is no longer idle or has pending input; recovery skipped");
      if (pausedGoal) {
        recoverGoal(agent, goals, pausedGoal);
      } else {
        const current = goals?.get(agent);
        if (current && current.phase !== "complete") {
          audit("continue skipped: existing goal owns continuation");
          return;
        }
        agent.followup(makeMessage(cfg.continueText));
        audit("continue message sent");
      }
    } catch (error) {
      audit("rescue stopped", error);
    } finally {
      if (rescuing.get(sessionId) === entry) rescuing.delete(sessionId);
      audit("rescue done", sessionId);
    }
  }

  function onStream({ agent, frame } = {}) {
    if (disposed || !cfg.enabled || !agent || !frame || retiredAgents.has(agent)) return;
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
      void Promise.resolve().then(() => rescue(agent, finding)).catch((error) => audit("rescue error", error));
    }
  }

  let selftestDone = false;
  listen("agent/assistant-stream", (event) => {
    onStream(event);
    if (disposed || !cfg.enabled || !cfg.selftestReasoning || selftestDone || !event?.agent || retiredAgents.has(event.agent) || event.frame?.type !== "end") return;
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

  listen("agent/inbox/inserted", ({ agent, message } = {}) => {
    if (!agent || ["goal", name].includes(message?.source?.kind)) return;
    const entry = rescuing.get(sessionIdOf(agent));
    if (entry?.agent === agent && (entry.cancelIssued || !cfg.autoAbort)) {
      entry.controller.abort(new Error("pending input preserved; rescue yields to queued work"));
    }
  });

  listen("agent/disposed", ({ agent } = {}) => {
    if (!agent) return;
    retiredAgents.add(agent);
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
    for (const { controller } of ownedCompactions) controller.abort(stoppedError());
    for (const timer of selftests.values()) clearTimeout(timer);
    selftests.clear();
    attempts.clear();
    budgets.clear();
    ownedCompactions.clear();
  }, "degeneration-watchdog lifecycle");
}
