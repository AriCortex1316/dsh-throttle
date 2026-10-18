# dsh-throttle 实现记录（含与规格的偏离）

> 对应 `PLAN-throttle-mode.md` 的实现，代码在 `dsh-throttle/`。
> 本文记录：与规格不同的地方、为什么不同、以及各次修订改了什么——rev.3（三档 + 模型自解释）、
> rev.4（界面：徽章 + 配置页）、rev.6（收紧档改按「步」计数）、rev.7（别名生效 / 拒配可见 / 子会话继承档位）、
> rev.8（徽章移到输入条，模型选择器之前）。
> 使用者视角看 `dsh-throttle/README.md`。
> 命名（rev.5）：插件由 `dsh-power` 改名为 `dsh-throttle`，命令由 `/power` 改为 `/throttle`；档位 id 仍是 `default` / `deep` / `free`（配置块键名不变），显示名改为「收紧 / 放宽 / 放开」（英文 Tight / Wide / Open）。host 侧文案、模型可见文案与 README 一律英文。

---

## 1. 与 PLAN 的三处偏离（rev.2 起，仍然有效）

### 1.1 档位是 session projection，不是插件自有事件

PLAN 5.1 设想写一个 `throttle/mode` 会话事件。实现改成折叠 Harness **已经持久化**的两类事件：
`command/run` / `command/done`（`name: throttle`）。

原因：`KNOWN_SESSION_EVENT_TYPES` 之外的类型，在持久化读路径上要求事件带 `ignorable` 标记，而活的
`Session.append()` 无法设置它——真写一个 `throttle/mode`，**任何含该事件的会话都会拒绝重新打开**。
投影同样满足 PLAN 想要的持久性：重启/恢复靠日志重放，`subagent_fork` 继承父会话日志因而继承档位，
而且没有新增日志词汇。代价是档位语义必须完全由命令行的 `args` 与折前状态决定（见 2.3）。

### 1.2 思考等级走 `agent/request` 瀑布，不写 `model/selection`

PLAN 5.2 设想写会话级 `model/selection`。实现是在 agent 作用域的 `agent/request` 瀑布上、以
`prepend` 注册监听，只替换 `reasoningEffort` 一个字段。

原因：`agent/request` 是每会话的、不会碰到 profile 的全局默认模型（PLAN 明确禁止动全局默认）；
也不会覆盖用户在模型选择器里选的 provider/model。必须 `prepend` 是因为
`installModelSelection` 会在内层链路 resolve 之后再套一次自己的 effort，只有最外层能决定最终值。
下发前先用 `llm.resolveModelInfo()` 查该模型是否声明过这个等级，查不到就不下发——
避免配置写错导致整轮 `UNSUPPORTED_REASONING_EFFORT`。

### 1.3 额度用 `ctx.tools.guard()`，不用 `tools/pre-execute` 监听

PLAN 5.3 设想 `tools/pre-execute` 拒绝。实现改用 guard。

原因：guard 在可扩展瀑布之后执行且**单调**——后面的监听者无法把已经花掉的额度重新变成许可；
同时它仍然能返回面向模型的拒绝理由。计数单位是"一次工具执行尝试"，与 PLAN 的
「一次工具调用算 1 次」一致：被拒的尝试不计数，所以计数停在阈值上、后续每次都以同一理由被拒。

---

## 2. rev.3：三档 + 让模型知道自己在哪一档

### 2.1 为什么加第三档

rev.2 只有收紧档/放宽档，两个都**有上限**：放宽档虽然放宽，但 `deep.steps/minutes` 有硬下限 5，
而且配置层面也表达不出"无限"。结果是用户想"回到没装插件的状态放开跑"没有入口——
只能整个停用插件，而停用又留下 2.5 的只读遗留问题。

rev.3 增加 **放开档**（`/throttle off`）：无额度上限、不计数、不下发思考等级、权限交回会话自己
（只有在会话仍被收紧档的只读预设占着时才按回会话自己的预设），定位就是"等同没有安装本插件"。
它**没有配置块**，这是刻意的：无限不该是一个能写错的数字，回退到可用状态的出口也不该依赖配置。

### 2.2 命令语法（PLAN 3 的修订）

| 命令 | 目标档位 |
|---|---|
| `/throttle` | 收紧档 ⇄ 放宽档；从放开档打 → 回收紧档（插件重新接管） |
| `/throttle deep` | 放宽档 |
| `/throttle off` / `/throttle free` / `/throttle unlimited` | 放开档 |
| `/throttle on` / `/throttle default` | 收紧档 |

