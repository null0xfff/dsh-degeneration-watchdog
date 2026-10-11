<h1 align="center">DSH Degeneration Watchdog</h1>

<p align="center">模型开始重复打转时，自动尝试打断、压缩上下文并继续任务。</p>

<p align="center">
  <a href="https://github.com/null0xfff/dsh-degeneration-watchdog/actions/workflows/test.yml"><img src="https://github.com/null0xfff/dsh-degeneration-watchdog/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/version-0.8.0-276749" alt="Version 0.8.0"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D20-417e38" alt="Node.js >=20"></a>
  <a href="#许可证"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <a href="https://github.com/null0xfff/dsh-degeneration-watchdog/stargazers"><img src="https://img.shields.io/github/stars/null0xfff/dsh-degeneration-watchdog?style=flat" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#工作方式">工作方式</a> ·
  <a href="#配置">配置</a> ·
  <a href="#常见问题">常见问题</a> ·
  <a href="CHANGELOG.md">更新记录</a>
</p>

## 它解决什么问题

让 DSH 跑长任务时，模型有时会连续输出相同的句子，或在思维链里反复出现“执行。／好。／执行。／好。”。流还在输出，任务却停在原地。

`dsh-degeneration-watchdog` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的后台插件。它监测流式回复中的重复模式，命中后按配置尝试恢复会话：

```text
正文或思维链出现重复模式
          ↓
暂停活动 Goal（如有），保留排队输入并取消当前回合
          ↓
队列为空且会话空闲时，通过宿主服务压缩上下文
          ↓
恢复本插件暂停的 Goal，或为普通会话发送“继续”
```

| 能力 | 实际行为 |
| --- | --- |
| 正文与思维链双通道 | 分别累积、分别检测，思维链使用更低的行长门槛 |
| 两类重复信号 | 检查连续行周期和尾部文本的 n-gram 重复比例 |
| 按会话隔离 | 不同 agent、不同流式 attempt 的缓冲分开维护 |
| 保留排队输入 | 取消时保留下一轮消息与 steering 输入，排队输入优先于自动救援 |
| 原生 Goal 恢复 | 成功救援后按暂停后的 revision 恢复 Goal，由宿主继续驱动轮次 |
| 有界救援 | 停止等待、压缩调用均有超时，每会话有救援预算 |
| 卸载与重载处理 | 取消旧实例的等待；未结束压缩在同一宿主运行环境、同一 agent 上保持互斥 |
| 可排查的日志 | 记录命中原因与救援步骤，自动创建日志目录 |

检测采用本地文本统计，不额外调用模型。上下文压缩和后续续写仍可能产生宿主模型费用。**重复检测是启发式判断，正常的高度重复内容也可能命中。**

## 快速开始

### 安装

先准备好可运行的 DeepSeek Harness。插件声明 Node.js `>=20`；宿主自身的 Node.js 要求以所用 DSH 版本为准。

安装到 Web profile：

```sh
dsh plugin --profile web add https://github.com/null0xfff/dsh-degeneration-watchdog
```

桌面端可在 **Plugins → 添加插件** 中使用同一地址：

```text
https://github.com/null0xfff/dsh-degeneration-watchdog
```

安装或更新后重启对应 DSH 应用，让宿主加载新代码。仓库已包含运行所需的 JavaScript，使用插件无需先构建本项目。

### 确认生效

插件在后台运行，没有独立页面或聊天命令。加载时，宿主控制台与插件日志会出现包含以下内容的记录：

```text
plugin loaded v0.8.0 selftestReasoning=false
```

