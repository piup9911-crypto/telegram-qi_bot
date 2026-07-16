# RP Archive Snapshot

状态：已实现。本文记录 `source_type = "telegram_rp"` 的当前归档边界，不再是未来提案。

## 保存位置

- 活跃 RP 聊天：`bridge-state/rp-chats/<telegram_chat_id>.json`
- RP 归档目录：`rp-config/archives.json`

这些都是本机运行数据，不应提交到 Git。

## 归档保存什么

创建归档时会复制：

- 原始 `chat_id`、显示名称和消息列表
- 当前 preset 快照
- 当前 character 快照
- 已启用 lorebook 及其 entries 快照
- author note
- generation settings
- 归档时间

归档使用独立、不可变的 `id`。`display_name` 只用于显示，不能作为查询或恢复标识。

## 当前 API

| API | 作用 |
|---|---|
| `POST /api/rp/:chatId/archive` | 为当前 RP 聊天创建快照 |
| `GET /api/rp/archives` | 列出归档 |
| `GET /api/rp/archives/:archiveId` | 查看完整归档 |
| `POST /api/rp/archives/:archiveId/restore` | 从快照创建新的续聊会话 |

创建归档不会清空或改写当前活跃聊天。

## 恢复规则

恢复不会修改原归档，而是：

1. 生成新的 RP chat id。
2. 复制归档消息，并把来源标记为 `rp_archive_restore`。
3. 清空运行时 session id，让续聊建立新会话。
4. 从归档快照恢复 preset、character、lorebook 和 author note 绑定。
5. 新显示名称使用“原名称（续）”。

因此，旧归档始终保持只读；继续聊天发生在新活跃会话中。

## 当前边界

- 恢复以归档快照为准，不依赖同名配置是否后来被修改。
- 不把向量记忆或图数据库数据打包进 RP 归档。
- RP 归档和普通 Telegram 窗口归档是两套接口，不应混用。
