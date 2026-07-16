# 阿祈记忆系统：当前正式运行方式 V1

更新时间：2026-07-16

## 一句话说明

Telegram 对话仍然先正常保存；新的记忆系统随后把新增原文增量写入 SQLite。需要回忆时，由 Gem 按需调用只读的 `memory_recall` 工具查询 SQLite。旧 LMC 已退出正常运行链路，但文件暂时保留，方便回滚。

## 当前实际流程

1. 用户和 Gem 正常聊天。
2. 桥接先保存原始聊天 JSON，不等待记忆整理完成。
3. 约 500 毫秒后，后台把本轮新增消息写入 SQLite 的 `raw_messages`。
4. SQLite 自动更新 FTS5 全文索引。
5. 符合整理条件的消息进入 `memory_processing_jobs` 队列。
6. 当前后台模型提供方处于关闭状态，因此不会额外调用模型，也不会产生模型费用。
7. Gem 需要旧记忆时，调用 `memory_recall`：
   - 明确日期、词语、原话：优先走快速全文检索。
   - 语义相近但说法不同：必要时使用向量召回。
   - 需要准确原文：再返回对应聊天证据。
8. 召回结果只作为本轮参考，动态区域会被本轮新结果覆盖，不修改稳定的 `GEMINI.md` 正文。

## 新旧系统状态

| 部分 | 当前状态 |
|---|---|
| SQLite 原始聊天增量写入 | 已启用 |
| FTS5 全文索引 | 已启用 |
| `memory_recall` 按需召回 | MCP 已配置、协议测试通过；真实 Gem 调用尚待验证 |
| 后台整理任务队列 | 已接入 |
| 后台模型生成 Summary / Card / Fact | 暂停，等待以后配置模型 |
| 旧 LMC 召回 | 已关闭 |
| 旧 LMC 写入 | 已关闭 |
| 旧 `CORE_MEMORY.md` 同步 | 已关闭 |
| 旧 LMC 文件和代码 | 暂时保留，只用于回滚 |

## 为什么暂时不删除旧 LMC

删除不会让新系统更快。先保留一段观察期，可以在新链路出现遗漏时快速比较和回滚。确认真实聊天、重启和持续写入都稳定后，再单独做一次旧 LMC 清理；清理前还会再做备份。

## 主要开关

```env
BRIDGE_SQLITE_MEMORY_ENABLED=true
BRIDGE_SQLITE_MEMORY_SYNC_DELAY_MS=500
BRIDGE_LEGACY_LMC_RECALL_ENABLED=false
BRIDGE_LMC_WRITE_ENABLED=false
BRIDGE_LEGACY_SHARED_MEMORY_SYNC_ENABLED=false
```

## 已完成验证

- SQLite schema：V6
- 数据库完整性检查：通过
- 外键检查：通过
- 增量写入与重复执行：通过
- 新增、尚未生成向量的原文即时全文召回：通过
- 意图路由测试：24 / 24
- 统一召回测试：48 / 48
- MCP 工具测试：13 / 13
- 离线记忆生产器测试：20 项通过

## 接下来只需要做的事情

1. 让桥接在真实聊天中持续运行，观察 SQLite 是否稳定增量写入，并完成一次真实 Gem 自主召回验证。
2. 等有可用的后台模型后，再打开 Summary / Card / Fact 自动整理。
3. 观察期通过后，备份并删除旧 LMC 数据和不再需要的旧代码。