设计取舍：裸命令保持 rev.2 的「默认 ⇄ 深度」语义，放开档用显式词进入。这样**旧日志里裸
`/throttle` 的含义完全不变**，唯一被重新解释的是 `/throttle off`（rev.2 = 回收紧档，rev.3 = 放开档），
而新含义比旧含义更宽松，不会把历史会话变得更受限。若改成"裸命令三态循环"，两次裸 `/throttle`
的历史会被重放成放开档，且原来的"深度→默认"要按两次。

### 2.3 状态形状与版本升级

```js
{ mode: 'default' | 'deep' | 'free', running: null | { commandId, wanted }, original, chosenPreset }
```

- `running.wanted` 从布尔变成档位字符串；`active` 布尔变成 `mode` 字符串；`deepPreset` 更名
  `chosenPreset`（深层档位不再只有一个）。`stateVersion` 1 → 2。
- 版本不匹配的持久化检查点会被丢弃并**从日志重新折叠**。因为折叠只依赖已持久化的
  `command/run`、`command/done`、`permission/preset`，重放是无损的，老会话不会丢档位。
- 折叠规则：`command/run` 记录目标（裸命令按折前档位解析），`command/done` 只在 `kind: 'success'`
  时提交；语法不认的参数连 `running` 都不写，拒答的命令不会改档位。
- `permission/preset` 折叠：收紧档下日志里第一条是会话原本的预设（Harness 发布会话时写入），
  之后的一律是插件自己在按模式校正；非收紧档下，除插件自己的接管值（`config.default.permission`）
  以外的改动都记为 `chosenPreset`（用户的手动选择），下一次进非默认档时优先恢复它。

### 2.4 两条面向模型的通道，按"变不变"分工

rev.2 把档位说明、每步计数、交回格式**全塞进 system prompt 段**，于是每步计数一变就改写 prompt 头，
前缀缓存整段失效；同时模型对"为什么只读"仍然只能看到 DSH 的 `Current DSH file policy: read-only`
（来自 `dsh-sandbox-policy` 的 `sandbox:policy` runtime context），**没有任何东西把因果连起来**——
插件一旦卸载，遗留的只读更是无人解释。

rev.3 拆成两条：

| 通道 | 名字 | 位置 | 变率 | 内容 |
|---|---|---|---|---|
| system prompt 段 | `throttle:policy` | order 520（PLAN_POLICY 500 与 TEAM_POLICY 600 之间） | 只随档位变 | 档位契约 + 常驻规则 |
| 运行时上下文快照 | `throttle:state` | order `getContextOrder('SANDBOX_POLICY') + 2` = 112 | 每步可能变 | 档位、只读成因、本轮额度、用尽的交回格式 |

- 上下文快照由 agent loop 的 `RuntimeContextProjection.project()` **原地替换**（文本不变则完全不写），
  所以每步更新只花一行，而 system prompt 前缀保持逐字节稳定。
- 顺序紧挨 `sandbox:policy`，是为了让模型把 `Current DSH file policy: read-only` 与"这是插件收紧档
  写的权限预设"读在一起。
- 快照里明确区分三种权限来源：`plugin`（`本插件写入的 X`，本档的定义）、`session`（`会话自己的预设 X（本档按这个值，
  插件不再加限制）`）、`pending`（`本插件的目标预设是 Y，当前是 X`——刚进本档、用户刚手动改过、或权限服务不可用，
  下一步会再校正）。首次装配发生在第一个 `agent/pre-step` **之前**，所以"未生效"是正常瞬态而不是故障，
  文案按目标/现状如实描述。
- 守卫拒绝文本也点名 `dsh-throttle 插件的档位限制`，避免模型把额度拒绝误判成沙箱问题。

用 `node tools/preview-power-text.mjs` 可以直接看三档 × 正常/超额的完整文案。

### 2.5 分层语义（这一版要讲清楚的三层）

| 层 | 谁拥有 | 模型看到的样子 |
|---|---|---|
| DSH 沙箱文件策略 | `dsh-sandbox-policy`（会话级 `sandbox/mode`） | `Current DSH file policy: read-only / workspace-write / danger-full-access` |
| 权限预设 | `dsh-permission-presets`，把沙箱模式 + 审批策略打包成一个名字 | `permission/preset` 事件（log-only），通过沙箱策略行间接可见 |
| `/throttle` 档位 | 本插件，按档位写权限预设 | `throttle:policy` + `throttle:state` 两条文案 |

本插件**不直接**改沙箱模式，只改权限预设；模型看到的只读是第二层的落点。`throttle:state` 就是把这层
因果关系写进模型上下文的那一条。

### 2.6 非默认档的权限策略

