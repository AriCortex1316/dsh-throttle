# /throttle 三档规格（收紧档 / 放宽档 / 放开档）

> 状态：**已实现**，代码在 `dsh-throttle/`；用法见 [`dsh-throttle/README.md`](dsh-throttle/README.md)，与规格的偏离见 [`IMPLEMENTATION-throttle-mode.md`](IMPLEMENTATION-throttle-mode.md)。
> 版本：rev.3（rev.3 增加第三档「放开档」，并把档位与只读成因写进模型上下文）
> 命名（rev.5）：插件由 `dsh-power` 改名为 `dsh-throttle`，命令由 `/power` 改为 `/throttle`；档位 id 仍是 `default` / `deep` / `free`（配置块键名不变），显示名改为「收紧 / 放宽 / 放开」（英文 Tight / Wide / Open）。host 侧文案、模型可见文案与 README 一律英文。

---

## 1. 要解决的问题

1. 现在**每一轮都在思考**：`commandcode` 路由下的三个模型没声明 `reasoningEfforts`，DSH 认定它们「无推理能力」→ 不下发任何推理开关、模型选择器里也没有等级可选 → 网关按自己的默认一直思考。慢、费 token，而且答案容易越飘越远。
2. 日常问题不需要深度推理：闲聊、查最新消息这类，**1~2 次工具调用就该出结果**。
3. 深度任务需要放权，但要**有上限**，不能无限探索。
4. 缺一条「先给方向 / 细节不够就停下问」的流程约束，导致接到模糊需求就直接动手（例：只给一句「图片怎么出视频」就写出 ffmpeg 脚本，没问素材、时长、清晰度、用途）。

## 2. 目标行为

|  | **收紧档**（开机就是） | **放宽档**（`/throttle`） | **放开档**（`/throttle off`，rev.3） |
|---|---|---|---|
| 思考 | 最低档（`low`，可配） | 配置值（默认 `high`） | **不下发**（保持会话/选择器自己的值） |
| 一轮上限 | ≤4 次工具调用、≤2 分钟（可配） | **步数上限默认 5、最低 5，可调大**；**时间上限默认 5 分钟、最低 5，可调大** | **无上限**，也不计数 |
| 权限 | 自动切「仅可查看」：写文件、落盘脚本被沙箱拒绝 | 恢复该会话原本的权限预设（可写） | 恢复该会话原本的权限预设（可写），且不再干预 |
| 能力范围 | 联网搜索 + 只读（读文件/搜索/只读命令） | 全部工具，按原权限 | 全部工具，按原权限 |
| 撞上限 | 停手，交回「当前结论 + 待确认项 + 建议你验证的命令」 | 同上 | 没有上限可撞 |
| 定位 | 日常问答、省钱省时 | 深度任务，但有硬上限 | 等同没装插件，放开跑 |

撞上限时的交回格式（固定）：

```
## 当前结论
（已经确认的事实/结论，能写到什么程度写什么程度）

## 需要你确认（影响大的）
1. …（缺什么信息、为什么影响方案）
2. …

## 我先按默认走了（影响小的）
- …（默认值 + 一句理由，你不同意就改）

## 你可以这样验证
（给一条命令或一个操作步骤，让用户自己验，而不是继续无限搜索）
```

## 3. 命令

- `/throttle`：裸命令 **切换**（收紧档→放宽档；放宽档→收紧档；放开档→收紧档，插件重新接管）。
- `/throttle deep`：显式进放宽档。
- `/throttle off`（别名 `free` / `unlimited`）：进**放开档**——不限额、不下发思考等级、不干预权限预设，等同没装插件。
- `/throttle on`（别名 `default`）：显式回收紧档。
- 与 `/plan` 同风格：一个英文单词、裸命令生效、`off` 关闭。
- 状态写进会话事件，**重启/恢复会话后仍然有效**；每次切换在对话里留一行回执，例如：
  - `⚡ 放宽档：思考 high · ≤5 步 · ≥5 分钟 · 权限恢复（可写）`
  - `🍃 收紧档：思考 low（最低档） · ≤4 次调用 · ≤2 分钟 · 仅可查看`
  - `♾️ 放开档：不限额 · 不限制思考 · 权限恢复（workspace-write）`

## 4. 常驻规则（三档都生效，写进插件提示词段）

- **由浅入深**：先给 2~3 个可行方向/方案让用户选，不要一次性把所有可能性想完再倒给用户。
- **细节不够就停下问**：场景、需求细节、电脑环境、实现方向未落定前不进入落地。
- **除非用户已给全部细节**并明确要求按计划走，才直接执行。
- **有疑问给验证命令**，不要无限搜索。
- **闲聊不调工具**：一句「哈哈哈」就一句回。

## 5. 实现要点

