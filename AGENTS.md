# Agent 协作指南

## 项目目标

本仓库是 DeepSeek Harness 的 Cordis 插件。核心意图是限制一次连续探索的深度和时长，让 Agent 更频繁地交回阶段总结，使用户能补充细节、检查结论和中途调整方向。

工作节奏为：有限探索 → 阶段总结 → 用户补充或纠偏 → 下一轮继续。修改功能和文案时应服务于这一目标，并准确区分工具守卫的硬拒绝与依赖模型遵循的总结提示。

## 先读与入口

- `README.md`：项目目标、使用入口、当前目录结构。
- `dsh-throttle/README.md`：当前配置、计数、权限、继承和实际限制。
- `docs/development.md`：开发与验证方法。
- `PLAN-throttle-mode.md`、`IMPLEMENTATION-throttle-mode.md`：历史设计及修订背景。与当前实现冲突时，先核对代码与测试。

插件为 Node.js >=22 的原生 ESM。无需构建；基础离线检查无需安装依赖。根目录 package.json 只组织开发命令，插件 manifest 在 `dsh-throttle/package.json`。

## 模块边界

| 位置 | 职责 |
|---|---|
| `dsh-throttle/index.js` | Cordis Host 适配、事件与服务注册、命令、权限写入和请求级 effort |
| `dsh-throttle/schemas.js` | 可选 schemastery / Zod 加载、配置与 wire schema |
| `dsh-throttle/lib/constants.js` | 稳定标识、档位与投影版本 |
| `dsh-throttle/lib/config.js` | 纯配置校验与上限解析 |
| `dsh-throttle/lib/projection.js` | 纯事件折叠、持久化状态与 JSON 视图 |
| `dsh-throttle/lib/usage.js` | 轮次计数、墙钟判断与守卫拒绝理由 |
| `dsh-throttle/lib/prompts.js` | 档位契约、运行时上下文与总结格式 |
| `dsh-throttle/lib/permissions.js` | 纯权限恢复决策 |
| `dsh-throttle/state.js` | 兼容导出入口，供已有工具与测试使用 |
| `dsh-throttle/client.js` | Harness 模块加载器中的浏览器 UI 与界面字典 |
| `tools/` | 安装、迁移、检查、预览与离线诊断 |

`lib/` 保持无 Host 服务、无外部依赖、无 I/O；时钟作为参数传入。`client.js` 通过 `window.__ModuleLoader__` 加载，不可直接改成普通 ESM 或任意引入 npm 包。Host schema 与浏览器静态模块解析属于不同的运行环境。

## 必须保留的契约

- 包名 `dsh-throttle`、命令 `/throttle`、配置行 id `throttle`、档位 id `default/deep/free`、投影 key `throttleMode` 是现有契约。不要顺手改名。
- 档位从已有的 `command/run`、`command/done` 和 `permission/preset` 事件折叠；失败命令不能提交新档位。新增持久化事件前必须核实 Harness 的读写支持。
- 改投影状态形状时检查 `PROJECTION_VERSION`、重放和检查点校验，保持旧日志可恢复。
- `default.toolCalls` 是历史别名；`default.steps` 优先。schema 不能提前填充 `default.steps` 默认值，否则会屏蔽别名。
- 有限档按模型回复步数计数，不按并行工具数扣减；工具 guard 只读计数。轮次边界需要在提示装配前更新，避免把轮间闲置算进下一轮。
- 当前步数和时间阈值都使用 `>`。不要把阶段总结描述成硬中断、精确回复次数、token 上限或隐藏思考长度控制。
- 不通过写全局模型选择控制 effort；只在模型声明支持配置等级时覆盖当前请求的 `reasoningEffort`。Open 保留请求原值。
- 维护会话权限恢复和子会话继承语义；改动时检查父子会话各自计数与 Harness 固定 scope 的边界。
- `throttle:policy` 不加入逐步计数；动态状态和超限总结格式放在 `throttle:state`。
- 有效 volatile 更新影响后续检查，不重置当前轮。更新失败保留上次有效配置。

## 工程与文案约定

保持两空格缩进、单引号、无分号和周围代码的命名风格。新注释与开发文档用中文；模型提示和 Host 回执保持现有英文协议。浏览器文案同时维护 `en` 和 `zh`，两者 key 集合一致；插件卡片元数据位于 `locale/`。

职责拆分后同步 manifest 的 `files`。真实 schema 探针共用 `tools/load-throttle-schema.mjs`，新增运行文件时同步复制范围。不要为了静态文件拆分破坏 Harness 的浏览器装载约定。

保留用户已有的未提交修改与暂存状态。`reference/`、`backup/`、`node_modules/` 是忽略的本地材料，不作为交付源码。诊断会话日志时只读取与任务有关的内容，避免把本地会话或 profile 信息写入版本库。

## 验证与交付

```sh
npm test
npm run check
npm run preview
```

改动核心逻辑后运行相关行为测试；完成改动运行 `npm run check`。更改 Host schema 后还应使用真实依赖运行两个 schema 探针，步骤见开发说明；没有依赖时明确报告跳过。客户端离线渲染使用替身，不能声称已完成 Harness 真机验收。

安装、迁移、回滚的 `--apply` 会写本机 Harness profile；整理或测试源码时不要顺带执行。用户要求安装时先核对 dry run 的具体内容。安装与迁移的模型配置处理范围不同，不要为了复用合并其语义。

交付说明写清改了什么、为何改变、通过的检查和未执行的验证。当前操作入口集中维护在使用手册与开发说明，设计记录保留历史语境，避免在多处复制整套说明。
