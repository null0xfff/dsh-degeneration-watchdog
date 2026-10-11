# dsh-degeneration-watchdog

![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg) ![node: >=20](https://img.shields.io/badge/node-%3E%3D20-5fa04e.svg) ![version](https://img.shields.io/badge/version-0.6.0-4d6bfe)

> 🛟 **模型转圈时，它替你踩刹车。** 实时检测 AI 流式回复的退化（思维链或正文中同一段文字循环输出），自动执行 **打断 → /compact 压缩 → 发送"继续"** 的救援闭环，把挂死的会话拉回正轨。

长任务跑过夜、深度研究多轮迭代时，模型偶尔陷入"执行。/好。/执行。/好。"式的短行死循环——正文永远不出，token 持续燃烧。本插件订阅流式帧做纯文本统计检测（无模型调用、零额外开销），命中即自动救援。

## 目录

- [工作方式](#工作方式) · [救援链](#救援链) · [安装](#安装) · [配置](#配置) · [测试](#测试) · [日志](#日志) · [已知限制](#已知限制)

## 工作方式

订阅 `agent/assistant-stream` 流式帧，按 `text-delta`（正文）与 `reasoning-delta`（思维链）双通道独立聚合、独立检测。

依据实测（DeepSeek v4.1 flash）：退化首发于思维链，短行（如"执行。/好。"）循环上百次而正文不出。因此思维链通道行长门槛降到 2 字符、周期上限 8 行、窗口 16K 字符；正文通道参数更保守，避免误伤正常长输出。

每通道双信号判定：

- **行级循环**：周期 1~8(4) 行的模式重复 ≥5(3) 次；命中即报 `line-cycle`。
- **n-gram 塌缩**：窗口内 distinct/total n-gram 比率 < 0.12；命中即报 `ngram-collapse`。
- **短行快路径**（正文通道）："循环甲乙丙丁"这类长度不足行门槛的完全相同短行，行长过滤与 n-gram 都会漏（比率约 0.13 > 0.12），用更低行长地板（2 字符）+ 更高重复门槛（≥8 次）二次判定。

模板化代码、逐行变化的内容（行号/数值递增）不会误报；只有 2 个周期的短重复也不触发（门槛 5）。

## 救援链

命中退化后，按会话执行三级降级（均经实测验证）：

1. **命令通道**（首选）：`commands` 服务挂在宿主组合（`dsh-base`），不在 agent preset fiber，`serviceForAgent` 拿不到。插件遍历根树 `ctx.reflect.store` 符号表匹配 `impl.name === "commands"`，调 `commands.execute(agent, "/compact", [], signal)`——与手动 `/compact` 完全同一生命周期，UI 提示一致。
2. **直调兜底**：`serviceForAgent(agent, "compaction")` → `compactNow()`。绕过命令生命周期，UI 无压缩提示。
3. **消息层降级**：`agent.followup("/compact")`，最不可控，仅作最后手段。

压缩完成后发送 `continueText`（默认"继续"）让模型接着干；cancel 后有 450ms 稳定延迟，避免续写被会话状态机吞掉。

防抖：每会话冷却窗口（默认 60s）内最多救援 3 次（`maxRescues`，0 为不限），防止救援本身形成循环。

## 安装

**Web 端：**

```sh
dsh plugin --profile web add https://github.com/null0xff/dsh-degeneration-watchdog
```

**桌面端：** 插件 Plugins → 添加插件，粘贴同一仓库 URL。

**手动安装：** 在 profile 的 `package.json` 中加入依赖并在 `dsh.profile.bundles` 注册，`pnpm install` 后重启 DSH 生效。

## 配置（cordis.patch.yml）

| 键 | 默认 | 说明 |
|---|---|---|
| enabled | true | 总开关 |
| windowChars / minTextLength | 8192 / 400 | 正文通道窗口与启用门槛 |
| repeatThreshold / maxCycle / minLineLength | 3 / 4 / 8 | 正文行循环判据 |
| shortLineMinLength / shortLineRepeatThreshold | 2 / 8 | 正文短行快路径判据 |
| dedupRatio / ngramSize | 0.12 / 8 | n-gram 塌缩判据 |
| reasoningWindowChars / reasoningMinTextLength | 16384 / 240 | 思维链通道窗口与门槛 |
| reasoningRepeatThreshold / reasoningMaxCycle / reasoningMinLineLength | 5 / 8 / 2 | 思维链行循环判据 |
| reasoningDedupRatio | 0.12 | 思维链 n-gram 塌缩判据 |
| autoAbort / autoCompact | true | 动作开关 |
| continueText | 继续 | 压缩后续写指令 |
| maxRescues / cooldownMs | 3 / 60000 | 救援预算与冷却 |
| selftestReasoning | false | 首回合后注入合成退化流自测完整救援链 |

## 测试

```sh
node lib/detector.test.mjs          # 检测器：17 用例（正常文本/退化样本/噪声/跨语言/混合）
node selftest-shortline.mjs         # 短行快路径：5 用例
```

## 日志

救援全程写审计日志 `$DSH_HOME/plugins/dsh-degeneration-watchdog/watchdog.log`（含命中判据、样本片段、每步结果），事后可完整复盘。

## 已知限制

- 一次回合被拆成多个 attempt（工具调用分段）时，缓冲按 attempt 独立累积；跨 attempt 的慢速退化不触发。
- 纯无换行的长循环依赖 n-gram 塌缩信号，正文通道该信号比行循环迟钝。
- `verbose: true` 时输出检测细节到控制台。

## License

MIT