非默认档（深度/无限）的权限 = `restoreTarget()`：优先用户手动选过的 `chosenPreset`，其次会话原本的
`original`，再次配置的 `deep.permission`，最后第一个可写的预设。**默认档自己的预设永远不是恢复目标**——
否则"放宽档"会和收紧档一样受限，也就无法从只读坑里出来。

因此，非默认档下手动改成只读会被每步的幂等校正按回可写。这是刻意的（见 README 已知取舍），
要只读就用收紧档。

### 2.7 rev.3.1 修复：轮界必须在 prompt 装配**之前**折叠

**症状**：用户在同一个 profile 的另一个会话（workspace 是 `default-workspace`）里，一条**0 次工具调用**
的新一轮开头就收到「**本轮额度已用尽**（时间上限 2 分钟已到（已用 88.0 分钟））」，模型据此放弃检索、
直接按交回格式作答（该轮 reasoning 原文：`I've run out of quota. Must stop and answer in the fixed format.`）。

**定位**（`node tools/session-budget-report.mjs <session.v4.jsonl.zstd>`）：

| 注入时刻 (UTC) | 注入文本 | 反推的 `startedAt` |
|---|---|---|
| 07:12:01.438 | 已用 1/4 次调用 · 0.0/2 分钟 | 07:11:59.192 = turn 1 ✓ |
| 08:39:59.367 | 时间上限 2 分钟已到（已用 88.0 分钟） | **07:11:59.192 = turn 1**，却渲染在 turn 2 ⚠ |
| 08:40:57.582 | 已用 0/4 次调用 · 1.0/2 分钟 | 08:39:59.350 = turn 2，渲染在 turn 3 ⚠ |
| 08:41:15.708 | 已用 2/4 次调用 · 0.3/2 分钟 | 08:40:57.567 = turn 3 ✓ |
| 08:43:12.796 | 时间上限 2 分钟已到（已用 2.3 分钟） | 08:40:57.567 = turn 3，渲染在 turn 4 ⚠ |
| 08:44:15.227 | 已用 0/4 次调用 · 1.0/2 分钟 | 08:43:12.780 = turn 4，渲染在 turn 5 ⚠ |

`toFixed(1)` 让这个反推是**精确**的：某轮的 `turn/start` 若能复现同一个取整分钟数，就被唯一指认。

**根因**：`AgentLoop.preStep()` 先 `systemPrompt.assemble()` + `runtimeContext.project()`，**之后**才跑
`agent/pre-step` 瀑布。插件的额度记录只在 `agent/pre-step` 里推进，于是每轮**第一步**的快照看到的仍是
上一轮的记录；而 `elapsedMinutes()` 是墙钟，turn 1（07:11:59）到 turn 2（08:39:59）之间 88 分钟的挂机
就被记到新一轮头上。轮内无害（同一条记录），所以症状只在"每轮第一步"，且只在两轮之间有空档时才看得见。

**修复**：本轮界折叠到 `session/event` 上（`observeSessionEvent()`）——

- `Session.append()` 在返回前同步广播 `session/event`，而 `turn/start` 在 `preStep()` **之前**就已提交
  （`turn()` 先 append `turn/start`，再调 `preStep`），所以折叠它必然早于本次装配。
- `turn/start` 以 `event.time` 开新一轮（`step = 1`，即即将进入的那一步，放宽档的步数行因此显示"第 1/5 步"）；
  该步自己的 `observeStep()` 随后把时钟重锚到 pre-step（同一条记录，毫秒级）。
- `turn/end` 把记录置为 inert（`active = false`），于是两轮之间渲染的任何快照都不会声称一个已关闭轮次的额度。
- `agent/pre-step` 保留为轮内计数与兜底；`ctx.tools.guard()` 的语义**不变**——它读的一直是当步之后的记录，
  所以这次修复的是"文案骗模型"，不是"工具被误拒"（那两轮工具其实没被拒，是模型自己收手了）。
- 附带效果：一条会话的第一轮第一步现在也会显示额度行（此前 `active` 还是 false，什么都不显示）。

为什么不在渲染侧兜底（读 `turnBoundary` 投影的 `lastTurn` 与 `usage.turn` 比对）：那要跨包依赖
`dsh-agent-loop` 私有的投影 key，且把判定塞进可能被多次调用的 `text` 回调里；折叠一个已经在日志里的事件更稳。

**回归用例**：`usage: a turn/start opens the budget before the prompt is assembled`（纯逻辑，含 88 分钟挂机
场景与 `turn/end` 之后的空档）与 `a turn start opens the budget before the runtime context is rendered`
（走插件真实路径）。

---

## 3. 刻意没做的

