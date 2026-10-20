# 开发说明

插件以原生 ESM 直接运行于 DeepSeek Harness，要求 Node.js >=22。仓库不需要编译，基础离线验证无需 `npm install`。根 package.json 提供开发命令，实际插件包位于 `dsh-throttle/`。

## 代码职责

核心分为 Host 适配、纯逻辑和浏览器模块：

- `index.js` 连接 Cordis 服务，注册命令、投影、提示、工具守卫和模型请求监听。
- `schemas.js` 动态加载 schemastery / Zod，并提供缺少依赖时的降级路径。
- `lib/` 按配置、投影、计数、提示与权限拆分；纯函数不依赖 Harness。
- `state.js` 聚合导出已有核心 API，保留工具和测试的导入路径。
- `client.js` 使用 Harness 的模块加载器、React 和 UI primitives；字典暂留在该单文件内，以保持无构建加载方式。

Host 配置使用 schemastery；会话投影视图的 wire schema 使用 Zod。没有 schemastery 时不提供设置 schema；没有 Zod 时使用内置 `parse` 校验。两个包都声明为 peer dependency，以便 Harness 的 profile 解析器提供依赖。

持久化档位与每轮用量分开：档位从日志折叠，轮次用量存在以 session 对象为 key 的 WeakMap 中。模型稳定说明与运行时计数分开：`throttle:policy` 不含逐步用量，`throttle:state` 跟随上下文装配更新。

具体修改约束见 [AGENTS.md](../AGENTS.md)。

## 基础离线验证

从仓库根目录运行：

```sh
npm test
npm run check
npm run preview
```

`npm test` 使用明确的测试文件路径，避免 `node --test <目录>` 在不同 Node 版本中的解析差异。插件目录也可运行 `npm test`。

`npm run check` 依次执行：

| 检查 | 验证内容 |
|---|---|
| 源码语法 | 插件与 tools 中的 `.js` / `.mjs` |
| 核心测试 | 配置、三档上限、75% 软检查点、轮次边界、事件重放、委派权限来源与保守恢复、继承、effort 和卸载监听 |
| manifest | Host 相对模块的交付清单、client 加载契约、icon、locale 和 peer 声明 |
| client 探针 | React / primitives 替身下的实际渲染、槽位、命令、表单、失败处理与双语 key 一致性 |
| ceiling 探针 | 父子会话的继承、独立计数与父会话等待时的墙钟 |

未传 schema 包路径时，ceiling 探针会明确跳过真实 schema 的别名检查。基础检查不包含真实依赖或 Harness 界面验收。

单独运行各项：

```sh
node --test dsh-throttle/test/throttle.test.mjs
node tools/verify-throttle-manifest.mjs
node tools/probe-throttle-client.mjs
node tools/probe-throttle-ceilings.mjs
node tools/preview-throttle-text.mjs
```

## 真实 schema 验证

需要 Harness 实际使用的 `@deepseek-ai/schemastery` 与 `zod`。拿到完整包目录后，直接把路径作为参数传入：

```sh
node tools/probe-throttle-config.mjs <schemasteryDir> <zodDir>
node tools/probe-throttle-ceilings.mjs <schemasteryDir> <zodDir>
```

两个探针共用 `load-throttle-schema.mjs`：将插件运行源码复制到独立临时目录，改写副本 `schemas.js` 中的两个动态依赖入口，再运行真实 schema；完成后清理临时副本。它们不会修改仓库源码或 profile。

只有 ASAR 时，可用仓库工具提取依赖。以下为 PowerShell 示例；输出目录使用一次性新目录，并与运行的脚本保持分离：

