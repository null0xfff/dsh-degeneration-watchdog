# dsh-degeneration-watchdog

DSH 插件：实时检测 AI 流式回复的退化（思维链或正文中同一段文字循环输出），
自动执行 **打断 → /compact 压缩 → 发送“继续”** 的救援闭环。

## 工作方式

- 订阅 `agent/assistant-stream` 流式帧，按 `text-delta`（正文）与
  `reasoning-delta`（思维链）双通道独立聚合、独立检测。
- 依据实测（DeepSeek v4.1 flash）：退化首发于思维链，短行（如“执行。/好。”）
  循环上百次而正文不出，因此思维链通道行长门槛降到 2 字符、周期上限 8 行、
  窗口 16K 字符。
- 每通道双信号判定（纯文本统计，无模型调用）：
  - 行级循环：周期 1~8(4) 行的模式重复 ≥5(3) 次；
  - n-gram 塌缩：窗口内 distinct/total n-gram 比率 < 0.12。
- 触发后的救援闭环（三级降级）：
  1. **命令通道**（首选）：`serviceForAgent(agent, "compaction")` 之外，`commands`
     服务挂在宿主组合（`dsh-base` cordis.patch.yml），不在 agent preset fiber，
     `serviceForAgent` 必返回 undefined。插件遍历根树 `ctx.reflect.store`
     符号表，匹配 `impl.name === "commands"` 且 `impl.value.execute` 为函数，
     再调 `commands.execute(agent, "/compact", [], signal)`。该 Remote 方法会
     记录 `command/run`/`command/done` 生命周期事件，UI 的"正在压缩"提示挂在
     此生命周期上，故走此路径与手动 `/compact` 体验完全一致（已实测确认）。
  2. **直调**：`serviceForAgent(agent, "compaction")` → `compactNow()`。
     绕过命令生命周期，UI 无压缩提示，仅在命令通道失败时兜底。
  3. **降级**：`agent.followup("/compact")` 经消息层而非命令拦截层，最不可控，
     仅作最后手段。
- cancel 后延迟 450ms 再发送续写（`continueText`），避免 continue 被会话状态机吞掉。
- 防抖：每会话滚动窗口内最多救援 3 次（`maxRescues`，0 为不限），冷却 60s。

## 配置（cordis.patch.yml）

| 键 | 默认 | 说明 |
|---|---|---|
| enabled | true | 总开关 |
| windowChars / minTextLength | 8192 / 400 | 正文通道窗口与启用门槛 |
| repeatThreshold / maxCycle / minLineLength | 3 / 4 / 8 | 正文行循环判据 |
| dedupRatio / ngramSize | 0.12 / 8 | n-gram 塌缩判据 |
| reasoningWindowChars / reasoningMinTextLength | 16384 / 240 | 思维链通道窗口与门槛 |
| reasoningRepeatThreshold / reasoningMaxCycle / reasoningMinLineLength | 5 / 8 / 2 | 思维链行循环判据 |
| reasoningDedupRatio | 0.12 | 思维链 n-gram 塌缩判据 |
| autoAbort / autoCompact | true | 动作开关 |
| continueText | 继续 | 压缩后续写指令 |
| maxRescues / cooldownMs | 3 / 60000 | 救援预算与冷却 |

## 测试

`lib/detector.test.mjs` 覆盖正文/思维链正常文本、真实退化样本、周期不足噪声等
9 个用例：`node lib/detector.test.mjs`。

## 安装

在 profile 的 `package.json` 中加入依赖并在 `dsh.profile.bundles` 注册，
然后 `pnpm install`，重启 DSH 生效。
