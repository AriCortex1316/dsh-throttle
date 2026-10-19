# dsh-throttle：思考限流与阶段总结

`dsh-throttle` 是 DeepSeek Harness（DSH）的三档限流插件，用每轮步数、持续时长和 reasoning effort 约束连续探索。接近上限时提示阶段交接，超限后拒绝后续工具调用并要求总结，把决定下一步的机会交回用户。

希望形成的协作节奏是：**有限探索 → 阶段总结 → 补充细节或调整方向 → 继续下一轮**。信息不足时先给出已有结论和关键疑问；方向发生偏移时，用户能在下一轮及时纠正；复杂任务则通过多次可检查的小阶段逐步推进。

## 设计想法

Agent 容易把一个问题不断展开：追加搜索、扩大修改范围、反复推演细枝末节，直到很久以后才交回结果。用户在过程中很难补充遗漏条件，也难以及时判断方向是否合适。

插件用档位控制一次连续探索的尺度，让总结更频繁地出现。阶段总结应说明已经确认的事实、影响后续决策的缺失信息、实际采用的默认假设、验证情况和一个有边界的下一步。没有问题或假设时如实说明；任务完成时直接交付结果。用户补充信息后，再开始一轮有边界的工作。

这里的“思考限流”由三部分构成：reasoning effort 调节模型请求的思考等级，步数和墙钟上限约束后续工具执行，提示文本引导模型收尾。**当前实现不会硬中断正在进行的模型生成或工具执行，也没有 token 数、隐藏思考长度或回复字数上限。总结格式依赖模型遵循提示。**

## 三个档位

下表为内置默认值，可在 Plugins 页调整两个有限档的配置。

| 档位 | reasoning effort | 每轮工具探索上限 | 权限意图 | 使用场景 |
|---|---|---|---|---|
| 🍃 收紧 Tight（默认） | `low`，模型声明支持时覆盖 | 4 步 / 2 分钟 | 固定为 `read-only` | 快速问答、初步调查、澄清需求 |
| ⚡ 放宽 Wide | `high`，模型声明支持时覆盖 | 5 步 / 5 分钟 | 恢复会话预设 | 分阶段实现、调查和验证 |
| ♾️ 放开 Open | 保留会话的选择 | 不设上限 | 使用会话预设 | 用户决定连续推进的任务 |

**一步是模型的一次回复，不是一次工具调用。** 同一步并行调用多个工具仍算一步。工具守卫在步数大于配置值或已用时间大于配置值时拒绝后续调用，并要求模型停止重试、给出阶段总结。模型仍可生成不调用工具的收尾回复。

有限档在观察到步数或时间用量达到 75% 时提供软阶段检查点，引导模型完成已有结果、交回关键问题，或仅做最重要的剩余验证。检查点随上下文装配刷新，步数提示可能滞后一步；阶段交接和等待回复依赖模型遵循提示。具体触发规则见[阶段总结](dsh-throttle/README.md#阶段总结)。

上限按会话、按轮计算；子会话有自己的计数。它不会限制同一步的并行宽度，也不是整个任务或所有子会话的总额度。完整的计数、权限恢复和继承语义见[使用手册](dsh-throttle/README.md)。

## 使用

点击输入条模型选择器旁的档位徽章查看和切换，也可以输入命令：

| 命令 | 效果 |
|---|---|
| `/throttle` | 收紧与放宽互切；从放开档返回收紧 |
| `/throttle wide` | 进入放宽档，别名 `deep` |
| `/throttle open` | 进入放开档，别名 `off`、`free`、`unlimited` |
| `/throttle tight` | 返回收紧档，别名 `on`、`default` |

切换通过 Host 命令写入会话日志，成功后由投影更新徽章，并留下一条回执。打开 **Plugins → dsh-throttle** 可以修改步数、分钟数、思考等级和权限配置。

一次阶段总结后，可以直接补充：“优先处理 Windows，先完成配置读取和测试，UI 留到下一轮。”新一轮重新计数；无需为了继续任务而切到放开档。

## 安装

要求 Node.js 22 或以上，以及具备相应 Cordis 服务的 DSH。仓库是原生 ESM，无构建步骤；离线基础检查无需安装依赖。

在仓库根目录执行：

```sh
node tools/install-dsh-throttle.mjs          # 预览变更
node tools/install-dsh-throttle.mjs --apply  # 备份、写入并校验
```

安装脚本面向 `DSH_HOME`（默认 `~/.dsh`）下的 `profiles/desktop`，会配置插件链接、bundle 选择，以及该部署的模型 reasoning effort 声明；安装后重启 Harness。它包含针对现有模型配置的处理，首次使用应先看预览。旧版 `dsh-power` 的迁移和卸载步骤见[使用手册](dsh-throttle/README.md#安装迁移与卸载)。

## 开发与验证

```sh
npm test       # 核心行为测试
npm run check  # 语法、测试、manifest、客户端渲染与独立计数检查
npm run preview # 预览三档的模型提示与总结格式
```

`npm run check` 的客户端部分使用 React 和 Host 服务替身，计数探针会明确跳过需要真实 schema 包的部分。真实 schema 校验命令、Harness 手工验收步骤见[开发说明](docs/development.md)。

## 仓库结构

```text
dsh-throttle/
  index.js              Cordis Host 集成：命令、事件、守卫、权限与模型请求
  schemas.js            可选 schema 依赖、Config 与 wire.viewSchema
  state.js              核心逻辑的兼容导出入口
  lib/
    constants.js        稳定标识、档位、投影版本
    config.js           配置校验与档位上限
    projection.js       会话事件折叠与浏览器视图
    usage.js            每轮计数、时间检查与工具拒绝
    prompts.js          档位提示、阶段总结格式与运行时上下文
    permissions.js      权限恢复目标
  client.js             Harness 原生浏览器模块：徽章与配置页
  locale/               插件元数据的中英文文案
  test/                 核心行为测试
tools/                  安装、验证、文案预览和日志诊断
docs/development.md     工程约定、验证入口与手工验收
AGENTS.md               供代码 Agent 使用的仓库协作指南
```

`reference/` 是本地 Harness 参考转储，`backup/` 是本地安装备份，两者均被 Git 忽略。

- [使用手册](dsh-throttle/README.md)：配置、计数边界、总结格式和已知限制。
- [AGENTS.md](AGENTS.md)：修改代码时应遵循的契约与验证要求。
- [原始方案](PLAN-throttle-mode.md)与[实现记录](IMPLEMENTATION-throttle-mode.md)：历史设计与取舍；当前行为以源码、测试和使用手册为准。

插件 manifest 声明许可证为 MIT。
