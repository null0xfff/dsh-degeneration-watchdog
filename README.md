# dsh-degeneration-watchdog

![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg) ![node: >=20](https://img.shields.io/badge/node-%3E%3D20-5fa04e.svg) ![version](https://img.shields.io/badge/version-0.7.1-4d6bfe)

实时检测 AI 流式回复中的重复退化，执行 **打断 → 压缩 → 继续**。检测只做文本统计，不调用额外模型；压缩本身可能调用宿主配置的模型。

## 工作方式

订阅 `agent/assistant-stream`，按正文 `text-delta` 和思维链 `reasoning-delta` 独立累积。缓冲按 agent 和 attempt 分隔，避免不同会话之间串流。

- **行级循环**：正文检测最多 4 行、至少 3 次的周期；思维链检测最多 8 行、至少 5 次的周期。
- **n-gram 塌缩**：尾部窗口的 distinct/total 比率低于默认阈值 `0.12`。
- **正文短行路径**：最低行长 2 字符，至少重复 8 次。

空行不参与周期比较；变化的非空短行会保留，避免把持续推进的短标签和重复长语句误判为连续循环。这些启发式仍可能命中正常的高度重复输出，可调整参数或关闭自动动作。

## 救援链

1. `autoAbort` 开启时取消当前回合，并有界等待 agent 空闲。支持宿主 `whenIdle()`；未停止或等待超时则结束本次救援。
2. 优先调用 `commands.execute(agent, "/compact", [], signal)`，检查当前宿主的 `{ commandId, result }` 返回值，同时支持旧版直接返回 `CommandResult`。
3. 命令服务不存在或没有解析到 `/compact` 时，调用 agent 所属 `compaction.compactNow()`。已执行命令返回错误或抛出异常时结束救援，不重复执行另一压缩通道。
4. 压缩成功后等待 `settleDelayMs`，再次确认 agent 空闲，再发送 `continueText`。

`followup()` 是普通模型消息入口，插件不再用它发送 `/compact`。两个服务通道均不可用、执行失败、超时或插件卸载时，停止本次救援并记录原因。两个自动动作均关闭时只进行被动检测。

超时会中止传入服务的 signal；若服务忽略取消，插件仍观察其 Promise，并在它真正结束前阻止该 agent 的新压缩，避免重叠修改会话。超时后的迟到结果不会发送“继续”。插件或 agent 卸载时取消进行中的等待、续写延迟和自测定时器。

每会话最多连续救援 `maxRescues` 次，`0` 表示不限。距上次救援开始超过 `cooldownMs` 后，下一次救援重置计数；这是空闲间隔重置，不是滚动窗口限流。

## 安装

```sh
dsh plugin --profile web add https://github.com/null0xfff/dsh-degeneration-watchdog
```

桌面端可在 Plugins 中添加同一仓库 URL。手动安装时，在 profile 的 `package.json` 中加入依赖并在 `dsh.profile.bundles` 注册，安装依赖后重启 DSH。

## 配置

配置位于 `cordis.patch.yml`。

| 键 | 默认 | 说明 |
|---|---|---|
| enabled | true | 总开关 |
| verbose | false | 命中时额外记录 attempt 与缓冲长度 |
| windowChars / minTextLength | 8192 / 400 | 正文统计窗口与检测门槛 |
| repeatThreshold / maxCycle / minLineLength | 3 / 4 / 8 | 正文行循环判据 |
| shortLineMinLength / shortLineRepeatThreshold | 2 / 8 | 正文短行判据 |
| dedupRatio / ngramSize | 0.12 / 8 | n-gram 塌缩判据 |
| reasoningWindowChars / reasoningMinTextLength | 16384 / 240 | 思维链窗口与检测门槛 |
| reasoningRepeatThreshold / reasoningMaxCycle / reasoningMinLineLength | 5 / 8 / 2 | 思维链行循环判据 |
| reasoningDedupRatio | 0.12 | 思维链 n-gram 塌缩判据 |
| autoAbort / autoCompact | true | 自动动作开关 |
| continueText | 继续 | 成功救援后的续写指令 |
| idleTimeoutMs | 15000 | 等待停止的超时，范围 100–300000ms |
| compactTimeoutMs | 90000 | 每次压缩调用的超时，范围 100–600000ms |
| settleDelayMs | 450 | 续写前稳定延迟，范围 0–5000ms |
| maxRescues / cooldownMs | 3 / 60000 | 每会话预算与空闲间隔重置 |
| selftestReasoning | false | 首个流结束后注入合成退化样本，执行真实救援 |

## 测试

无需额外测试依赖，使用 Node.js 内置断言和测试运行器。

```sh
npm test
```

也可分别运行：

```sh
node lib/detector.test.mjs
node selftest-shortline.mjs
node --test lib/index.test.mjs
```

用例覆盖正常文本、跨语言循环、变化短行、配置边界，以及救援成功、错误返回、超时、迟到结果、卸载清理、会话隔离、预算和日志。生命周期测试采用虚拟宿主和计时器，另有真实模块加载及日志写入的冒烟验证；不操作真实 DSH 会话。

## 日志

审计日志写入 `$DSH_HOME/plugins/dsh-degeneration-watchdog/watchdog.log`，父目录自动创建。没有 `DSH_HOME` 时使用 `TEMP`、`TMP` 或当前目录。文件写入失败会向控制台报告一次，后续仍输出控制台日志。

日志记录检测通道、判据、比率及救援步骤，不记录触发检测的回复样本。文件暂未轮转，应由部署端管理保留周期。

## 已知限制

- 跨 attempt 的慢速退化不合并检测。
- 无换行循环依赖 n-gram 信号，触发时机取决于窗口和阈值。
- 宿主接口尚未稳定；保留可选 registry 解析、agent context 解析和旧版根服务表适配。升级宿主后应验证服务解析与实际压缩效果。
- 忽略取消且永不结束的服务会持续阻止该 agent 的新压缩；插件不会在状态未知时启动重叠压缩。
- 普通高度重复的文本仍可能命中统计判据，检测不是语义进度判断。

## License

MIT