- **不 hook 沙箱的写拒绝文本**：写拒绝由 `dsh-fs-sandbox` / `dsh-sandbox-policy` 产生，本插件不替换它，
  只在模型上下文里解释成因。替换别的插件的拒绝文本会越权，也会让归属变模糊。
- **无限档不设任何"保险丝"**：不限额、不计时、不下发思考等级。要收窄就用收紧档，或按档位配置。

---

## 4. rev.4：界面这一期（原 PLAN 第 11 节）

PLAN 第 11 节把常驻徽章 / Settings 卡片列为"要写客户端插件并重建 Web 产物"的第二阶段。rev.4 做了，
但没有重建 Web 产物：DSH 的浏览器插件机制本来就允许一个**包自带客户端半边**（`dsh.client` + `exports["./client"]`），
由安装侧的 `dsh-client-modules` 在启动时扫进 boot 图，经 `/plugins/<包名>/client.js` 提供。
所以这一期只新增 `dsh-throttle/client.js`，零构建步骤。

### 4.1 两块界面与它们各自依赖的扩展点

| 界面 | 槽位 | 读什么 | 写什么 |
|---|---|---|---|
| 档位徽章 + 切换面板 | `conversation.input.right`（list，session 作用域；渲染在输入条右侧、模型选择器**之前**） | `useProjection('throttleMode')`——本插件投影发布的 `wire.view` | 执行 `/throttle on｜deep｜off`（`ctx.remote.commands.execute`） |
| Plugins 卡片上的配置表单 | `plugins.bundle.config`，key `dsh-throttle` | `ctx.configForms.get('power')`——Host 设置表单的快照（hooks 注入成 `usePowerConfig`） | 同一个 scope 的 `mutate(ops, revision)`，落盘到 profile 的 `cordis.patch.yml` |

两个决定值得记下来：

1. **切换走命令，不走新协议。** 档位的唯一真源仍是会话日志（§1.1），所以客户端只执行人类会打的那条命令；
   `command/run` → 投影折叠 → `session/projection` 帧 → 徽章更新。客户端没有"乐观档位"，
   被拒绝的切换不会留下一个没发生过的档位。
2. **配置页用 `configForms` + `whileServed`，不用 `plugins.row.config`。** 三个配置槽位里，
   `plugins.row.config` 是唯一由页面注入 `form`（快照 + `mutate`）的那个，但安装包里**没有任何插件用它**；
   四个官方配置页用的都是 `configForms.get(ns)` + `whileServed`。这里跟官方走，同时把页面挂在
   `plugins.bundle.config`（卡片页直接可见，不用先点进行再点 Configure）。
   `ctx.inject(['configForms'], ...)` 让这个页面成为**可选**的：没有 `ui-settings` 时徽章照常工作、配置页整块不注册。
3. **徽章的额度由 Host 算。** `wire.view` 里带三个档位的 `kind/max/minutes/effort`，
   客户端不重新推导 `limitsFor()` 的语义（步 vs 次调用）。代价是视图只在投影状态变化时发布，
   刚改完配置又没有任何会话事件时，面板里可能还显示旧数字；切一次档或开一轮就刷新。
   **执行侧不受影响**：守卫与提示词每步重读配置（§4.3），所以只是显示滞后。

### 4.2 投影的 wire 用 Zod，配置的 Config 用 Schemastery

这是踩过的坑，记下来：**投影线协议的 schema 语言是 Zod，不是 schemastery**。
`dsh-session-projection` 用 `wire.viewSchema.parse(...)` 校验每个发布值，而第一方 domain
（`dsh-plan-mode`、`dsh-permission-presets`）声明这些 schema 时用的是 `import { z } from 'zod'`；
`z.object({...})` 有 `.parse`，schemastery 的 schema **没有** `.parse`（它只有可调用的 `Schema(x)` 与
`~standard.validate`），写成 schemastery 会在第一次发布时抛错。

反过来，**设置表单的 `Config` 必须是 schemastery**：`dsh-settings` 用 `entry.fiber.runtime.Config` +
`toJSON()` + `meta.volatile` 推导表单。两者并存，各自都对。

### 4.3 配置为什么是 volatile 的

`Config` 里两个档位块都声明 `.volatile()`，这不是装饰：Loader 对一次"只有 volatile 字段变化"的配置更新
走 `_commitVolatile()`——重新解析配置、把值写进**已经在跑的那份引用**、再用 `loader/volatile-update`
通知所属 fiber，**不重挂插件**。所以：

- 插件在 `apply()` 里拿到的 `config.default` / `config.deep` 是**引用**，不是快照；
- 每次读都要 `.get()`（`plainValue()`），插件在 `loader/volatile-update` 上重算 `settings`，
  守卫、提示词段、运行时快照、思考等级全部跟着新数字走；