### 5.1 状态
- 会话投影承载「收紧档 / 放宽档 / 放开档」，重启由日志重放恢复（实现折叠 Harness 已有的
  `command/run` + `command/done`，不新增事件类型；`stateVersion = 2`。见实现记录 1.1）。
- 两条模型文案，按"变不变"分工：
  - `throttle:policy`：system prompt 段，只随档位变（不破坏前缀缓存），放档位契约 + 常驻规则。
  - `throttle:state`：运行时上下文快照，排在 DSH 自带 `sandbox:policy` 之后（order `110 + 2`），放本轮进度、
    交回格式，以及**当前文件策略的成因**（这条只读是本插件收紧档写入的权限预设，不是 DSH 部署默认、
    也不是用户临时改的）——让模型不再把只读/额度拒绝归因到沙箱。

### 5.2 思考开关
- 走 agent 作用域的 `agent/request` 瀑布（`prepend`），只替换 `reasoningEffort`，与模型选择器互不覆盖
  （实现记录 1.2）：
  - 收紧档 → 最低档（默认 `low`；该网关不接受 `none`，留空则等于不下发）
  - 放宽档 → 配置值（默认 `high`）
  - 放开档 → **不下发**（保持会话/选择器自己的值）
- 不影响其他会话，**不动全局默认**（用户明确要求：思考默认开，由 `/throttle` 来关）。

### 5.3 轮内额度
- `agent/pre-step` 监听：payload 带 `{ agent, messages, turn, step, signal }`，按轮统计步数、工具调用次数、耗时。
- 到额度：注入「停止探索 → 按第 2 节格式交回」的指令（额度耗尽时 `throttle:state` 快照里直接带格式）。
- `ctx.tools.guard()` 拒绝后续工具调用（带理由的拒绝结果，且点名 `dsh-throttle 插件的档位限制`），
  **逼模型出结论**，而不是静默掐断。guard 单调，后面的监听者无法把花掉的额度变回许可。
- 收尾步设计：额度用尽后**允许一步不调工具的收尾**（deep 档在第 6 步触发），否则搜索/读取的结果模型看不到。
- 放开档：**不计数、不拒绝**，时间上限也不存在。

### 5.4 权限闸门
- 收紧档：`ctx.permissionPresets.set(session, 'read-only')`（沙箱在 OS 层拒绝写入，Windows 走 ACL 受限令牌执行器）。
- 放宽档 / 放开档：恢复该会话原本的预设（切进非默认档时记住原值）。**默认档自己的预设永远不是恢复目标**，
  否则无法从只读坑里出来；因此非默认档下手动改成只读会被每步的幂等校正按回可写。
- **停用插件前先 `/throttle off`**：收紧档写进会话日志的 `read-only` 不会随插件卸载恢复，那个会话会一直只读
  且没有东西向模型解释原因。已卡住的会话用权限选择器或 `/permission workspace-write` 换回来。
- 已知边界：read-only 不是「绝对无法写」的证明（共享 hard-link、未受限读取、AppContainer ACL 限制），审批策略仍保持 `ask`。

### 5.5 配置校验
- `deep.steps < 5` 或 `deep.minutes < 5` → 插件加载即报错，不静默放行。

## 6. 要动的文件（3 新 + 2 改）

1. **新**：`~/.dsh/profiles/desktop/dsh-throttle/`
   - `package.json`（声明 `dsh.bundle.patch`）
   - `cordis.patch.yml`（插入插件行 + 第 7 节配置）
   - `index.js`（命令、状态、额度、提示词段）
2. **改**：`~/.dsh/profiles/desktop/package.json`
   - `dependencies` 加 `"dsh-throttle": "file:./dsh-throttle"`
   - `dsh.profile.bundles` 追加 `"dsh-throttle"`
3. **改**：`~/.dsh/profiles/desktop/cordis.patch.yml`
   - 挂载该行（或在第 1 项的 patch 里完成）

安装走 DSH 插件安装路径（或 profile 内 pnpm 链接一次），会弹一次审批。**不写用户工作区、不碰用户项目文件。**

参考文档：打包内已有 `dsh-agent-preset/skills/cordis-plugin-development/`（host-plugin / practices / verification）可直接照抄写法。

## 7. 可配置项（改数字即可，不碰代码）

```yaml
power:
  default: { toolCalls: 4, minutes: 2, effort: low,  permission: read-only }
  deep:    { steps: 5,     minutes: 5, effort: high, permission: restore }  # steps/minutes 最低 5，可调大
```

> **rev.6 修订**：收紧档的计数单位已从「工具调用」改成「步」，
> 键名相应改为 `default.steps`（默认 4 步，分钟上限仍为 2 分钟），并要求 `deep.steps > default.steps`。
> 上面这块保留为当时原文，改动理由与防护见 `IMPLEMENTATION-throttle-mode.md` 第 6 节。

