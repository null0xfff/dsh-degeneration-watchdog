# Changelog

## 0.8.0

- Cancel with `keepInbox: true`, preserving queued turn and steering input. Pending input takes priority over compaction and synthetic continuation; new input during rescue aborts dependent actions.
- Pause active native Goals before cancellation and recover only the same paused revision after successful rescue. Native Goal recovery replaces synthetic continuation and respects round budgets and user edits.
- Add `resumeGoal` (default `true`). Pre-existing paused/blocked/disarmed Goals remain unchanged. Failed rescue, input competition, disposal or disabled recovery leaves the plugin-paused Goal stopped for manual handling.
- Defer rescue onto a microtask and use the native agent initiator for Goal mutations, avoiding nested session writes and duplicate cancellation.
- Resolve current isolated services through `agentPresets.serviceFor` before legacy adapters; distinguish maintenance from idle and inspect native inbox lists.
- Add queue/Goal regressions and real Session/Goal/goal-round-driver integration tests against DSH `0.2.0-rc.2`, with a controlled Agent and no model calls.
- Lock integration-test development dependencies and add a Node 22/24 integration CI matrix alongside Node 20/22 unit tests.

### Upgrade notes

Successful rescue of an active Goal now resumes the native Goal instead of sending `continueText`. Ordinary conversations retain continuation when idle and no unfinished Goal or pending input owns the session. Set `resumeGoal: false` to keep a plugin-paused Goal stopped. On queue competition or failure, inspect the log and resume the Goal manually when appropriate. Goal rescue requires `autoAbort: true`.

Full development tests now require `npm ci --ignore-scripts` and Node.js 22+. `npm run test:unit` retains the dependency-free path; runtime SDK packages are not bundled with the plugin.

## 0.7.2

- Retain unresolved compaction ownership across plugin reapplication and module reloads in the same host JavaScript realm, keyed weakly by the exact agent.
- Reserve ownership before provider invocation and release it only when the provider promise settles. Disposal aborts owned operations without discarding unresolved ownership.
- Add regressions for reapplication and module reload with a provider that ignores cancellation.

## 0.7.1

- Observe provider outcomes and cancellation before invoking a provider, containing synchronous disposal followed by a thrown error without an unhandled rejection.
- Check cancellation again immediately before provider invocation.
- Add a regression that fails with the previous implementation.

## 0.7.0

- Preserve changing nonempty short lines during cycle matching; keep blank-line tolerance.
- Isolate stream buffers by agent and attempt, scan only the channel receiving new text, and clean up only the disposed agent.
- Bound idle and compaction waits; abort provider signals on timeout or disposal.
- Observe late provider settlement and prevent overlapping compactions when cancellation is ignored.
- Cancel delayed continuation and synthetic selftests on plugin or agent disposal.
- Handle wrapped command results and stop on command errors instead of treating them as success.
- Remove message-based `/compact` fallback: `followup()` sends model input, not a confirmed command invocation. Missing compaction services now stop the rescue without an automatic continuation.
- Create audit log directories and report file-write failures; omit detected reply samples from logs.
- Validate action flags, continuation text, rescue budget, and timeout settings.
- Use portable test imports, assert short-line expectations, and add lifecycle regression tests and a real module smoke test.
- Add `npm test` and a Linux/Windows, Node 20/22 GitHub Actions matrix.

### Upgrade notes

The command and direct-compaction service paths remain supported. Installations that relied on sending `/compact` through a model-facing message must expose a real command or compaction service. Timeout, cancellation, errors, or missing services stop the current rescue; continuation is sent only after a successful configured action and an idle check.

New settings: `idleTimeoutMs` (15000), `compactTimeoutMs` (90000), and `settleDelayMs` (450).