```powershell
$app = '<Harness 安装目录>\resources\app.asar'
$probe = Join-Path $env:TEMP ('dsh-throttle-deps-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $probe | Out-Null
node tools/asar-read.mjs extract $app 'dsh/node_modules/@deepseek-ai/schemastery' "$probe/node_modules/@deepseek-ai/schemastery"
node tools/asar-read.mjs extract $app 'dsh/node_modules/@deepseek-ai/cosmokit' "$probe/node_modules/@deepseek-ai/cosmokit"
node tools/asar-read.mjs extract $app 'dsh/node_modules/@standard-schema/spec' "$probe/node_modules/@standard-schema/spec"
node tools/asar-read.mjs extract $app 'dsh/node_modules/zod' "$probe/node_modules/zod"
node tools/probe-throttle-config.mjs "$probe/node_modules/@deepseek-ai/schemastery" "$probe/node_modules/zod"
node tools/probe-throttle-ceilings.mjs "$probe/node_modules/@deepseek-ai/schemastery" "$probe/node_modules/zod"
```

ASAR 内路径可能随 Harness 版本变化。不要从提取目录启动仓库脚本，运行目录保持为仓库根目录。

## Harness 手工验收

仅在用户授权安装或更新 profile 后进行。安装脚本默认预览，应用后需重启 Harness。

1. 打开普通会话，确认徽章位于模型选择器之前，显示收紧档；检查首次执行时只读预设生效。
2. 通过徽章切到放宽，再通过命令切到放开、收紧；确认回执、投影视图与实际权限相符。
   同时核对模型选择器：支持 `low/high` 的模型切档后立即显示对应等级，无需先发送消息；放开恢复原会话选择。先手动选 `low` 再切放宽，确认选择器显示 `high`，新请求的 `request/header` 也为 `high`。无推理能力的模型保留原生显示；插件卸载后原生选择器恢复。
3. 在可控的小任务中耗尽步数，确认超限工具被拒绝，拒绝原因指明插件上限，模型交回阶段总结。
4. 补充一条具体约束继续任务，确认新轮重新计数，轮间等待未算入新轮。
5. 在配置页保存有效值，确认后续检查采用新值、计数未重置；检查低于下限和档位顺序错误的输入被阻止。
6. 启动子会话，核对继承档位、独立计数和委派权限；注意子会话徽章仍显示自己的投影记录。
7. 在中英文 UI 下查看插件介绍、表单与失败提示。
8. 在有限档接近 75% 步数或时间用量时，检查 `throttle:state` 的软提示；确认阈值内工具仍可调用，模型能交回关键问题、验证情况和下一阶段建议。检查点随上下文装配刷新，步数提示可能滞后一步。
9. 分别使用原始只读和可写的委派子会话切换父档位；核对原始只读保持不变、插件施加的限制可恢复到可选原值。原值为 `custom`、不可读、不可选或插件重载后缺少来源记录时，应保留当前权限。

记录实际执行的步骤与 Harness 版本。离线替身通过只能证明相应契约，不能证明 UI 已在真实 Harness 中运行。

## 工具与本地材料

| 工具 | 用途 |
|---|---|
| `install-dsh-throttle.mjs` | desktop profile 安装与回滚，默认预览，`--apply` 写入 |
| `migrate-dsh-power-profile.mjs` | 旧名称迁移，保留原有模型配置 |
| `asar-read.mjs`、`asar-probe.mjs` | 查看 ASAR 与提取指定文件 |
| `read-session.mjs`、`scan-sessions.mjs` | 本地会话转录与汇总 |
| `session-ceiling-report.mjs` | 从注入文本回看历史上限状态 |
| `session-log-decode.mjs` | 会话 Zstd 解码的共享实现 |

`reference/` 与 `backup/` 是忽略的本地材料，不纳入检查与交付。安装工具可能修改模型 effort 声明；迁移工具只迁移包与链接，这一行为差异需要保留。

## 文档维护

根 README 说明动机与快速入口；插件 README 维护当前使用语义；本文维护开发验证；AGENTS.md 约束后续 Agent 修改。PLAN 和 IMPLEMENTATION 保留设计演进，历史条目不代表当前行为。

三档命令、配置字段和投影版本是现有兼容契约。软阶段检查点属于模型提示；工具超限拒绝由守卫执行。后续若实现生成中断、token 限制或自动摘要，应单独设计生命周期与验收，不能仅凭现有分钟数上限宣称已经支持。
