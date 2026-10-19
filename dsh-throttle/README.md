# dsh-throttle 使用手册

DeepSeek Harness 的三档思考限流插件。通过约束每轮连续探索的步数和时长，在接近上限时提示阶段交接，超限后拒绝后续工具调用、要求模型总结交回，方便用户多次补充细节、检查中间结论和调整方向。

协作节奏是：**有限探索 → 阶段总结 → 用户补充或纠偏 → 下一轮继续**。项目动机和源码导航见[仓库 README](../README.md)。

## 档位与命令

| 档位 | 内部 id | 默认步数 / 分钟 | 默认 effort | 权限意图 |
|---|---|---|---|---|
| 收紧 Tight | `default` | 4 / 2 | `low` | 固定为 `read-only` |
| 放宽 Wide | `deep` | 5 / 5 | `high` | 恢复会话预设 |
| 放开 Open | `free` | 无上限 | 不覆盖 | 使用会话预设 |

| 命令 | 效果 |
|---|---|
| `/throttle` | 收紧 ⇄ 放宽；从放开返回收紧 |
| `/throttle tight`、`on`、`default` | 进入收紧 |
| `/throttle wide`、`deep` | 进入放宽 |
| `/throttle open`、`off`、`free`、`unlimited` | 进入放开 |

表中的别名均作为 `/throttle` 的参数使用，例如 `/throttle off`。不接受附件或未知参数，命令失败不会提交新档位。成功切换后，对话会保留回执：

```text
⚡ Wide · reasoning high · ≤5 steps · ≤5 min · preset restored (workspace-write)
```

普通会话从收紧档开始；成功命令的档位由会话日志恢复。放开档不覆盖请求中的 `reasoningEffort`，但插件仍保留档位说明与常驻协作规则。

## 界面

输入条中、模型选择器之前的徽章显示当前档位。点击后可查看该档的上限、思考等级、权限说明和等价命令，并切换档位。切换调用相同的 Host 命令，UI 等待投影视图确认结果；失败会显示原因。

**Plugins → dsh-throttle** 提供插件介绍和配置表单。收紧、放宽各有四个字段，可以暂存编辑、一次保存或恢复配置块的默认值；单个字段的“撤销”只丢弃尚未保存的编辑。没有 `configForms` 或 Host 没有提供设置命名空间时，配置页不会注册；仍可通过 profile YAML 配置。

## 如何计数与收尾

一轮指 Harness 的一次 turn；一步指该轮内模型的一次回复。同一步并行调用多个工具只算一步。收紧档默认允许第 1–4 步使用工具，第 5 步的工具调用被拒绝；放宽档默认允许第 1–5 步，第 6 步开始拒绝。

时间使用本轮墙钟，包含本轮内的模型生成、工具执行和等待，不包含两轮之间的闲置。`turn/start`、`turn/end` 在提示装配前更新轮次状态，`agent/pre-step` 更新步号并提供缺少事件时的兜底。工具守卫只读取计数，不按调用数量扣减。

当前判定为 `step > steps` 或 `elapsedMinutes > minutes`。守卫在工具执行前检查；已经开始的生成或工具执行不会因超时被取消。模型可以继续生成不调用工具的收尾回复，插件也没有通过调度器保证“恰好只剩一次回复”。

因此它提供的是**超限工具拒绝与总结提示**。它没有独立的 token 上限、回复字数上限、隐藏思考长度限制或定时中断；同一步的并行宽度也没有限制。阶段总结能否按要求完成，仍依赖模型遵循提示。

## 阶段总结

有限档的运行时上下文在观察到步数或墙钟用量达到上限的 75% 时，加入软阶段检查点：结果已足够就完成；高影响未知项阻塞方向时交回结论和关键问题；否则仅做最关键的剩余验证，避免展开新分支或追加探索委派。内置配置下，步数检查点为收紧档第 3 步、放宽档第 4 步；时间检查点分别为 1.5 分钟、3.75 分钟。以提示装配时已观察到的计数为准，轮内步号由后续 `agent/pre-step` 更新，因此模型看到的步数提示可能滞后一步；没有独立定时通知。