- 投影的**折叠**仍用注册时的那份配置（`createPowerProjection(settings, ...)`）——档位的语义不该取决于
  某个事件被重放的时刻；只有 `wire.view` 读实时配置。

坏值不会被接受：`dsh-settings` 先用 Config schema 校验整份候选（`.min(1)` / `.min(5)`），
插件再用 `resolveConfig()` 复核一次，两步都过不了就沿用旧值并记一条 warn。

### 4.4 链式插件要拿到安装包，必须声明 peerDependencies

`@deepseek-ai/schemastery` 与 `zod` 都不是静态 import，而是 `await import(...)` 包在 try/catch 里：

- 单测在插件自己目录下跑，那里没有任何 `node_modules`，静态 import 会让整个测试文件加载失败；
- 更重要的：`dsh-app-boot` 的 profile-resolution 路由只对**本包 package.json 里声明过的
  peerDependencies** 才会把安装包路由给链式（`link:`）插件（`routeLinked()` 读祖先目录的 peer 列表）。
  解析不到时不报错，只是设置表单不出现（`wire.viewSchema` 回落到内置校验器）。

`package.json` 因此新增 `peerDependencies: { "@deepseek-ai/schemastery": "*", "zod": "*" }`，
以及 `dsh.client`（`platform: web` + `inject`）与 `exports["./client"]`。`@moguiyu/dsh-tavily`
是这个 profile 里同套约定的第三方先例。

### 4.5 客户端半边的样式与组件

只用 `--dsw-alias-*` / `--dsw-radius-*` 主题 token + Harness 自己的静态基线模块
`@deepseek-ai/dsh-client-ui-primitives`（`Button` / `Modal` / `Tooltip` / `Tag` / `SegmentedControl` /
`SettingsValueField`）。它是 web shell 冻结模块表里的基线条目（和 React 一起），所以 `require()` 直接可用，
不需要 `dsh.client.external`。字段控件直接用官方的 `SettingsValueField`：标签、简述、`i` 按钮展开的
完整说明、`已覆盖` 标记、单字段撤销都是它自带的语义，插件只负责 staging 与一次 `mutate`。
代价是与这个 DSH 版本的 primitives 耦合（官方设置页同样如此），已记在 README 的已知取舍里。

### 4.6 简介与标题下那一行的分工

简介（是什么 / 达到上限会怎样 / 为什么这样更好 / 适合的五种场合 / 它**不是**要削弱 DSH / 一行用法）
放在**插件自己那张卡片的页面顶部**，也就是 `plugins.bundle.config` 的 `view: 'page'` 视图。

标题下那一行（同时也是 Plugins **列表卡片**上那一行）由 `locale/*.json` 的 `meta.description` 提供，
而插件管理器把它画在自己那段 JSX 里、**在配置槽位之前**——`plugins.detail.section` 在页脚、
`plugins.detail.actions` 在页头按钮位，没有任何槽位能插到它前面。所以想改顺序，只能改这一行的**内容**：
现在它是简介的**提炼版**（三档 → 限制单轮步数与时长 → 到点交回结论 / 待确认项 / 下一步建议 → 分阶段推进），
和下面整块简介说的是同一件事、不是第二套说法。加上这一步，原本「上面一大段摘要、下面再讲一遍」的重复就没有了。

页面顺序因此是：`meta.description` 提炼行 → 简介（收尾是「用法：…」一行，走三级文字色）→
一条 `--dsw-alias-border-l2` 细线 → 「改完怎么生效」说明 → 两个额度块。

语言跟 Harness 自己的语言走：`intro.*` 词条写进 `client.js` 的 `en` / `zh` 两份字典，
`meta.description` 同时写进 `locale/en.json` 与 `locale/zh.json`
（`intro.use.*` 五条按 `INTRO_USES` 数组的顺序渲染，顺序在代码里），而不是把中英两段并排铺在页面上 ——
同页其它文案（`cfg.*` / `tier.*`）都是这个规矩，中英并排只会在一半用户那里变成噪音。
渲染探针因此额外在 `en` 字典下把这一页再渲染一遍：键集对齐只能证明键存在，不能证明英文那半是通顺的简介。

---

## 5. 验证

- 单元测试：`node dsh-throttle/test/throttle.test.mjs`（41 个用例；`node --test dsh-throttle/test/` 在 DSH 受限
  shell 里会因为 spawn 子进程被沙箱拒绝而 EPERM，直接跑文件即可）。rev.4 新增 5 个：客户端视图的形状与
  JSON 可序列化（无限档是 `null` 而不是 `Infinity`）、改配置后视图跟着变、`wire` 只在该给的时候给、
  插件注册的视图能被 schema 校验且拒绝畸形值、volatile 更新（好值生效 / 坏值沿用旧值）。
