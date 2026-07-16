# 记忆数据库 V2 字段说明（简明版）

## 先说结论

- 当前是 **8 张业务表**，没有改成复杂图数据库。新增的 `event_occurrences` 是可重建的历史事件检索目录，不是长期记忆卡。
- 新增 **1 张后台任务表** `memory_processing_jobs`。它不保存记忆，只负责“什么时候处理、额度不足后何时重试、是否已经有同类任务在运行”。
- FTS5 搜索表和 View 是 SQLite 自动使用的辅助结构，不应算成业务表。
- 正式桥接当前使用同一套表结构增量写入 `raw_messages` 和任务队列；外部整理模型仍关闭，不调用 Gemini / DeepSeek。

## 八张业务表

### 1. `conversations`：原始聊天属于哪段来源

| 关键字段 | 中文作用 |
|---|---|
| `id` | 这段聊天的唯一编号 |
| `source_kind` | 来源，例如 Telegram、导入文件、实验数据 |
| `started_at / ended_at` | 原始记录覆盖的时间范围，只用于查询，不负责内容切段 |
| `source_file` | 能回到哪份原始文件 |
| `boundary_reason` | 为什么形成这一段来源 |
| `timezone_name` | 按哪个时区理解“今天、昨天下午”；目前默认上海时区 |

### 2. `raw_messages`：不可丢失的原始聊天

| 关键字段 | 中文作用 |
|---|---|
| `conversation_id` | 连接 `conversations` |
| `speaker` | user / assistant / system |
| `text` | 原话全文 |
| `timestamp / local_date` | 精确时间和本地日期 |
| `message_index` | 在整理后的顺序 |
| `source_message_index` | 在原始文件中的顺序 |
| `text_hash` | 去重和检查内容是否被改过 |
| `memory_review_status` | 完整处理状态：进入摘要 / 成为证据 / 只留原文 / 测试夹具 |
| `memory_review_reason` | 为什么没有写成长期记忆，或为什么被当作证据 |
| `memory_reviewed_at / memory_policy_version` | 什么时候、按哪版规则审阅过 |

原始消息不因为“低价值”而删除。Card 或摘要没记住的细节，仍可通过日期、全文检索和向量检索找回。

### 3. `event_summaries`：一段内容的可检索压缩

| 关键字段 | 中文作用 |
|---|---|
| `start_message_index / end_message_index` | 摘要对应哪些原始消息 |
| `topic_key / topic` | 同一个话题再次出现时可以串回去 |
| `summary_mode` | `index` 是短索引，`detailed` 是较完整摘要 |
| `gist` | 这段发生了什么 |
| `source_spans_json / observation_ids_json` | 回到原话的证据位置 |
| `user_confirmed_json` | 用户明确说过的内容 |
| `assistant_proposals_json` | 助手建议，不能冒充用户事实 |
| `open_questions_json` | 尚未解决的问题 |
| `memory_action` | 后续结果：待处理 / Card / 时间线 / 两者 / 只留摘要 |
| `memory_processed_at` | 什么时候完成记忆整理 |
| `memory_policy_version` | 当时用了哪版规则，规则变化后可判断是否需要重做 |

旧字段 `card_decision` 只记录 Card，不能表达“写入时间线”；V2 以后以 `memory_action` 为准。

### 4. `event_occurrences`：可重建的事件状态索引

| 关键字段 | 中文作用 |
|---|---|
| `event_key` | 同一种事件的稳定语义类别 |
| `occurrence_key` | 同一次事件的分组编号；开始和完成可以属于同一组 |
| `event_label / event_text` | 便于语义召回的事件名称和有证据描述 |
| `aliases_json` | 口语、简称和近义表达，只用于检索，不增加新事实 |
| `subject_key` | 用户、助手、双方或项目，防止人物串线 |
| `event_status` | 提到、请求、计划、开始、进行中、完成、失败、拒绝、中止、不确定 |
| `occurred_at / local_date` | 用于首次、最近和时间范围查询 |
| `source_message_ids_json` | 能回到哪些原始聊天证据 |
| `evidence_status / confidence` | 证据来自用户、混合对话还是仅助手文本；这里只评估索引证据，不代表当前事实置信度 |
| `sensitivity / recall_scope` | 敏感事件必须明确相关时才能召回 |

一件事可以有多条状态记录，但通过 `occurrence_key` 去重。因此“开始”和“完成”不会在次数统计中被算成两次。此表可从 Event Summary 和原始聊天重建，不能替代原文，也不自动进入 Memory Card。

### 5. `memory_cards`：稳定偏好、边界、计划等

| 关键字段 | 中文作用 |
|---|---|
| `subject_key` | 记的是谁：`user`、`user_mother` 等，防止人物串线 |
| `memory_key` | 同一张 Card 的稳定编号，用于合并重复表达 |
| `memory_type` | stable / plan / pattern / tracker / episode |
| `title / content` | 给召回和模型使用的简洁内容 |
| `domain / topic` | 先按领域缩小范围，再做语义相似查找 |
| `status` | active、停用等状态 |
| `source_identity` | 这条内容是谁明确说的；目前实验使用 `user_explicit` |
| `sensitivity` | ordinary / personal / sensitive |
| `recall_scope` | always / relevant_only / explicit_only |