**放开档没有配置块**（rev.3 明确）：它是"无上限、不下发思考等级、不干预权限"，没有可调项；
"无限"也不该是一个能写错的数字。要收窄就留在收紧档，或直接停用插件。

## 8. 验收清单

1. 新会话问「DeepSeek 最近有什么新消息」→ 只搜 1~2 次就答，**无思考块**，不动任何文件。
2. 让它写文件 → 被沙箱拒绝，并提示打 `/throttle`。
3. `/throttle` → 重问同问题 → 有思考块、可写、上限放宽到 ≥5 步 / ≥5 分钟。
4. 再打 `/throttle` → 立刻回到只读 + 最低档思考。
5. 给一个要跑很多步的任务 → 到 5 步 / 5 分钟（或调大的值）收到第 2 节格式的交回，不再继续搜。
6. 发「哈哈哈」→ 不调工具、一句话回（收紧档也只花最低档思考）。
7. 配置写 `deep.steps: 3` → 插件加载报错（证明下限生效）。
8. 接一个模糊需求（例：「图片怎么出视频」）→ 先给 2~3 个方向 + 反问你素材/时长/清晰度/用途，**不直接写脚本**。
9. 打 `/throttle off` → 回执是 `♾️ 放开档…`；同一轮里连打十几次工具调用**不被拒**；写文件成功；
   请求里没有插件下发的思考等级。
10. 打 `/throttle on` → 立刻回到只读 + 最低档思考，且裸 `/throttle` 的切换语义不受影响。
11. 收紧档下问模型「你为什么只读 / 谁限制的」→ 模型能说出这是 dsh-throttle 收紧档写入的权限预设，
    并给出 `/throttle`（放宽档）与 `/throttle off`（放开档）两条出口——依据是 `throttle:state` 快照。
12. 收紧档下连打 5 次工具调用 → 第 5 次被拒，拒绝文本点名「dsh-throttle 插件的档位限制」，而不是沙箱。

## 9. 待你确认的默认假设

- 收紧档也给 2 分钟上限；计数按「一次工具调用算 1 次」。
- 收紧档思考是**最低档**（`low`）而不是"关"：该网关不接受 `reasoning_effort: none`。
- 放宽档思考等级默认 `high`；放宽档 / 放开档权限 = 恢复该会话原本的预设（你手动切过就恢复那个）。
- 裸 `/throttle` 保持「默认 ⇄ 深度」；放开档用 `/throttle off`（别名 `free` / `unlimited`）显式进入，`/throttle on` 回收紧档。
- **UI 显示分两期**：本期只有命令回执 + 模型侧两条文案（`throttle:policy` / `throttle:state`）；
  常驻徽章 / Settings 卡片需要客户端插件并重建 Web 产物，等明确要求再做。

## 10. 回滚

**先 `/throttle off`**，再把 profile 的 `dsh.profile.bundles` 去掉该项 → 删 `dsh-throttle/` 目录 → 配置里删掉第 7 节那段 → 重启即恢复原样。工作区与项目文件零污染。
（`node tools/install-dsh-throttle.mjs --rollback --apply` 会做完这些步骤里的 profile 部分。）

## 11. 第二阶段（rev.4 已实现）

- ~~Settings 里的插件卡片（改 n 步 / n 分钟 / 思考等级不用编辑 YAML）~~ → **已实现**，但不是 Settings 卡片：
  落在 **Plugins 页的行配置页**（`plugins.row.config`，key `dsh-throttle#power`），因为它就是 Harness 为
  "插件自己带配置"准备的位置；表单字段、说明、`恢复默认`/`撤销` 都在那里，保存写 profile 的
  `cordis.patch.yml` 并经 volatile 更新**立即生效、不重启**。
- ~~会话头部的常驻状态徽章（`/throttle` 开启时可见）~~ → **已实现**为会话头部右侧的档位徽章
  （`conversation.session.header.utilities`），显示当前档位与额度，点开是切换面板（三段式切换 +
  当前档位四项事实 + 等价命令 + 跳到配置页）。
- ~~需要写客户端插件并重建 Web 产物~~ → 客户端插件写了（`dsh-throttle/client.js`），但**不需要重建 Web 产物**：
  DSH 的浏览器插件机制由 `dsh-client-modules` 在启动时把 `dsh.client` 声明扫进 boot 图并按
  `/plugins/<包名>/client.js` 提供，包自带半边即可。零构建步骤。
- 设计与坑（Zod vs schemastery、为什么 volatile、peerDependencies 路由）见
  [`IMPLEMENTATION-throttle-mode.md`](IMPLEMENTATION-throttle-mode.md) 第 4 节。