- schema 契约探针：`node tools/probe-power-config.mjs <schemastery 目录> <zod 目录>`。
  把两个依赖从安装包里取出来、把插件的动态 import 改指过去（不改别的），然后跑真实代码：
  Config 的 volatile 声明、缺省/局部值/下限拒绝、`dsh-settings` 的 `volatileForm` 只暴露两个区块、
  一次保存写出的文档能重新解析回同样的值、`wire.viewSchema` 确实是 Zod 且拒绝畸形视图。
  这一步是必要的：单测环境里没有这两个包，覆盖不到这条路径。
- 浏览器半边渲染探针：`node tools/probe-throttle-client.mjs`（52 项）。它给 `window.__ModuleLoader__` 装上壳、
  用一个极简 React 替身（`createElement` / `useState` / `Fragment`，按组件保存 hook 状态以便重渲染）
  真的把 `client.js` 加载并渲染：两个槽位注册与注入面（配置页在 `configForms` 之后、`whileServed` 之内注册；
  缺 `ui-settings` 时整块不注册）、徽章在投影首帧前不渲染、面板三段式切换真的发出 `/throttle off`、
  「配置额度…」跳到 Plugins 页、缺命令通道时给可读提示；配置页 8 个控件与当前值、`已覆盖 / 内置默认` 标记、
  暂存后保存发出的**那一条操作**（含 revision）、低于下限时拦住保存、未 serve / 读取中两种回退文案；
  以及简介块的落位（在配置表单与「改完怎么生效」之前）、五条场合、目标句与收尾的「用法」一行，
  并在 `en` 字典下再渲染一遍这一页。
  这是"重启前能拿到的最接近真机"的一步。
- manifest 契约检查：`node tools/verify-power-manifest.mjs`（`dsh.client` / `exports["./client"]` /
  工厂 id 等于包名 / 浏览器半边只 require 静态模块表里的东西 / 图标与双语 locale 元数据 / 两个 peer）。
- 文案抽查：`node tools/preview-power-text.mjs`。
- 历史会话核查：`node tools/scan-sessions.mjs`（统计每个会话里的 `[power]` 文案、文件策略行、额度拒绝次数），
  `node tools/read-session.mjs <session-id>` 渲染成可读转录——rev.3 的定位正是靠这些日志确认的
  （收紧档只读 + 额度拒绝 + 模型看不到成因）。
- 额度数字溯源：`node tools/session-budget-report.mjs <session.v4.jsonl.zstd>` 逐条列出注入过的额度行，
  用 `toFixed(1)` 的取整反推它属于哪一轮，并对"渲染在 X 轮、记录属于 Y 轮"标 `⚠ STALE`。rev.3.1 就是它定出来的。
- 多帧 zstd 解码只有一份：`node tools/session-log-decode.mjs <session.v4.jsonl.zstd> [out.jsonl]` 里的
  `scanZstdFrames`/`decodeSessionArtifact` 被上面三个工具共同 import（`zstdDecompressSync` 直接吃多帧文件
  会报 `Unknown frame descriptor`，末尾那个还在写的 torn frame 要按 `ZSTD_e_flush` 解）。

---

## 6. rev.6：收紧档改为按「步」计数（取消工具调用上限）

**起因**：收紧档数的是「工具调用」——`ctx.tools.guard()` 每执行一次就 `usage.toolCalls += 1`。
于是一条消息里并行发 4 个调用就一次性吃掉整轮额度（实测：两条消息、共 4 次调用即被拒），
而用户要的语义是「只限制步数，不要限制工具调用次数」。并行铺开本来就不该受罚，
受约束的应该是「这一轮往前走了多远」。

**改法**：

- `limitsFor` 两个受限档都返回 `kind: 'steps'`；`default.toolCalls` 改名 `default.steps`（默认 4 步，
  分钟上限仍是 2）。
- 计数只由 `observeStep` 采用 agent loop 自己的 `step` 号推进；`guardDecision` 变成**只读**，
  不再自增任何计数器。同一步内的并行调用因此要么全过、要么全被拒——上限约束的是步，不是一步的宽度。
- 到顶后的收场沿用原机制（超限那一步的工具调用被拒 + 注入固定格式），不接新的中断点。
- 新增一条硬校验：`deep.steps` 必须 > `default.steps`。两档第一次同单位，
  「放宽档不比收紧档宽」属于配置错误而不是偏好。
