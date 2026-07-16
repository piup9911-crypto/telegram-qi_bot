# 事实更新 V1（Graphiti 轻量参考）

目标：旧事实不删除，新事实不乱接；每个结论都能回到原始聊天。

咱们参考 Graphiti 的时间事实和证据溯源机制，但 V1 继续使用 SQLite 八张业务表，不引入 Neo4j。当前自动事实生产尚未启用；这份文档描述的是离线验证通过、以后交给后台 worker 执行的规则。

## 实际流程

1. **Event Summary 提候选**：摘要仍可检索；没有长期价值就不建事实线。
2. **拆成原子事实**：一条只允许 `主体 -- 属性 --> 值`，不能把“换了 CLI”和“迁移仍在调整”揉成一条。
3. **保存价值门**：长期需要问当前状态或变化历史才进时间线；版本快照、一次卡顿等留在摘要。
4. **主体范围门**：项目局部故障不能写成工具全局故障；主体不明确就停写。
5. **找旧事实候选**：字段匹配、FTS5、向量只负责找候选，不能直接决定更新。
6. **关系判断**：只允许“同事实补证据、同时间线新状态、另建时间线、拒绝、歧义停写”。
7. **单独解析时间**：结构确认后再算 `valid_at / invalid_at`；没有明确开始时间时，以原话时间近似并标记 `approximate`。
8. **事务写入**：更新和证据关联一次完成；失败就整体回滚。

## 两张事实表

### `fact_timelines`

- `fact_key`：稳定事实线，例如 `user.work_schedule`
- `subject_key`：主体，例如 `user`
- `predicate_key`：会变化的属性，例如 `work_schedule`
- `current_event_id`：最后已知状态的事件
- `sensitivity / recall_scope`：敏感和召回范围

### `fact_events`

- `value_text / content`：该阶段的值和说明
- `valid_at`：从什么时候开始成立
- `invalid_at`：到什么时候不再成立；当前状态为 `NULL`
- `observed_at`：用户什么时候说出这条证据
- `recorded_at`：系统什么时候写入数据库
- `source_message_ids_json`：支持该事实的全部原始消息
- `is_current`：查询加速缓存，真实时间含义仍以 `invalid_at` 为准

## 更新规则

| 新输入与旧事实的关系 | 操作 |
|---|---|
| 同主体、同属性、同值 | 只把原始消息并入证据列表，不新增事实事件 |
| 同主体、同属性、新值 | 旧事件的 `invalid_at = 新事件.valid_at`，再追加新事件 |
| 只是在补录过去 | 插入历史区间，不改变最后已知状态 |
| 语义相关但主体或属性不同 | 另建时间线，不串线 |
| 主体、时间或证据不够清楚 | 不写；保留在 Event Summary / 原始聊天 |

## 本轮实验结论

- 旧测试库的 5 条时间线由 10 行整理为 7 条语义事实事件。
- 3 行“补充证据”合并进原事实，10 条原始证据关系全部保留。
- 旧排班在新排班生效时自动结束，旧记录没有删除。
- 迁移重复执行新增 0 行；SQLite 完整性和外键检查通过。
- 新聊天候选经过保存价值门和主体范围门后，本轮事实写入为 0；没有为了凑数量强行写入。
- 更新后召回回归为 22/22 和 28/28，敏感误召回为 0。

官方参考：

- [Graphiti Overview](https://help.getzep.com/graphiti/getting-started/overview)
- [Zep Facts](https://help.getzep.com/facts)
- [Searching the Graph](https://help.getzep.com/searching-the-graph)
- [Graphiti GitHub](https://github.com/getzep/graphiti)
