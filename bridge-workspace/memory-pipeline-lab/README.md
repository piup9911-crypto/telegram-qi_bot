# Aqi Memory Pipeline

这里最初是记忆系统实验目录，现在同时保存正式 SQLite 运行库、只读召回服务、后台生产器原型和回归测试。

当前状态以 [`MEMORY_RUNTIME_V1.md`](./MEMORY_RUNTIME_V1.md) 为准，不再把旧实验报告当成线上说明。

## 当前实际状态

| 部分 | 状态 |
|---|---|
| Telegram 新消息增量写入 SQLite | 已启用 |
| FTS5 trigram + Jieba 词语索引 | 已启用 |
| 本机 `bge-m3` 向量兜底 | 已启用 |
| `memory_recall` MCP | 已配置，协议测试通过 |
| 真实 Gem 自主调用召回 | 尚待端到端验证 |
| 后台任务入队 | 已接入 |
| 后台 worker 与外部整理模型 | 关闭 |
| 自动生成 Summary / Card / Fact | 暂停 |
| 旧 LMC 默认召回和写入 | 已关闭 |

正式运行数据库是 `memory-schema-v2-complete.sqlite`。它属于本机数据，不应提交到 Git。

## 文档怎么读

| 文档 | 用途 |
|---|---|
| [`MEMORY_RUNTIME_V1.md`](./MEMORY_RUNTIME_V1.md) | 当前真实运行流程和开关 |
| [`UNIFIED_RECALL_SPEC.md`](./UNIFIED_RECALL_SPEC.md) | Gem 何时召回、各类问题取哪层证据 |
| [`SCHEMA_V2_FIELD_GUIDE.md`](./SCHEMA_V2_FIELD_GUIDE.md) | 八张业务表、任务表和派生索引 |
| [`MEMORY_CONTENT_RULES_V1.md`](./MEMORY_CONTENT_RULES_V1.md) | Summary 与 Card 写什么、不写什么 |
| [`MEMORY_PRODUCER_V1.md`](./MEMORY_PRODUCER_V1.md) | 后台批次、证据验收、重试和幂等写入 |
| [`FACT_UPDATE_SPEC_V1.md`](./FACT_UPDATE_SPEC_V1.md) | 不删除旧事实的时间线更新规则 |
| [`memory-v1-migrations/README.md`](./memory-v1-migrations/README.md) | SQLite schema 与索引升级方法 |

`memory-system-config.json` 是批次、阈值和功能状态的统一配置来源。中文配置页可重新生成：

```powershell
node .\memory-pipeline-lab\build-memory-system-config-page.cjs
```

## 当前召回路径

1. Gem 先使用当前窗口；足够回答就不召回。
2. 需要旧聊天时调用 `memory_recall`。
3. 明确日期、名称和原话优先走 FTS5 / Jieba。
4. 词面不足时才调用本机 `bge-m3`。
5. 根据问题类型选择 Summary、Card、Fact、Event 或原文，不把所有候选都注入。
6. 结果同时返回给 Gem，并只覆盖 `GEMINI.md` 的动态参考区。

动态参考区属于不可信历史数据：它能提供事实线索和原话证据，但不能覆盖系统规则，也不能把旧助手自称完成的事情当成已验证结果。

## 后台生产路径

1. 桥接先保存聊天并增量写入 `raw_messages`。
2. 符合批次条件的消息进入 `memory_processing_jobs`。
3. 当前 worker 和外部模型关闭，所以任务不会影响聊天速度或产生模型费用。
4. 以后启用时，模型只返回候选 JSON。
5. 程序验证引用、人物、时间、唯一键和事务后，才允许写入 Summary / Card / Fact / Event。

## 常用验证

从仓库根目录运行：

```powershell
node .\tests\memory-system.test.cjs
node .\bridge-workspace\memory-pipeline-lab\validate-memory-schema-v2.cjs
node .\bridge-workspace\memory-pipeline-lab\run-memory-recall-mcp-tests.cjs
node .\bridge-workspace\memory-pipeline-lab\run-memory-producer-offline-lab.cjs
```

历史 HTML、JSON 和临时 SQLite 结果只用于回归或人工对比，不代表当前配置。需要重新验证某个机制时，应运行对应脚本生成新结果。