- 显示口径：快照那行是 `step N/M`，N 是 loop 已进入的步号。prompt 装配发生在 `agent/pre-step`
  之前（见 2.7 节），所以它比正在执行的这一步**晚一步**，这是既有的、有意的行为。

**事故与防护**（rev.6.1）：改名当时 profile 的 `cordis.patch.yml` 里还写着 `toolCalls: 4`，
`rejectUnknown` 抛错 → **整行插件被卸载**，档位、徽章、guard 一起消失。三处防护补上：

1. `toolCalls` 保留为 legacy alias：`DEFAULT_KEYS` 仍接受它，取值是 `defaults.steps ?? defaults.toolCalls`，
   并保留在 schemastery schema 里，免得 schema 层先一步拒掉。旧补丁不会再打挂插件。
2. `apply()` 不再因为初始配置被拒而抛：`initialSettings()` 捕获后记录完整警告并回落到内置默认
   （fail-open）。配置错误从此只损失数字，不损失插件；`resolveConfig` 本身仍然 fail loud。
3. profile 的 `cordis.patch.yml` 已就地改成 `steps: 4`（`deep.steps: 10`，10 > 4 满足新校验）。

**回归用例**：`budget: the default tier allows four steps of tools, then exactly one closing step`
（内含「一步里 12 次并行调用仍全部放行」）、`config: shipped values are accepted and the deep floor is enforced`
（legacy alias 与 `deep.steps > default.steps` 两条）、
`the guard refuses calls once the default step ceiling is spent, through the real plugin path`。

**跑测试**：沙箱下 `node --test <file>` 会因为 `spawn EPERM` 失败（child_process 拿不到命名管道），
直接用 `node dsh-throttle/test/throttle.test.mjs` 在进程内跑，44 条。

---

## 7. rev.7：别名真正生效、拒配不再静默、子会话继承档位

### 7.1 `toolCalls` 别名此前是死代码（修）

rev.6.1 的保护只做了一半：`resolveConfig` 里的 `defaults.steps ?? defaults.toolCalls` **永远走不到第二支**。
原因是 Cordis 在调 `apply()` **之前**先用插件的 `Config` 解析整行配置
（安装包内 `@deepseek-ai/cordis` 的 `resolveConfig(runtime, config)` → `runtime.Config['~standard'].validate(config)`，
返回 `result.value`），而 `Config.default.steps` 当时写着 `.default(4)`——于是任何省略 `steps` 的补丁都会被
schema 先填成 4，`toolCalls: 6` 静默变成 4 步，比抛错更难发现。单元测试当时钉住的 6 只对"绕过 schema 调用
`resolveConfig`"成立，真实 Harness 不会出现那条路径——修掉 schema 默认值之后，这条断言才重新代表真实路径。

**改法**：`default.steps` 去掉 `.default(4)`，让"填默认值"只发生在 `resolveConfig` 这一处；其余字段默认值不动。
表单显示不受影响——配置页的每个控件自带 `fallback`（`client.js` 的 `BLOCKS`），值缺失时显示的仍是 4。
验证放在 `tools/probe-throttle-config.mjs`（用真 schema 跑真代码）与 `tools/probe-throttle-budgets.mjs` A 段。

### 7.2 被拒配置不再静默回落（修）

`initialSettings()` 的 fail-open 保留（坏补丁只损失数字），但拒绝从此有出口：`configIssue` 记下原因，
渲染进 `throttle:state` 快照（"in force 的是内置默认值 + 原因"），并追加到每条 `/throttle` 回执。
`loader/volatile-update` 失败也走同一条通道（此时保留的是上一次的好值）。这样模型会主动告诉用户
数字与配置不一致，而不是把内置值当成用户配置上报。这条最常撞上的就是 7.3 的跨字段规则。

### 7.3 子会话继承档位（能力变更）

**起因**：`subagent` 子会话的日志里没有 `/throttle` 记录，于是折成收紧档。实测 9 个子会话全部 Tight，
其中 5 个（2026-10-17，父会话处于放宽档）在旧口径下 2–3 步就撞上「4 次工具调用」上限；子会话还被
reconcile 写成 read-only，父会话在放宽档也照样只读。而插件安装前同样形态的子会话能跑 54/58/81/105 步。

**改法**：

- 投影状态加 `commanded: boolean`（`stateVersion` 2 → 3）：只有本会话日志里成功跑过 `/throttle` 才算
  "自己的档位"。旧检查点因版本号不同被丢弃并重新折日志，无损。