默认开启检测、自动取消、自动压缩和原生 Goal 恢复。成功救援后，有本插件暂停的 Goal 就恢复该 Goal；普通会话在队列为空且仍空闲时发送“继续”。日常使用无需手动触发。日志位置见[日志与排查](#日志与排查)。

## 工作方式

### 如何判断重复

插件订阅 `agent/assistant-stream`，分别处理正文 `text-delta` 和思维链 `reasoning-delta`。

| 判据 | 正文默认值 | 思维链默认值 |
| --- | --- | --- |
| 开始检测的累计长度 | 400 字符 | 240 字符 |
| n-gram 统计尾部窗口 | 8,192 字符 | 16,384 字符 |
| 行周期上限 | 4 行 | 8 行 |
| 同一周期至少重复 | 3 次 | 5 次 |
| 行周期的最低行长 | 8 字符 | 2 字符 |
| n-gram distinct/total 阈值 | 低于 0.12 | 低于 0.12 |

正文另有短行路径：最低行长 2 字符，至少重复 8 次，使用正文的周期上限。行比较会规范化空白与大小写，并忽略空行；变化的非空短行会保留，避免把短标签之间的重复长语句拼成虚假的连续循环。

### 命中后如何恢复

1. `autoAbort: true` 时，如果原生 `goals` 服务中有活动 Goal，先暂停它并记住返回的新 revision。处置在事件发布结束后的微任务中执行。
2. 调用取消时传入 `keepInbox: true`，保留下一轮消息与 steering 输入，再等待会话空闲。排队输入已经存在或救援期间有新输入到达时，结束本次救援，让排队任务先执行。
3. 优先通过宿主 `commands` 服务执行 `/compact`，确认命令返回成功。命令服务不存在或没有解析到命令时，尝试该 agent 的 `compaction.compactNow()` 服务；已执行命令返回错误或抛出异常时停止。
4. 等待 `settleDelayMs`，再次确认会话空闲且没有排队输入。如果本插件暂停的 Goal 仍是同一 ID、同一 revision 且处于暂停状态，按 `resumeGoal` 设置恢复它；原生轮次驱动负责继续任务，不再插入普通“继续”。
5. 普通会话没有未完成 Goal 时，发送 `continueText`。已有暂停、阻塞或未武装（`disarmed`）Goal、新出现的 Goal、或用户修改过的 Goal 都不会被普通续写替代。

插件只通过可确认结果的服务压缩上下文，不把普通模型消息当作 `/compact` 命令执行。活动 Goal 的救援要求 `autoAbort: true`。Goal 服务不可用时保留普通会话路径；压缩服务缺失、失败、超时、排队输入竞争或卸载都会停止本次救援。由本插件暂停的 Goal 此时保持暂停，可检查日志后手动恢复；轮次预算耗尽也会保留宿主的错误结果。

## 配置

仓库中的 [cordis.patch.yml](cordis.patch.yml) 给出默认配置。安装后，在目标 profile 的 `cordis.patch.yml` 中按插件 ID 覆盖需要调整的字段，保留已有的其他插件配置；修改后重启对应 DSH 应用。

下面是常用配置示例，未列出的字段沿用默认值：

```yaml
- id: dsh-degeneration-watchdog
  config:
    enabled: true
    autoAbort: true
    autoCompact: true
    resumeGoal: true
    continueText: "继续"
    maxRescues: 3
    cooldownMs: 60000
    idleTimeoutMs: 15000
    compactTimeoutMs: 90000
    settleDelayMs: 450
```

### 动作与日志

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 检测总开关 |
| `autoAbort` | `true` | 命中后取消当前回合 |
| `autoCompact` | `true` | 命中后尝试压缩上下文 |
| `resumeGoal` | `true` | 成功救援后恢复本插件暂停且未被修改的 Goal；false 时保持暂停 |
| `continueText` | `继续` | 普通会话成功救援后的续写文本，须为非空白字符串 |
| `maxRescues` | `3` | 每会话救援预算，范围 0–100；0 表示不限 |
| `cooldownMs` | `60000` | 预算重置间隔，范围 1,000–3,600,000ms |
| `idleTimeoutMs` | `15000` | 等待空闲的超时，范围 100–300,000ms |
| `compactTimeoutMs` | `90000` | 每次压缩调用的超时，范围 100–600,000ms |
| `settleDelayMs` | `450` | 续写前延迟，范围 0–5,000ms |
| `verbose` | `false` | 命中时额外记录 attempt 与缓冲长度 |
| `selftestReasoning` | `false` | 首个流结束后注入合成退化样本，会执行真实救援 |

预算按**距上次救援开始的时间**重置：超过 `cooldownMs` 后，下一次救援从零重新计数。这不是滚动窗口限流。

将 `autoAbort` 和 `autoCompact` 同时设为 `false` 可关闭自动动作；`enabled: false` 则关闭检测。布尔配置使用 YAML 的 `true` / `false`，不要写成带引号的字符串。`selftestReasoning` 仅用于验证救援链，日常保持关闭。

### 检测参数

| 正文参数 | 思维链参数 | 默认值：正文 / 思维链 | 用途 |
| --- | --- | --- | --- |
| `windowChars` | `reasoningWindowChars` | 8192 / 16384 | n-gram 统计尾部窗口 |
| `minTextLength` | `reasoningMinTextLength` | 400 / 240 | 开始检测的累计长度 |
| `repeatThreshold` | `reasoningRepeatThreshold` | 3 / 5 | 行周期最少重复次数 |
| `maxCycle` | `reasoningMaxCycle` | 4 / 8 | 行周期上限 |
| `minLineLength` | `reasoningMinLineLength` | 8 / 2 | 行周期最低行长 |
| `dedupRatio` | `reasoningDedupRatio` | 0.12 / 0.12 | n-gram 比率低于此值时命中 |

`ngramSize` 两通道共用，默认 `8`。正文短行路径使用 `shortLineMinLength`（默认 `2`）和 `shortLineRepeatThreshold`（默认 `8`）。完整默认值与归一化范围见 [lib/detector.js](lib/detector.js)。

## 日志与排查

设置了 `DSH_HOME` 时，日志写入：

```text
$DSH_HOME/plugins/dsh-degeneration-watchdog/watchdog.log
```

父目录会自动创建。没有 `DSH_HOME` 时，使用 `TEMP`、`TMP` 或当前目录中的 `dsh-degeneration-watchdog.log`。文件写入失败会向控制台报告一次，后续仍输出控制台日志。

成功路径可通过这些日志关键字追踪：

```text
rescue start
cancel issued
compacted (command) 或 compacted (direct)
continue message sent
rescue done
```

Goal 路径还会出现 `goal paused`、`goal resumed`、`goal recovery disabled` 或 `goal recovery skipped: goal changed`。提前停止时查看 `rescue stopped` 后的原因。日志记录检测通道、判据、比率及救援步骤，不记录触发检测的回复样本；宿主返回的命令结果和错误文本仍可能进入日志。文件暂未轮转，应自行管理保留周期。

## 常见问题

| 现象 | 检查方式 |
| --- | --- |
| 安装后找不到插件页面 | 它是后台插件。查看控制台或日志中的 `plugin loaded`，确认版本与启用状态 |
| 已取消，但没有自动继续 | 有 Goal 时查看原生恢复记录；普通会话检查排队输入、等待超时、压缩服务缺失、命令错误或新的会话活动 |
| Goal 仍处于暂停状态 | 检查 `resumeGoal`、排队输入、用户改过的 revision、压缩失败、卸载或 Goal 轮次预算；插件只恢复自己暂停且状态未变的目标 |
| 看起来在重复，但没有触发 | 检查累计长度、重复门槛、是否跨 attempt；救援进行中或旧压缩未结束时会跳过新检测，预算耗尽时会跳过新救援 |
| 正常内容被打断 | 确认命中的是行循环还是 n-gram；按通道提高重复门槛，或降低 n-gram 阈值。排查期间可关闭自动动作 |
| 压缩超时后重载插件，仍未再次压缩 | 服务可能忽略了取消。对同一 agent，旧任务真正结束前会保留互斥，避免重叠操作 |
| 更新后仍显示旧版本 | 重启对应 DSH 应用，再检查 `plugin loaded` 的版本记录 |

## 兼容性与限制

- 自动压缩依赖宿主的 `commands` 或 `compaction` 服务；插件本身不提供压缩模型或压缩引擎。
- DSH 接口仍在演进，代码优先使用 `agentPresets.serviceFor`，保留可选 registry、agent context 和旧版根服务表解析。原生 Goal 集成测试针对 `0.2.0-rc.2`；其他宿主版本需要核验相应服务接口。
- 缓冲按 agent 和 attempt 分隔，跨 attempt 的慢速退化不合并检测。
- 无换行循环主要依赖 n-gram 信号，触发时机受窗口和阈值影响。
- 热重载互斥适用于同一宿主 JavaScript realm、同一 agent 对象。忽略取消且永不结束的服务会持续阻止该 agent 的新压缩。
- 本插件检测文本重复，不判断任务的语义进度，也不保证每次退化都能恢复。

## 开发与测试

完整测试使用 Node.js 22+，克隆仓库后安装锁定的开发依赖：

```sh
git clone https://github.com/null0xfff/dsh-degeneration-watchdog.git
cd dsh-degeneration-watchdog
npm ci --ignore-scripts
npm test
```

`npm run test:unit` 无需额外测试依赖，覆盖检测器、配置边界、短行、超时与取消、迟到结果、卸载与热重载、会话隔离、预算和日志。另有真实模块加载和日志写入的冒烟验证。

`npm run test:integration` 使用真实 Session、Goal 和 Goal 轮次驱动服务，配合受控 Agent 与压缩替身，验证事件发布中的延迟写入、暂停后的 revision、原生轮次续跑、排队输入保留、用户编辑和轮次预算。测试使用临时目录，不读取用户会话、不调用模型；它不等同于完整真实模型会话验收。开发依赖不随插件发布包打包。

GitHub Actions 配置 Linux / Windows 单测（Node.js 20 / 22）与集成测试（Node.js 22 / 24）矩阵，运行结果见 [Actions](https://github.com/null0xfff/dsh-degeneration-watchdog/actions/workflows/test.yml)。

| 文件 | 作用 |
| --- | --- |
| [lib/detector.js](lib/detector.js) | 检测判据、默认值与配置归一化 |
| [lib/index.js](lib/index.js) | 流订阅、救援、日志与生命周期 |
| [cordis.patch.yml](cordis.patch.yml) | DSH bundle 默认配置 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变化与升级说明 |

反馈问题时，可在 [Issues](https://github.com/null0xfff/dsh-degeneration-watchdog/issues) 附上插件版本、宿主版本、相关配置和去除私人信息后的日志片段。

## 许可证

MIT。
