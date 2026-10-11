import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, normalizeConfig, detectDegeneration } from "./detector.js";

// Resolved dynamically: a missing registry package must not kill plugin load.
let serviceForAgent = null;
try {
  ({ serviceForAgent } = await import("@deepseek-ai/dsh-agent-preset-registry"));
} catch {
  serviceForAgent = null;
}

export const name = "dsh-degeneration-watchdog";
// NOTE: no static inject. "compaction" is a per-session-leaf service
// (CompactionEngine: "Load one implementation per context"); injecting it at
// profile-root leaves this plugin permanently PENDING. The service is
// resolved dynamically from the agent's own context at rescue time.
export const inject = [];

// Stable absolute path: import.meta.url may be virtualized by the loader, so
// derive from DSH_HOME first, then fall back to the OS temp directory.
const AUDIT_LOG = (() => {
  const home = process.env.DSH_HOME;
  if (home) return join(home, "plugins", "dsh-degeneration-watchdog", "watchdog.log");
  try { return join(process.env.TEMP || process.env.TMP || ".", "dsh-degeneration-watchdog.log"); }
  catch { return "dsh-degeneration-watchdog.log"; }
})();

/** Always-on file audit: rescue steps must be diagnosable after the fact. */
function audit(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => {
    if (a instanceof Error) return `${a.name}:${a.message}${a.code ? `(${a.code})` : ""}`;
    if (typeof a === "object" && a !== null) {
      try { return JSON.stringify(a).slice(0, 400); } catch { return String(a); }
    }
    return String(a);
  }).join(" ")}\n`;
  try { appendFileSync(AUDIT_LOG, line); } catch { /* ignore */ }
  console.log("[degeneration-watchdog]", ...args);
}

const log = (cfg, ...args) => {
  if (cfg?.verbose) audit("(verbose)", ...args);
};

function resolveService(carrier, key) {
  if (!carrier) return null;
  let svc;
  try { svc = carrier[key]; } catch { /* accessor may throw when unresolved */ }
  if (!svc && typeof carrier.get === "function") {
    try { svc = carrier.get(key); } catch { /* unresolved in this scope */ }
  }
  return svc ?? null;
}

function compactionOf(agent, myCtx) {
  // Preferred: the official per-preset service resolver. Session plugins
  // (compaction included) are mounted per-session inside an isolate realm;
  // a root-tree holder of the Agent reaches them through the agent's scope
  // parent (see serviceForAgent's docstring — same situation as browser RPCs).
  try {
    if (!serviceForAgent) throw new Error("registry package unavailable");
    const svc = serviceForAgent(myCtx, agent, "compaction");
    if (svc && typeof svc.compactNow === "function") {
      audit("compaction resolved via serviceForAgent");
      return svc;
    }
    audit("serviceForAgent returned:", svc === undefined ? "undefined" : "no compactNow");
  } catch (e) {
    audit("serviceForAgent threw", e);
  }
  // Fallback probes: context carriers reachable without the registry.
  const carriers = [
    ["agent.ctx", agent?.ctx],
    ["agent.loopCtx", agent?.loopCtx],
    ["agent.scope", agent?.scope],
    ["plugin ctx", myCtx],
  ];
  for (const [label, carrier] of carriers) {
    const svc = resolveService(carrier, "compaction");
    if (svc && typeof svc.compactNow === "function") {
      audit("compaction resolved via", label);
      return svc;
    }
  }
  audit("compaction NOT FOUND on", carriers.map(([l, c]) => `${l}(${c ? "yes" : "no"})`).join(" "));
  return null;
}

function commandsOf(agent, myCtx) {
  // /compact through the official command dispatch: emits command/run +
  // command/done so the UI shows the same "compacting" indicator as a
  // user-typed /compact. Bare compactNow bypasses that lifecycle (v0.3.2
  // field test: compaction ran but nothing appeared on screen).
  try {
    if (!serviceForAgent) throw new Error("registry package unavailable");
    const svc = serviceForAgent(myCtx, agent, "commands");
    if (svc && typeof svc.execute === "function") {
      audit("commands resolved via serviceForAgent");
      return svc;
    }
    audit("serviceForAgent(commands) returned:", svc === undefined ? "undefined" : "no execute");
  } catch (e) {
    audit("serviceForAgent(commands) threw", e);
  }
  // dsh-commands mounts in the host composition (dsh-base), not inside the
  // agent's preset fiber, so serviceForAgent cannot see it. Scan the plugin's
  // own root-tree service store by name instead — same mechanism
  // serviceForAgent uses, minus the fiber constraint.
  try {
    const store = myCtx?.reflect?.store;
    if (store) {
      for (const key of Object.getOwnPropertySymbols(store)) {
        const impl = store[key];
        if (!impl || impl.name !== "commands") continue;
        if (typeof impl.value?.execute !== "function") continue;
        audit("commands resolved via root store scan");
        return impl.value;
      }
    }
    audit("commands not in root store (reflect.store:", store ? "present" : "absent", ")");
  } catch (e) {
    audit("root store scan threw", e);
  }
  return null;
}

function sessionIdOf(agent) {
  return agent?.id || agent?.session?.id || "";
}

function isIdle(agent) {
  try {
    if (agent?.status === "running") return false;
    const inbox = agent?.inbox;
    if (inbox && typeof inbox.hasPending === "function" && inbox.hasPending()) return false;
    if (inbox && typeof inbox.size === "number" && inbox.size > 0) return false;
    return true;
  } catch {
    return true;
  }
}

function waitFor(predicate, timeoutMs, pollMs = 100) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(true); return; }
      if (Date.now() - started > timeoutMs) { clearInterval(timer); resolve(false); }
    }, pollMs);
  });
}

function makeMessage(text) {
  return {
    id: `degeneration-watchdog-${randomUUID()}`,
    role: "user",
    content: [{ type: "text", text: String(text) }],
    source: {
      kind: "dsh-degeneration-watchdog",
      form: "notice",
      summary: "rescue",
    },
  };
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const pkgMeta = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  audit(`plugin loaded v${pkgMeta.version} (commands dispatch via root store scan; selftestReasoning=${cfg.selftestReasoning})`);
  // Per-session state: accumulated text per streaming attemptId + rescue budget.
  const attempts = new Map(); // attemptId -> { text, reasoning }
  const budgets = new Map(); // sessionId -> { count, lastAt }
  const rescuing = new Set(); // sessionIds with rescue in flight
  const disposers = [];

  const listen = (event, handler) => {
    try {
      const off = ctx.on(event, handler, { global: true });
      disposers.push(() => { try { off?.(); } catch { /* ignore */ } });
    } catch {
      try {
        const off = ctx.on(event, handler);
        disposers.push(() => { try { off?.(); } catch { /* ignore */ } });
      } catch (e) {
        console.error("[degeneration-watchdog] cannot listen", event, e);
      }
    }
  };

  function budgetOf(sessionId) {
    let cur = budgets.get(sessionId);
    if (!cur) {
      cur = { count: 0, lastAt: 0 };
      budgets.set(sessionId, cur);
    }
    if (Date.now() - cur.lastAt > cfg.cooldownMs) cur.count = 0;
    return cur;
  }

  // Session plugins (compaction included) are composed per-session by agent
  // presets, so a root-tree plugin cannot resolve the service directly.
  // Fallback path: drive /compact through the command adapter via followup
  // text, then wait for the durable compaction/command events.
  function waitForSessionSettle(sessionId, timeoutMs) {
    return new Promise((resolve) => {
      let off = null;
      let done = false;
      const finish = (why) => {
        if (done) return;
        done = true;
        try { off?.(); } catch { /* ignore */ }
        clearTimeout(timer);
        audit("session settle:", why);
        resolve();
      };
      const handler = (subject, event) => {
        if (String(subject || "") !== String(sessionId)) return;
        if (event?.type === "compaction/end" || event?.type === "command/done") finish(event.type);
      };
      try {
        off = ctx.on("session/event", handler, { global: true });
      } catch {
        try { off = ctx.on("session/event", handler); } catch { off = null; }
      }
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
    });
  }

  async function rescue(agent, finding) {
    const sessionId = sessionIdOf(agent);
    if (!sessionId || rescuing.has(sessionId)) return;
    const budget = budgetOf(sessionId);
    if (cfg.maxRescues > 0 && budget.count >= cfg.maxRescues) {
      log(cfg, `session ${sessionId}: rescue budget exhausted, staying passive`);
      return;
    }
    rescuing.add(sessionId);
    budget.count += 1;
    budget.lastAt = Date.now();
    audit(`rescue start session=${sessionId} finding=${finding.channel}/${finding.reason}` +
      ` ratio=${finding.ratio.toFixed(3)} sample="${finding.sample.slice(0, 100)}"`);
    try {
      // 1. Force-stop the looping output.
      if (cfg.autoAbort) {
        try { agent.cancel({ kind: "user" }); audit("cancel issued"); }
        catch (e) { audit("cancel failed", e); }
        const idle = await waitFor(() => isIdle(agent), 15000);
        audit("wait idle:", idle ? "idle" : "timeout (status=" + agent?.status + ")");
      }
      // 2. Compact. Preferred: the session's own /compact command dispatch
      // (full UI lifecycle). Fallbacks: direct compaction seam (no UI
      // indicator), then followup "/compact" text (last resort).
      let compacted = false;
      if (cfg.autoCompact) {
        const commands = commandsOf(agent, ctx);
        if (commands) {
          try {
            const controller = new AbortController();
            const result = await commands.execute(agent, "/compact", [], controller.signal);
            audit("compacted (command):", result?.kind, result?.text ?? "");
            compacted = true;
          } catch (e) {
            audit("command /compact failed", e);
          }
        }
      }
      if (cfg.autoCompact && !compacted) {
        const compaction = compactionOf(agent, ctx);
        if (compaction) {
          try {
            const controller = new AbortController();
            const result = await compaction.compactNow(agent, controller.signal, `degeneration-watchdog-${randomUUID()}`);
            audit("compacted (direct):", result === null ? "nothing to compact" : `${result.shadowedSeqs?.length ?? 0} items`);
            compacted = true;
          } catch (e) {
            audit("compaction failed (direct)", e);
          }
        }
      }
      if (cfg.autoCompact && !compacted) {
        try {
          agent.followup(makeMessage("/compact"));
          audit("compact command sent via followup");
          await waitForSessionSettle(sessionId, 90000);
          compacted = true;
        } catch (e) {
          audit("compact followup failed", e);
        }
      }
      // 4. Send the continue message. A short settle avoids the still-draining
      // turn swallowing it (observed in the 0.2.2 field test).
      if (!compacted) await new Promise((r) => setTimeout(r, 450));
      try {
        agent.followup(makeMessage(cfg.continueText));
        audit("continue message sent");
      } catch (e) {
        audit("followup failed", e);
      }
    } catch (e) {
      audit("rescue crashed", e);
    } finally {
      rescuing.delete(sessionId);
      audit("rescue done session=", sessionId);
    }
  }

  function onStream({ agent, frame } = {}) {
    if (!agent || !frame) return;
    if (frame.type === "start" || frame.type === "end") {
      attempts.delete(frame.attemptId);
      return;
    }
    if (frame.type !== "chunk") return;
    const chunk = frame.chunk;
    if (!chunk || typeof chunk.text !== "string") return;
    const isReasoning = chunk.type === "reasoning-delta";
    if (!isReasoning && chunk.type !== "text-delta") return;
    const key = frame.attemptId;
    let slot = attempts.get(key);
    if (!slot) {
      slot = { text: "", reasoning: "" };
      attempts.set(key, slot);
    }
    const buf = isReasoning ? "reasoning" : "text";
    slot[buf] += chunk.text;
    // Cap growth: only the trailing window matters for detection.
    const cap = (isReasoning ? cfg.reasoningWindowChars : cfg.windowChars) * 4;
    if (slot[buf].length > cap) slot[buf] = slot[buf].slice(-Math.trunc(cap / 2));
    // Reasoning channel first: degradation surfaces there earliest.
    const finding =
      detectDegeneration(slot.reasoning, cfg, "reasoning") ||
      detectDegeneration(slot.text, cfg, "text");
    if (finding) {
      attempts.delete(key);
      // Fire-and-forget: the stream listener must stay synchronous.
      rescue(agent, finding).catch((e) => audit("rescue error", e));
    }
  }

  // Selftest: prove the reasoning channel end-to-end by feeding a synthetic
  // degenerate reasoning stream (DeepSeek-style short-line loop) through the
  // exact same pipeline: accumulate -> detect -> rescue.
  function runSelftest(agent) {
    const attemptId = "watchdog-selftest-attempt";
    audit("selftest: injecting synthetic degenerate reasoning stream (72 x '执行。')");
    const block = Array(12).fill("执行。").join("\n") + "\n";
    for (let i = 0; i < 6; i += 1) {
      onStream({ agent, frame: { type: "chunk", attemptId, chunk: { type: "reasoning-delta", text: block } } });
    }
    onStream({ agent, frame: { type: "end", attemptId } });
    audit("selftest: stream injection finished (rescue outcome above, if any)");
  }

  let selftestDone = false;
  listen("agent/assistant-stream", (evt) => {
    onStream(evt);
    if (cfg.selftestReasoning && !selftestDone && evt?.agent && evt?.frame?.type === "end") {
      selftestDone = true;
      const agent = evt.agent;
      setTimeout(() => {
        try { runSelftest(agent); } catch (e) { audit("selftest crashed", e); }
      }, 1000);
    }
  });

  // Hygiene: drop attempt state when agents go away.
  listen("agent/disposed", () => {
    if (attempts.size > 64) attempts.clear();
  });

  ctx.effect(() => () => {
    for (const off of disposers.splice(0)) off();
    attempts.clear();
    budgets.clear();
  }, "degeneration-watchdog lifecycle");
}