- `index.js` 的 `tierOf(session)` 解析"生效中的档位"：自己有 `commanded` 就用自己；否则沿
  `session.header.parentSession` 逐级向上（`ctx.get('agents').get(id).session` 拿活会话，取不到则用
  `knownTiers` 记住的上一次结果，再取不到才回落到自己折出的 default）。**实时**解析，不是创建时快照，
  所以父会话切档会立刻带着子会话一起变；带环检测，最多一条链。
- 预算仍然**按会话**存（`WeakMap` 键是 session 对象），子会话拿自己的 4/10 步与 2/15 分钟，不占父会话的步数；
  但父会话在 `subagent` 调用里等待时**墙钟照走**，所以一次长委派会吃掉父会话的分钟额度——这一条写进 README。
- 权限：委派时 Harness 已固定子会话的 scope（子 agent 的运行时上下文原话是 "your permission scope was fixed
  when you were started"）。因此继承来的放宽/放开档**只解除插件自己写过的那次只读 pin**
  （`wantedPresetFor`：current 是 `read-only` → 恢复可写；否则不表态），不写 preset、不动 approval。
  收紧档仍是例外：Tight 的定义就是只读（与 rev.7 之前一致）。
- 文案：快照与 prompt 段多一行说明"档位继承自委派方"；`permissionPhrase` 新增 `delegated` 来源
  （"the scope this delegated sub-session was started with"）。回执在继承态的会话里会多一句提示。
- **已知不一致**：界面徽章读的是本会话投影状态（`wire.view` 只拿到 state，拿不到 session，见
  `dsh-session-projection` 的 `wire.view(state)`），所以继承中的子会话徽章显示的是它"自己的记录"。
  执行面与模型可见文本用的是继承结果；在子会话面板点一下档位就等于显式 `/throttle`，会结束继承。

**回归用例**：`a delegated sub-session runs on the tier its delegator is in`、
`a sub-session's own /throttle ends the inheritance`、`a refused row config is named in the snapshot and in the receipt`、
`projection: the persisted state schema rejects untrustworthy shapes`（新增 `commanded` 一项）；
探针 B 段另外覆盖"Tight 父 → Tight 子（只读）"、"Wide 父 → Wide 子（自己的 10 步、只解除自己的 pin）"、
"11 步子会话没有动父会话的计数器"与"墙钟共担"。

---

## 8. rev.8：徽章从会话头部移到输入条（模型选择器之前）

**起因**：档位是"随手的模式开关"，而输入条才是操作发生的地方；会话头部右上角离视线太远。

**改法**：注册槽位 `conversation.session.header.utilities` → `conversation.input.right`。
两者都由 `dsh-client-ui-conversation` 声明（本插件已 inject 该模块），所以 `package.json`
的 `dsh.client.inject` 一个字都不用改。输入条那一行的实际顺序是：

```
左侧： [+ 命令] [① 权限预设] [② 计划模式] [conversation.input.left]
右侧： [conversation.input.right] [③ 模型选择器] [activity] [发送/停止]
```

`conversation.input.right` 正落在模型选择器**之前**，与"档位/权限"这组模式开关的语义一致。
两处随之调整：Tooltip 从 `side: 'bottom'` 改成 `'top'`（输入条在窗口底部，向下的气泡会被裁掉，
模型选择器自己的也是 `top`）；`intro.usage` / `cfg.howto.round` / README / package.json 描述里的
"会话头部"改成"模型选择器旁边"。

**已知取舍**：输入条的右组在 `activity` 展开时整体隐藏（模型选择器同样隐藏），而会话头部始终可见；
如果以后希望两处都在，再加一条注册即可（同一个 `TierChip` 组件）。另外徽章显示的是本会话投影状态
（§7.3 的已知不一致），换位置不改变这一点。

**回归用例**：探针里 `the chip registers into the composer bar, immediately before the model selector`
与 `and it opens upwards, out of the bottom bar`（新增），以及中英简介 usage 那一行的文案检查。

---

## 9. 回滚

- 代码层：`git`/备份恢复 `dsh-throttle/` 三个文件即可；`stateVersion` 已经是 3，旧版本插件读不了新会话的
  检查点，但会退化成"重新折叠日志"，不会损坏日志。
- 界面层：删掉 `client.js`、`package.json` 里的 `dsh.client` / `exports["./client"]` / peer 声明，
  再重启 Harness——浏览器插件图在启动时组合，运行中不会自己消失。
- 安装层：PLAN 第 10 节（从 `dsh.profile.bundles` 去掉 → 删目录 → 删配置 → 重启）。
- **停用前先 `/throttle off`**：收紧档写进会话日志的 `read-only` 不会随插件卸载恢复，
  那个会话会一直只读且无人解释（详见 README 的停用提示）。
