# 记忆系统概览

最后核对：2026-07-16

> [打开记忆系统完整方案：结构思维导图、数据表、召回流程、当前劣势和后续验证安排](./bridge-workspace/memory-pipeline-lab/README.md)

## 当前结论

正式记忆系统以 SQLite 为事实存储和检索入口。旧 LMC 只作为回滚数据与机制参考，不再参与默认写入、召回或共享 Markdown 同步。

## 写入流程

```text
Telegram 原始聊天
  -> bridge-state 本地聊天状态
  -> 延迟约 500ms 增量写入 SQLite raw_messages
  -> 自动更新 FTS5 索引
  -> 符合条件时进入 memory_processing_jobs
```

当前后台模型提供方关闭，因此任务队列不会自动生成新的 Summary、Card 或事实时间线，也不会额外消耗模型额度。

## 召回流程

```text
用户或 Gem 需要过去信息
  -> memory_recall 路由意图
  -> 明确词语/日期/原话：FTS5 + Jieba
  -> 语义改写：向量候选
  -> 需要证据：返回原始聊天片段
  -> 仅把结果作为本轮动态参考
```

正式文件：

- `src/memory/sqlite-memory-runtime.cjs`
- `bridge-workspace/memory-pipeline-lab/memory-recall-service.cjs`
- `bridge-workspace/memory-pipeline-lab/memory-retriever-unified.cjs`
- `bridge-workspace/memory-pipeline-lab/memory-schema-v2-complete.sqlite`

## 数据层

八张记忆业务表包括：

- `conversations`
- `raw_messages`
- `event_summaries`
- `memory_cards`
- `memory_sources`
- `fact_timelines`
- `fact_events`
- `event_occurrences`

另有一张运行辅助表：

- `memory_processing_jobs`

原始聊天始终保留。低价值内容可以不生成 Card 或 Summary，但仍可通过全文检索找回。

## 旧 LMC 状态

默认关闭：

```env
BRIDGE_LEGACY_LMC_RECALL_ENABLED=false
BRIDGE_LMC_WRITE_ENABLED=false
BRIDGE_LEGACY_SHARED_MEMORY_SYNC_ENABLED=false
```

暂时保留：

- `memory-docs/lmc/`
- `src/memory/lmc-*.cjs`
- `src/memory/memory-context.cjs`
- `src/memory/shared-memory-sync.cjs`
- 旧索引重建脚本

保留原因只有两个：出现遗漏时对照，以及短期回滚。它们不是新系统继续扩建的基础。

## 尚未完成

1. 等可以给 Bot 发消息时，验证一条真实新消息能自动进入 SQLite。
2. 配置可用后台模型后，继续测试 Summary、Card 和事实写入。
3. 通过观察期后，再备份并删除旧 LMC。
