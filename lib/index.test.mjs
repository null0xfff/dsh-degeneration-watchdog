import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import test from "node:test";
import { normalizeConfig, detectDegeneration } from "./detector.js";

const source = readFileSync(new URL("./index.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "")
  .replace(/export /g, "")
  .replace('new URL("../package.json", import.meta.url)', '"package.json"');

async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function harness(config = {}, services = {}, options = {}) {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  const handlers = new Map();
  const logs = [];
  const io = [];
  let cleanup;
  class ClockDate extends Date {
    static now() { return now; }
  }
  const sandbox = {
    normalizeConfig, detectDegeneration, Date: ClockDate, URL, AbortController,
    randomUUID: () => `id-${++sequence}`,
    join: (...parts) => parts.join("/"), dirname: path => path.slice(0, path.lastIndexOf("/")),
    process: { env: { DSH_HOME: "/audit-home" } },
    console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    mkdirSync(path, settings) { io.push(["mkdir", path, settings]); if (options.failLog) throw new Error("disk unavailable"); },
    appendFileSync(path, text) { io.push(["append", path, text]); },
    readFileSync: () => '{"version":"test"}',
    setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  await new vm.Script(`(async () => { ${source}; globalThis.applyPlugin = apply; })()`).runInNewContext(sandbox);
  const ctx = {
    get: key => services[key],
    on(event, handler) {
      const list = handlers.get(event) ?? new Set();
      handlers.set(event, list);
      list.add(handler);
      return () => { list.delete(handler); if (!list.size) handlers.delete(event); };
    },
    effect(factory) { cleanup = factory(); },
  };
  sandbox.applyPlugin(ctx, { settleDelayMs: 0, ...config });
  function emit(event, payload) {
    for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
  }
  function agent(id = "session-a", extra = {}) {
    const messages = [];
    const value = {
      id, status: "idle", messages, cancels: 0,
      cancel() { this.cancels++; },
      followup(message) { messages.push(message); },
      ...extra,
    };
    return value;
  }
  function stream(value, text = "Execute.\n".repeat(40), attemptId = "attempt") {
    emit("agent/assistant-stream", { agent: value, frame: { type: "chunk", attemptId,
      chunk: { type: "reasoning-delta", text } } });
  }
  async function tick(ms = 0) {
    const until = now + ms;
    await flush();
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.at;
      timers.delete(id);
      timer.fn();
      await flush();
    }
    now = until;
    await flush();
  }
  return { agent, stream, emit, tick, dispose: () => cleanup(), handlers, timers, logs, io, ctx };
}

test("both action switches disabled leave the session untouched", async () => {
  let calls = 0;
  const h = await harness({ autoAbort: false, autoCompact: false }, { commands: { execute() { calls++; return success(); } } });
  const agent = h.agent();
  h.stream(agent);
  await h.tick();
  assert.equal(calls, 0);
  assert.equal(agent.cancels, 0);
  assert.equal(agent.messages.length, 0);
  h.dispose();
});

test("published entry loads and creates a real audit file", { timeout: 2000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "watchdog-smoke-"));
  const previous = process.env.DSH_HOME;
  let cleanup;
  try {
    process.env.DSH_HOME = directory;
    const { apply } = await import(`./index.js?smoke=${Date.now()}`);
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    const handlers = new Map();
    const continued = deferred();
    const commands = { execute: success };
    apply({
      get: key => key === "commands" ? commands : undefined,
      on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event); },
      effect(factory) { cleanup = factory(); },
    }, { settleDelayMs: 0 });
    const agent = { id: "smoke-session", status: "idle", cancel() {}, followup: continued.resolve };
    handlers.get("agent/assistant-stream")({ agent, frame: { type: "chunk", attemptId: "smoke",
      chunk: { type: "reasoning-delta", text: "Execute.\n".repeat(40) } } });
    const message = await continued.promise;
    assert.equal(message.content[0].text, normalizeConfig({}).continueText);
    const path = join(directory, "plugins", "dsh-degeneration-watchdog", "watchdog.log");
    assert.equal(existsSync(path), true);
    assert.match(readFileSync(path, "utf8"), /continue message sent/);
    cleanup();
    assert.equal(handlers.size, 0);
  } finally {
    cleanup?.();
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

const success = () => ({ commandId: "cmd-1", result: { kind: "success" } });

test("successful wrapped command resumes once and clears timers", async () => {
  let calls = 0;
  const h = await harness({}, { commands: { execute() { calls++; return success(); } } });
  const agent = h.agent();
  h.stream(agent);
  h.stream(agent);
  await h.tick();
  assert.equal(calls, 1);
  assert.equal(agent.cancels, 1);
  assert.equal(agent.messages.length, 1);
  assert.equal(agent.messages[0].content[0].text, normalizeConfig({}).continueText);
  assert.equal(h.timers.size, 0);
  h.dispose();
  assert.equal(h.handlers.size, 0);
});

test("legacy command result is still supported", async () => {
  const h = await harness({}, { commands: { execute: () => ({ kind: "success" }) } });
  const agent = h.agent();
  h.stream(agent);
  await h.tick();
  assert.equal(agent.messages.length, 1);
  h.dispose();
});

test("command error does not resume or bypass its failure", async () => {
  let directCalls = 0;
  const h = await harness({}, {
    commands: { execute: () => ({ commandId: "cmd-1", result: { kind: "error", text: "busy" } }) },
    compaction: { compactNow() { directCalls++; return null; } },
  });
  const agent = h.agent();
  h.stream(agent);
  await h.tick();
  assert.equal(agent.messages.length, 0);
  assert.equal(directCalls, 0);
  h.dispose();
});

test("agent-local compaction service receives its own agent and operation id", async () => {
  let received;
  const h = await harness();
  const agent = h.agent();
  const compaction = { compactNow(value, signal, id) { received = { value, signal, id }; return null; } };
  agent.ctx = { get: key => key === "compaction" ? compaction : undefined };
  h.stream(agent);
  await h.tick();
  assert.equal(received.value, agent);
  assert.equal(received.signal.aborted, false);
  assert.match(received.id, /^dsh-degeneration-watchdog-/);
  assert.equal(agent.messages.length, 1);
  h.dispose();
});

test("legacy root store command service remains resolvable", async () => {
  const h = await harness();
  h.ctx.reflect = { store: { [Symbol("commands")]: { name: "commands", value: { execute: success } } } };
  const agent = h.agent();
  h.stream(agent);
  await h.tick();
  assert.equal(agent.messages.length, 1);
  h.dispose();
});

test("unresolved command falls back to direct compaction", async () => {
  let directCalls = 0;
  const h = await harness({}, {
    commands: { execute: () => undefined },
    compaction: { compactNow() { directCalls++; return null; } },
  });
  const agent = h.agent();
  h.stream(agent);
  await h.tick();
  assert.equal(directCalls, 1);
  assert.equal(agent.messages.length, 1);
  h.dispose();
});

test("missing services send neither slash-command messages nor continue", async () => {
  const h = await harness();
  const agent = h.agent();
  h.stream(agent);
  await h.tick();
  assert.equal(agent.messages.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.handlers.has("session/event"), false);
  h.dispose();
});

test("command timeout aborts signal and permits retry after provider settles", async () => {
  const pending = deferred();
  let stepSignal;
  let calls = 0;
  const h = await harness({ compactTimeoutMs: 100 }, { commands: {
    execute(_agent, _line, _args, signal) { calls++; stepSignal = signal; return pending.promise; },
  } });
  const agent = h.agent();
  h.stream(agent);
  await h.tick(100);
  assert.equal(stepSignal.aborted, true);
  assert.equal(agent.messages.length, 0);
  assert.equal(h.timers.size, 0);
  h.stream(agent);
  await h.tick();
  assert.equal(calls, 1, "a provider ignoring abort must not overlap a second compaction");
  pending.resolve(success());
  await h.tick();
  assert.equal(agent.messages.length, 0, "late success must not send continue");
  h.stream(agent);
  await h.tick();
  assert.equal(calls, 2);
  assert.equal(agent.messages.length, 1);
  h.dispose();
});

test("direct compaction timeout aborts its provider", async () => {
  let stepSignal;
  const pending = deferred();
  const h = await harness({ compactTimeoutMs: 100 }, { compaction: {
    compactNow(_agent, signal) { stepSignal = signal; return pending.promise; },
  } });
  const agent = h.agent();
  h.stream(agent);
  await h.tick(100);
  assert.equal(stepSignal.aborted, true);
  assert.equal(agent.messages.length, 0);
  h.dispose();
  pending.reject(new Error("late failure"));
  await flush();
});

test("synchronous provider disposal followed by throw is contained", async () => {
  let stepSignal;
  const h = await harness({}, { commands: { execute(_agent, _line, _args, signal) {
    stepSignal = signal;
    h.dispose();
    throw new Error("reentrant provider failure");
  } } });
  const agent = h.agent();
  h.stream(agent);
  await h.tick();
  assert.equal(stepSignal.aborted, true);
  assert.equal(agent.messages.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.handlers.size, 0);
});

test("plugin disposal aborts an active command and suppresses late followup", async () => {
  let stepSignal;
  const pending = deferred();
  const h = await harness({}, { commands: { execute(_agent, _line, _args, signal) {
    stepSignal = signal;
    return pending.promise;
  } } });
  const agent = h.agent();
  h.stream(agent);
  await flush();
  h.dispose();
  await flush();
  assert.equal(stepSignal.aborted, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.handlers.size, 0);
  pending.resolve(success());
  await h.tick();
  assert.equal(agent.messages.length, 0);
});

test("agent disposal aborts only that agent rescue", async () => {
  const pending = deferred();
  let stepSignal;
  const h = await harness({}, { commands: { execute(agent, _line, _args, signal) {
    if (agent.id === "session-b") return success();
    stepSignal = signal;
    return pending.promise;
  } } });
  const a = h.agent(), b = h.agent("session-b");
  h.stream(a);
  await flush();
  h.emit("agent/disposed", { agent: a });
  await flush();
  assert.equal(stepSignal.aborted, true);
  h.stream(b);
  await h.tick();
  assert.equal(b.messages.length, 1);
  pending.resolve(success());
  await h.tick();
  assert.equal(a.messages.length, 0);
  h.dispose();
});

test("idle timeout prevents compaction and resume", async () => {
  let calls = 0;
  const h = await harness({ idleTimeoutMs: 100 }, { commands: { execute() { calls++; return success(); } } });
  const agent = h.agent("session-a", { status: "running" });
  h.stream(agent);
  await h.tick(100);
  assert.equal(calls, 0);
  assert.equal(agent.messages.length, 0);
  assert.equal(h.timers.size, 0);
  h.dispose();
});

test("whenIdle rejection stops rescue", async () => {
  let calls = 0;
  const h = await harness({}, { commands: { execute() { calls++; return success(); } } });
  const agent = h.agent("session-a", { whenIdle: () => Promise.reject(new Error("disposed")) });
  h.stream(agent);
  await h.tick();
  assert.equal(calls, 0);
  assert.equal(agent.messages.length, 0);
  h.dispose();
});

test("plugin disposal during idle wait clears polling", async () => {
  const h = await harness();
  const agent = h.agent("session-a", { status: "running" });
  h.stream(agent);
  await flush();
  assert.ok(h.timers.size > 0);
  h.dispose();
  await flush();
  assert.equal(h.timers.size, 0);
  assert.equal(agent.messages.length, 0);
});

test("settle delay is cancellable", async () => {
  const h = await harness({ settleDelayMs: 450 }, { commands: { execute: success } });
  const agent = h.agent();
  h.stream(agent);
  await h.tick(200);
  assert.equal(agent.messages.length, 0);
  h.dispose();
  await h.tick(1000);
  assert.equal(agent.messages.length, 0);
  assert.equal(h.timers.size, 0);
});

test("new user activity during settle prevents automatic continue", async () => {
  const h = await harness({ settleDelayMs: 450 }, { commands: { execute: success } });
  const agent = h.agent();
  h.stream(agent);
  await h.tick(200);
  agent.status = "running";
  await h.tick(250);
  assert.equal(agent.messages.length, 0);
  h.dispose();
});

test("selftest timer is removed on plugin disposal", async () => {
  const h = await harness({ selftestReasoning: true });
  const agent = h.agent();
  h.emit("agent/assistant-stream", { agent, frame: { type: "end", attemptId: "normal" } });
  assert.equal(h.timers.size, 1);
  h.dispose();
  await h.tick(1000);
  assert.equal(agent.cancels, 0);
  assert.equal(h.timers.size, 0);
});

test("small windows retain enough text for a higher explicit detection threshold", async () => {
  const h = await harness({ reasoningWindowChars: 512, reasoningMinTextLength: 2000 }, { commands: { execute: success } });
  const agent = h.agent();
  h.stream(agent, "Execute.\n".repeat(150));
  await h.tick();
  assert.equal(agent.messages.length, 0);
  h.stream(agent, "Execute.\n".repeat(150));
  await h.tick();
  assert.equal(agent.messages.length, 1);
  h.dispose();
});

test("same attempt id in different agents does not combine buffers", async () => {
  let calls = 0;
  const h = await harness({}, { commands: { execute() { calls++; return success(); } } });
  const a = h.agent(), b = h.agent("session-b");
  h.stream(a, "Execute.\n".repeat(20));
  h.stream(b, "Execute.\n".repeat(20));
  await h.tick();
  assert.equal(calls, 0);
  h.stream(a, "Execute.\n".repeat(20));
  await h.tick();
  assert.equal(calls, 1);
  assert.equal(b.cancels, 0);
  h.dispose();
});

test("disabled plugin does not schedule a selftest or rescue", async () => {
  const h = await harness({ enabled: false, selftestReasoning: true });
  const agent = h.agent();
  h.stream(agent);
  h.emit("agent/assistant-stream", { agent, frame: { type: "end", attemptId: "normal" } });
  await h.tick(1000);
  assert.equal(agent.cancels, 0);
  assert.equal(h.timers.size, 0);
  h.dispose();
});

test("rescue budget resets after inactivity and is per-session", async () => {
  let calls = 0;
  const h = await harness({ maxRescues: 1, cooldownMs: 1000 }, { commands: { execute() { calls++; return success(); } } });
  const a = h.agent(), b = h.agent("session-b");
  h.stream(a);
  await h.tick();
  h.stream(a);
  h.stream(b);
  await h.tick();
  assert.equal(calls, 2);
  await h.tick(1001);
  h.stream(a);
  await h.tick();
  assert.equal(calls, 3);
  h.dispose();
});

test("audit creates its directory before appending", async () => {
  const h = await harness();
  assert.equal(h.io[0][0], "mkdir");
  assert.equal(h.io[0][1], "/audit-home/plugins/dsh-degeneration-watchdog");
  assert.equal(h.io[0][2].recursive, true);
  assert.equal(h.io[1][0], "append");
  h.dispose();
});

test("audit file failure is surfaced once without breaking rescue", async () => {
  const h = await harness({}, { commands: { execute: success } }, { failLog: true });
  const agent = h.agent();
  h.stream(agent);
  await h.tick();
  assert.equal(agent.messages.length, 1);
  assert.equal(h.logs.filter(args => String(args[0]).includes("file audit unavailable")).length, 1);
  h.dispose();
});