这里不增加“模型自报置信度”。Card 是否可信，靠用户原话来源、人物路由和写入规则，而不是模型随手给一个百分数。

### 6. `memory_sources`：Card 与原话的连接表

| 关键字段 | 中文作用 |
|---|---|
| `memory_card_id` | 连接哪张 Card |
| `raw_message_id` | 来自哪句原话 |
| `relation` | supports / contradicts / mentions |
| `evidence_quote` | 原消息中真正支持 Card 的那一小段原话 |
| `added_at` | 什么时候把这条证据并入 Card |

一张 Card 可以连接多句原话；同一个偏好重复说三次时，不必生成三张 Card，而是增加三条来源关系。

### 7. `fact_timelines`：同一个会变化的事实线

| 关键字段 | 中文作用 |
|---|---|
| `fact_key` | 稳定事实线编号，例如 `user.work_schedule` |
| `subject_key` | 谁的事实 |
| `predicate_key` | 哪项会变化的属性，例如 `work_schedule` |
| `domain` | work / health / living 等领域 |
| `current_event_id` | 当前最后已知状态的快捷指针 |
| `sensitivity / recall_scope` | 隐私和召回边界 |

查旧事实线时先用 `subject_key + domain + predicate_key` 缩小范围，再用语义相似性排序；向量只找候选，不直接决定是否串线。

### 8. `fact_events`：事实线上的每一次状态或历史事件

| 关键字段 | 中文作用 |
|---|---|
| `timeline_id` | 连接哪条事实线 |
| `value_text / content` | 当时的值和说明 |
| `valid_at / invalid_at` | 从何时成立、到何时不再成立 |
| `observed_at` | 用户什么时候说 |
| `recorded_at` | 系统什么时候写入 |
| `event_kind` | 状态变化 / 补充证据 / 历史事件 |
| `source_message_ids_json` | 支持这条事实的所有原始消息 |
| `evidence_quotes_json` | 每条消息对应的精确原话片段 |
| `correction_of_event_id` | 如果用户在纠正旧话，明确指向被纠正的事件 |
| `is_current` | 当前状态查询的加速标记；真实时间仍以 valid/invalid 为准 |

事实更新不删除旧事实。新状态出现时，结束旧事件的有效时间并追加新事件；纠正则额外记录纠正关系。

## 一张运行辅助表

### `memory_processing_jobs`：后台处理队列

| 字段组 | 中文作用 |
|---|---|
| `job_kind / trigger_kind` | 做哪类整理、为什么触发 |
| `status / priority` | 待执行、运行、等待重试、成功、失败，以及优先级 |
| `input_message_ids_json` | 本次处理哪些原始消息，不需要一次塞几百条 |
| `retrieval_trace_json` | 保存本轮召回候选，后台整理直接复用，避免再做一次向量查找 |
| `provider / model / policy_version` | 以后接模型时记录实际使用者和规则版本 |
| `attempt_count / max_attempts` | 重试次数上限 |
| `next_attempt_at` | 429 或会员额度不足时，等到什么时候再试 |
| `lease_owner / lease_expires_at` | 防止两个 Antigravity 会话同时处理同一任务 |
| `last_error_code / last_error_message` | 记录 429、超时等原因，不需要人工盯着 |

同一段聊天的同类任务只允许有一个处于待执行、运行或等待重试状态，先从数据库层阻止重复并发。

## 当前不加的东西

- 不加 Neo4j / FalkorDB。
- 不加模型生成的置信度百分数。
- 不加人工审核队列。
- 不把废话强行写成 Card。
- 不让后台任务每轮对话都运行。
- 不修改稳定的 `GEMINI.md` 正文；召回工具只覆盖带标记的本轮动态区。

## 下一步接模型时的最短流程

1. 当前窗口正常聊天，不自动整理每一轮。
2. 只有记忆召回、用户明确要求记住/纠正，或空闲批处理时创建后台任务。
3. 一次任务只拿一小批未处理消息和本轮已经召回的候选。
4. 模型只负责内容分段、摘要和有限分类；程序负责字段校验、人物路由、唯一索引和事务写入。
5. 429 时任务进入 `retry_wait`，到 `next_attempt_at` 后再尝试，不阻塞当前回复。
## 派生中文检索索引（不计入八张业务表）

### `memory_search_documents`

| 字段 | 作用 |
|---|---|
| `target_id / target_type` | 指向 raw、Card、Summary、Goal、Event 或 Fact 的稳定召回编号 |
| `words_text` | Jieba 切分后的中文词语，使用空格分隔 |
| `aliases_text` | 来自主题、`retrieval_terms_json`、`aliases_json` 和事实键的别名词 |
| `subject_key / local_date` | 在全文检索后继续按人物和时间缩小范围 |
| `source_hash` | 判断源内容是否变化，变化后可重建该索引 |
| `tokenizer_version` | 记录实际切词规则；版本变化时必须重建 |

`memory_search_terms_fts` 是它的 FTS5 `unicode61` 索引。中文已经由 Jieba 预先插入空格，因此 SQLite 不再负责猜测中文词界。原有 trigram 表继续保留，两套索引都可以从八张业务表重新生成，不属于新的长期记忆。
