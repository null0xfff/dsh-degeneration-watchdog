# Changelog

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