软检查点仅为模型提示，工具在原阈值内仍可调用；超过原有阈值（`>`）后守卫才拒绝。Open 和轮间空闲不加入检查点，新轮次重新计算；有效配置更新会影响后续检查点判断。阶段总结与等待回复仍依赖模型遵循提示。

软检查点和超限状态都提供阶段交接模板；超限拒绝消息还会要求模型停止调工具、停止重试。模型侧使用英文标题：

| 标题 | 应交回的内容 |
|---|---|
| `What I found` | 已确认的事实、当前结论和完成程度 |
| `What needs your confirmation (high impact)` | 影响后续方向的未决问题及原因；没有则写 `None` |
| `What I went with by default (low impact)` | 实际采用的默认假设及原因；没有则写 `None` |
| `How you can verify` | 一条相关验证方式，区分已执行和建议执行；无法验证时如实说明 |
| `Suggested next stage` | 一个有边界的下一步及所需确认；任务完成则写 `Complete` |

模型被提示在阶段交接后等待用户回复，继承档的子会话等待委派会话回复。收到总结后，用户可以确认结论、补充条件、改变优先级或停止当前方向。继续对话会开启新一轮计数，无需自动切到放开档。插件不会自动在后台生成摘要、自动续跑，也不会把摘要作为新的持久化事件写入日志。

## 配置

| 字段 | 默认值 | 规则 |
|---|---|---|
| `default.steps` | `4` | 至少 1，小于 `deep.steps` |
| `default.minutes` | `2` | 至少 1 分钟 |
| `default.effort` | `low` | 非空；模型声明支持时才覆盖请求 |
| `default.permission` | `read-only` | 收紧档每步校正到该预设 |
| `deep.steps` | `5` | 至少 5，且大于 `default.steps` |
| `deep.minutes` | `5` | 至少 5 分钟 |
| `deep.effort` | `high` | 非空；模型声明支持时才覆盖请求 |
| `deep.permission` | `restore` | 会话预设不可恢复时，可指定备选预设名 |

`free` 不接受配置块。旧字段 `default.toolCalls` 仍兼容为 `default.steps`；同时存在时 `steps` 优先。虽然旧名是 toolCalls，实际仍按步数计数。

表单保存会写入 profile 的 `cordis.patch.yml`，Loader 通过 volatile 配置引用原地更新。**有效的新配置用于后续检查，包括正在执行的这一轮；已用时间和步数不会重置。** 修改权限在下次校正时生效，修改 effort 在后续模型请求中生效。徽章随投影下一次发布更新，可能暂时显示旧数值；切换命令会触发发布。

也可以在 profile 的 `cordis.patch.yml` 中配置已有的 `throttle` 行：

```yaml
- id: throttle
  name: 'dsh-throttle'
  config:
    default: { steps: 4, minutes: 2, effort: low, permission: read-only }
    deep: { steps: 5, minutes: 5, effort: high, permission: restore }
```

手工编辑后重启 Harness。此处是 profile 行配置示例，bundle 自身使用 `insert` patch，见同目录的 [cordis.patch.yml](cordis.patch.yml)。

`resolveConfig` 拒绝非法配置。进入 `apply()` 后，初始校验失败会回退内置值，有效运行期间的更新失败则保留上次有效值，并记录原因。Host schema 在调用 `apply()` 前也可能拒绝不合规值；这种加载边界不能由 `apply()` 的兜底处理。当前拒配提示没有区分“内置默认”和“上次有效值”，发生更新失败时应结合日志核对实际生效值。

## reasoning effort 与权限

插件仅在模型声明支持配置等级时覆盖 `reasoningEffort`，不改 provider、model 或全局默认模型。查不到能力或配置等级不支持时，请求保留原值；`low` 也不是插件自动搜索出的最低等级。网关是否真的减少隐藏思考，由模型与供应商实现决定。

收紧档每步重新校正权限，手动切成可写可能在下一步被恢复为只读。需要写入时可切到放宽或放开。

