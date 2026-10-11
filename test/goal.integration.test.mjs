import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry, agentEvents } from "@deepseek-ai/dsh-agent";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { GoalService } from "@deepseek-ai/dsh-goal";
import * as goalDriver from "@deepseek-ai/dsh-goal-round-driver";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

const directory = mkdtempSync(join(tmpdir(), "watchdog-goal-"));
const previous = process.env.DSH_HOME;
process.env.DSH_HOME = directory;
const watchdog = await import("../lib/index.js");
if (previous === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = previous;
const logPath = join(directory, "plugins", "dsh-degeneration-watchdog", "watchdog.log");
const drain = () => new Promise(resolve => setImmediate(resolve));
after(async () => { await drain(); rmSync(directory, { recursive: true, force: true }); });

async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("integration condition did not settle");
    await drain();
  }
}
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

let sequence = 0;
async function fixture(t, { compact, config = {}, goalPhase = "active", maxGoalRounds = 10 } = {}) {
  const ctx = new Context();
  ctx.plugin(AgentRegistry);
  ctx.plugin(SessionStore);
  ctx.plugin(SessionProjectionRegistry);
  ctx.plugin(GoalService);
  ctx.plugin(goalDriver);
  let compactCalls = 0;
  let compactGoal;
  const commands = { execute: async (agent, _line, _args, signal) => {
    compactCalls++;
    compactGoal = ctx.get("goals").get(agent);
    assert.equal(agent.status, "idle");
    assert.equal(agent.phase.kind, "idle");
    agent.phase = { kind: "maintenance" };
    try {
      await compact?.(agent, signal);
      return { commandId: "integration-command", result: { kind: "success" } };
    } finally { agent.phase = { kind: "idle" }; }
  } };
  ctx.provide("commands", commands);
  const fiber = ctx.plugin(watchdog, { idleTimeoutMs: 200, compactTimeoutMs: 200, settleDelayMs: 0, ...config });
  await drain();
  const agents = ctx.get("agents"), goals = ctx.get("goals");
  const session = ctx.get("sessions").create(`watchdog-goal-fixture-${++sequence}`);
  const cancellations = [], messages = [];
  const agent = {
    id: session.id, session, ctx, status: "running", phase: { kind: "running", turn: 1 },
    inbox: { nextTurn: [], nextStep: [] },
    cancel(cause, options) {
      cancellations.push({ cause, options });
      if (!options?.keepInbox) { this.inbox.nextTurn.splice(0); this.inbox.nextStep.splice(0); }
      this.status = "idle";
      this.phase = { kind: "idle" };
      agentEvents(ctx, this).emit("agent/status", { status: "idle" });
    },
    async whenIdle() {},
    followup(message) {
      messages.push(message);
      this.inbox.nextTurn.push(message);
      agentEvents(ctx, this).emit("agent/inbox/inserted", { message });
    },
  };
  agents.register(agent);
  await drain();
  assert.equal(agents.get(agent.id), agent);
  let created;
  if (goalPhase) {
    created = agents.withInitiator(agent, () => goals.create(agent, { objective: "Native Goal fixture", maxGoalRounds }));
    if (goalPhase === "paused") agents.withInitiator(agent, () => goals.pause(agent, { id: created.id, revision: created.revision }));
  }
  function append(type, data, ...options) {
    return agents.withInitiator(agent, () => session.append(type, data, ...options));
  }
  function stream() {
    return agents.withInitiator(agent, () => agentEvents(ctx, agent).emit("agent/assistant-stream", {
      frame: { type: "chunk", attemptId: "integration-attempt", index: 0,
        chunk: { type: "reasoning-delta", index: 0, text: "Execute.\n".repeat(40) } },
    }));
  }
  async function settled() {
    await until(() => existsSync(logPath) && readFileSync(logPath, "utf8").includes(`rescue done ${session.id}\n`));
    await drain();
  }
  t.after(async () => { await fiber.dispose(); await ctx.fiber.dispose(); await drain(); });
  return { ctx, agents, goals, session, agent, append, stream, settled, cancellations, messages, created,
    get compactCalls() { return compactCalls; }, get compactGoal() { return compactGoal; } };
}

