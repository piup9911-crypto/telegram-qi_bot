# 摘要与 Memory Card 内容规则 V1

这份规则是后台 Summary / Card / Fact 生产器的内容约束。当前正式桥接已经写入原始聊天和任务队列，但外部整理模型仍关闭，因此这些规则目前只在离线生产器测试中执行。它们不允许修改稳定的 `GEMINI.md` 正文。

## Event Summary

Event Summary 回答“某次或某段对话发生了什么”，不是稳定人格档案，也不是当前项目状态表。

- `topic_key`：具体对象 + 动作，例如 `serverchan-reminder-test`；禁止只写“系统问题”“继续讨论”。
- `topic`：一眼能分辨事件的中文短标题。
- `gist`：40～120 个中文字符，包含发生了什么、结果如何、哪些地方尚未确认；不把助手自称完成当成已验证事实。
- `source_spans_json`：只列真正支撑摘要的连续原文区间。允许同一事件有多个分散区间，但不得用首尾消息包住中间无关聊天。
- `user_confirmed_json`：只放用户明确说过或确认过的内容，每项必须带用户消息 ID。
- `assistant_proposals_json`：只放助手建议、承诺或自称结果；不得混进 `user_confirmed_json`。
- `user_goals_json`：只记录用户明确想继续做的事；猜测、玩笑、被否定的计划不写入。
- `open_questions_json`：记录仍不确定、需要工具或原文验证的部分。
- `retrieval_terms_json`：4～8 个具体实体、动作或结果词；禁止只用“之前、系统、问题、成功”等泛词。
- 时间范围：从 `source_spans_json` 的真实消息日期计算，不使用摘要首尾索引包络。

证据等级：

- `user_confirmed`：存在用户原话支撑，可以参与普通历史召回。
- `assistant_only_or_unconfirmed`：只有助手说法或未确认信息；精确问题中降权，回答时必须说明未确认。
- `event_observation`：仅作为事件索引；需要事实答案时继续查原文或工具。

## Memory Card

Memory Card 回答“长期如何与用户相处、用户稳定偏好或边界是什么”，不保存某次事件经过。

- 一张 Card 只表达一个稳定规则或偏好。
- 默认要求用户明确表达，并至少关联 1 条用户原文证据。
- `title` 使用短名词短语；`content` 使用一到两句可执行描述，不写推理过程。
- `source_identity` 默认必须是 `user_explicit`；助手推测不得直接生成 Card。
- `recall_scope` 默认 `relevant_only`；敏感内容用 `explicit_only`；`always` 只给跨话题都必须遵守的明确边界。
- 当前项目状态、端口、路径、运行结果、一次性情绪和某天事件不写 Card。
- Card 不负责事实时间线；可变化的工作、住址、班次等进入 Fact Timeline。
- 新 Card 与现有 Card 高度重叠时合并证据，不重复建卡。

## 判空与更新

- 没有足够用户证据时允许不生成摘要或 Card。
- 新内容与 Card 只是语义相似、但规则对象或适用场景不同，不自动合并。
- Card 只有在用户明确纠正、撤回或给出新的稳定边界时才更新；保留来源和更新时间。
- Event Summary 不覆盖旧摘要；相同事件可补充来源，跨事件则新建摘要。