拥有独立档位的会话在非收紧档的恢复顺序是：非收紧期间记录的用户预设 → 会话原始预设 → `deep.permission` 指定的可选预设 → `workspace-write` → `danger-full-access`。常规候选会跳过收紧档预设；不要把 `deep.permission` 显式设成同一个只读预设。继承档的子会话使用下节所述的保守恢复规则。权限服务缺失或预设不可选时，插件会报告信息或警告，不能保证权限切换成功。

放开档仍会参与权限恢复校正，因此它不等同于卸载插件；已有实现会跳过作为收紧预设的只读选择。

## 子会话与持久化

档位投影 `throttleMode` 从已持久化的 `command/run`、`command/done`、`permission/preset` 折叠，只有成功的 `/throttle` 才提交档位。没有新增 Harness 不认识的会话事件。重启与恢复可重放日志；fork 通过继承日志恢复状态。

没有独立 `/throttle` 记录的 `subagent` 子会话实时跟随委派会话的档位，可以递归继承；子会话自己执行成功命令后结束继承。委派会话已不可用且内存里没有记录时，回退到子会话自己的投影。

每个会话有独立的计数，子会话不消耗父会话步数；父会话在本轮等待子会话时，墙钟继续运行。多个子会话会各自拥有一份上限，没有共享的任务总额度。继承放宽或放开时，权限逻辑旨在释放插件此前施加的只读限制，实际 scope 仍由 Harness 控制。

继承档的权限恢复仅依据本次插件运行期间实际写入的限制记录：当前预设仍是插件写入的值，且写入前的预设仍可按名称选择时，才恢复到该原值。子会话本来就是只读时保持只读，不使用 `deep.permission` 或可写预设兜底。原值为 `custom`、不可读、已不可选，或插件重载后失去写入来源记录时，保留当前权限，由用户通过 Harness 核对处理。

目前浏览器视图只包含该会话自己的投影，可能与子会话继承后实际执行的档位不同；执行和模型提示使用继承后的档位。修改配置后，徽章数值也可能等待后续状态变化才刷新。

## 模型提示的两条通道

- `throttle:policy`：系统提示段，包含档位契约、权限说明和常驻规则；不含逐步计数。配置或权限事实变化仍可能改变文本。
- `throttle:state`：放在 `sandbox:policy` 附近的运行时快照，说明档位、权限来源、进度、软阶段检查点和交接格式。快照随 Harness 的上下文装配更新，不是独立计时线程。

运行 `npm run preview` 可查看模型侧原文。提示文本位于 `lib/prompts.js`，工具拒绝消息位于 `lib/usage.js`。

## 安装、迁移与卸载

以下命令均从仓库根目录执行：

```sh
node tools/install-dsh-throttle.mjs
node tools/install-dsh-throttle.mjs --apply
```

安装脚本面向 `DSH_HOME` 或 `~/.dsh` 下的 `profiles/desktop`。它写入 `link:` 依赖、选择 bundle、创建目录链接，并处理部署模型的 effort 声明和默认 effort 配置；写入前备份到 `backup/<timestamp>/`。默认仅预览，应用后重启 Harness。

旧版 `dsh-power` 使用迁移脚本；它迁移包选择和链接，保留已有模型配置：

```sh
node tools/migrate-dsh-power-profile.mjs
node tools/migrate-dsh-power-profile.mjs --apply
```

旧会话的 `/power` 日志不由新的 `/throttle` 投影解释，恢复时可能回到收紧档。

卸载前先对需要继续使用的会话执行 `/throttle open`，确认权限已恢复；收紧档写进日志的只读预设不会随着插件移除自动撤销。

```sh
node tools/install-dsh-throttle.mjs --rollback --apply
```

如果卸载后会话仍只读，可通过权限选择器或 Harness 的 `/permission workspace-write` 恢复。

## 开发验证

仓库根目录执行 `npm test`、`npm run check`。真实 schema 检查、模块职责和界面验收见[开发说明](../docs/development.md)。原始设计与修订历史见[PLAN](../PLAN-throttle-mode.md)、[IMPLEMENTATION](../IMPLEMENTATION-throttle-mode.md)。