test("native Session publication defers Goal mutation and native driver queues only a Goal round", async t => {
  const f = await fixture(t);
  f.ctx.on("session/event", (session, event) => {
    if (session === f.session && event.type === "step/start") f.stream();
  });
  f.append("turn/start", { turn: 1 });
  f.append("step/start", { turn: 1, step: 1 });
  assert.equal(f.goals.get(f.agent).phase, "active", "publication must finish before Goal writes");
  assert.equal(f.cancellations.length, 0);
  await f.settled();
  await until(() => f.messages.length > 0);
  const goal = f.goals.get(f.agent);
  assert.equal(goal.phase, "active");
  assert.equal(goal.activation, "armed");
  assert.equal(goal.revision, 3);
  assert.equal(f.compactGoal.phase, "paused");
  assert.equal(f.compactGoal.revision, 2);
  assert.equal(f.compactCalls, 1);
  assert.equal(f.cancellations.length, 1, "native pause must not cause an extra cancellation");
  assert.equal(f.cancellations[0].options.keepInbox, true);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].source.kind, "goal");
  assert.equal(f.messages[0].source.goalId, goal.id);
  assert.equal(f.messages[0].source.revision, goal.revision);
  assert.ok(!f.messages.some(message => message.source.kind === "dsh-degeneration-watchdog"));
});

test("native Goal stays paused while queued user and steering input are preserved", async t => {
  const f = await fixture(t);
  const queued = createUserMessage({ content: [{ type: "text", text: "Queued user work" }], source: { kind: "user" } });
  const steering = createUserMessage({ content: [{ type: "text", text: "Queued steering work" }], source: { kind: "user" } });
  f.agent.inbox.nextTurn.push(queued);
  f.agent.inbox.nextStep.push(steering);
  f.stream();
  await f.settled();
  assert.equal(f.agent.inbox.nextTurn[0], queued);
  assert.equal(f.agent.inbox.nextStep[0], steering);
  assert.equal(f.cancellations[0].options.keepInbox, true);
  assert.equal(f.goals.get(f.agent).phase, "paused");
  assert.equal(f.compactCalls, 0);
  assert.equal(f.messages.length, 0);
});

test("native Goal edited during compaction is not resumed with the old revision", async t => {
  const pending = deferred();
  const f = await fixture(t, { compact: () => pending.promise });
  f.stream();
  await until(() => f.compactCalls === 1);
  const paused = f.goals.get(f.agent);
  assert.equal(paused.phase, "paused");
  const edited = f.agents.withInitiator(f.agent, () => f.goals.edit(f.agent,
    { id: paused.id, revision: paused.revision }, { objective: "Changed by the user" }));
  pending.resolve();
  await f.settled();
  const final = f.goals.get(f.agent);
  assert.equal(final.phase, "paused");
  assert.equal(final.revision, edited.revision);
  assert.equal(final.objective, "Changed by the user");
  assert.equal(f.messages.length, 0);
});

test("pre-existing native paused Goal is not rearmed", async t => {
  const f = await fixture(t, { goalPhase: "paused" });
  const paused = f.goals.get(f.agent);
  f.stream();
  await f.settled();
  const final = f.goals.get(f.agent);
  assert.equal(final.phase, "paused");
  assert.equal(final.revision, paused.revision);
  assert.equal(final.activation, "disarmed");
  assert.equal(f.messages.length, 0);
});

test("native disarmed Goal remains disarmed without a new revision", async t => {
  const f = await fixture(t);
  const before = f.agents.withInitiator(f.agent, () => f.goals.disarm(f.agent));
  assert.equal(before.activation, "disarmed");
  f.stream();
  await f.settled();
  const final = f.goals.get(f.agent);
  assert.equal(final.phase, "active");
  assert.equal(final.activation, "disarmed");
  assert.equal(final.revision, before.revision);
  assert.equal(f.messages.length, 0);
});

test("native Goal round exhaustion is respected without an ordinary continuation", async t => {
  const f = await fixture(t, { maxGoalRounds: 1 });
  f.append("turn/start", { turn: 1 });
  const round = createUserMessage({ content: [{ type: "text", text: "Goal round fixture" }], source: {
    kind: "goal", goalId: f.created.id, revision: f.created.revision, round: 1,
  } });
  f.append("user/message", round, { surfaceOp: "append" });
  assert.equal(f.goals.get(f.agent).roundsStarted, 1);
  f.stream();
  await f.settled();
  const final = f.goals.get(f.agent);
  assert.equal(final.phase, "paused");
  assert.equal(final.roundsStarted, 1);
  assert.equal(final.maxGoalRounds, 1);
  assert.equal(f.messages.length, 0);
  assert.match(readFileSync(logPath, "utf8"), /exhausted 1 goal rounds/);
});

test("no native Goal retains the ordinary continuation path", async t => {
  const f = await fixture(t, { goalPhase: null });
  f.stream();
  await f.settled();
  assert.equal(f.goals.get(f.agent), undefined);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].source.kind, "dsh-degeneration-watchdog");
  assert.equal(f.cancellations[0].options.keepInbox, true);
});
