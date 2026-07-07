# 阿祈记忆系统计划稿

> 记录时间：2026-07-06 / 2026-07-07  
> 状态：当前版初稿，后续继续细化  
> 背景：不直接扩展现有 LMC。新系统保留 LMC-5 的 raw events、curated memory、事实演变、召回 trace 等启发，但整体方案收束为更轻量的“记忆路由器 + 外部笔记 + 个人记忆 + 证据档案”。

## 1. 当前结论

我们不做一个包办所有事情的超级记忆库。当前方向是：

```text
Aqi Memory Router
负责判断去哪查、怎么组装上下文。

profile.md / system.md
保存稳定偏好、边界、人格和输出方式。

external notes
保存项目、代码、学习资料等变化快或体量大的内容。

personal memory
保存健康、self、关系、财务等长期个人状态。

evidence archive
保存用户原话、事件摘要、上下文定位信息。
```

一句话：

```text
稳定偏好写进 profile；变化快的放外部笔记；个人长期状态用轻量记忆卡；可变事实用时间线；原话只做证据。
```

## 2. 总体结构图

```mermaid
flowchart TD
  U["User 输入"] --> I["Input Layer<br/>保存原话 / 关键词触发 / 判断是否召回"]

  I --> R{"需要召回或查工具？"}

  R -->|"否"| C["当前上下文"]
  R -->|"记忆召回"| MR["Memory Router"]
  R -->|"外部资料/代码"| TR["Tool Router"]
  R -->|"明确要求修改外部文档"| ER["External Edit Router"]

  MR --> PM["Personal Memory<br/>memory_card / fact_timeline"]
  MR --> EV["Evidence Archive<br/>raw utterances / event summaries / clusters"]
  PM --> MB["Memory Context Block<br/>只整理记忆系统召回内容"]
  EV --> MB

  TR --> PN["Project Notes / Code Tools"]
  TR --> LV["Learning Vault / Notion / Obsidian"]
  PN --> EX["External Context<br/>工具返回结果 / 外部资料摘录"]
  LV --> EX

  ER --> ED["External Notes Update<br/>仅在明确触发时修改文档"]

  C --> OI["Output Inputs"]
  MB --> OI
  EX --> OI
  ED --> OI

  CFG["profile.md / system.md<br/>运行配置，不属于记忆系统"] -. "影响回复风格和边界" .-> OI

  OI --> O["Output Layer<br/>自然回答 / 工作时结构化"]

  O --> PU["Post-Output Processor"]
  PU --> RAW["raw_utterances<br/>保存 user 原话"]
  PU --> MW{"需要生成/更新 memory_card 或 timeline？"}
  PU --> ES{"需要 event_summary？"}
  PU --> EU{"外部文档更新？"}

  MW -->|"明确有价值"| MEM["Memory Update<br/>memory_card / fact_timeline"]
  MW -->|"不确定或无价值"| NO1["不写长期记忆"]

  ES -->|"达到阈值"| SUM["Event Summary<br/>按事件范围总结"]
  ES -->|"未达阈值"| NO2["不生成 summary"]

  EU -->|"输入已明确触发"| EXT["执行 External Notes Update"]
  EU -->|"未明确触发"| NO3["不改外部文档"]
```

## 3. 各部分职责

### 3.1 profile.md / system.md

用于保存稳定、长期、会影响模型行为的内容。它是运行配置，不属于记忆系统的一部分。

适合写入：

```text
用户偏好中文沟通。
用户不希望我擅自 clone 仓库或改系统设置。
日常聊天要自然，不必每次展示来源。
工作/项目讨论可以更结构化。
健康、财务、关系类回答要以用户输入为主，不做过度推断。
```

这些内容可以由用户手动修改，也可以在用户明确要求时让模型修改。

### 3.2 external notes

变化快、资料量大、需要工具实时确认的内容放外部。

项目/代码类：

```text
project-notes/<project>/overview.md
project-notes/<project>/decisions.md
project-notes/<project>/tasks.md
project-notes/<project>/file-map.md
project-notes/<project>/log.md
```

学习类：

```text
learning-vault/<topic>/notes.md
learning-vault/<topic>/reading.md
learning-vault/<topic>/progress.md
```

原则：

```text
项目细节不塞进通用长期记忆。
代码事实以仓库/工具实时查看为准。
学习资料原文放外部资料库。
通用记忆只记入口、大方向和长期偏好。
外部文档修改必须由明确关键词/指令触发，不能每轮自动修改。
```

### 3.3 personal memory

用于健康、self、关系、财务等长期个人状态。这里使用轻量 `memory_card`。

适合写入：

```text
用户明确表达的长期偏好。
用户确认的健康、财务、关系状态。
用户与模型的互动边界和沟通方式。
持续性的计划、目标、习惯、趋势。
```

不适合写入：

```text
模型自行诊断。
模型过度心理推断。
一次性闲聊。
未经用户确认的敏感判断。
```

### 3.4 evidence archive

保存用户原话和上下文定位，不等于当前事实。

用于回答：

```text
我是不是说过 xxx？
我原话怎么说的？
哪天提到过？
你记得我之前说过的 xxx 吗？
```

原则：

```text
原话是证据，不自动变成 current fact。
重复原话可以聚类，但不破坏代表性原文。
需要上下文时，通过 conversation_id + message_index 回查前后内容。
```

## 4. 输入、处理、输出、更新

整个系统按四段理解：

```text
Input
用户原始输入、保存原话、关键词触发召回或工具调用。

Processing
参考当前上下文、Memory Context、External Context，生成回答所需上下文。

Output
自然回答。日常不刻意展示来源；工作场景可以更明确；不确定就说明。

Post-Output
回复后处理：保存原话；必要时写 memory_card / fact_timeline；达到阈值才生成 event_summary；明确触发才修改外部文档。
```

## 5. 召回与工具触发策略

第一版采用关键词触发，不让模型每轮自行判断是否召回。

```text
无关键词触发 -> 不查长期记忆
有关键词触发 -> 分析语义，决定查哪里
```

触发词列表后续再确认。目前只保留方向：

```text
之前、以前、上次、那天、昨天、最近
你记得、我说过、我们聊过、原话
下一步、计划、待办、继续、还没做
那个项目、那个系统、这个文件、那个人
现在还是、有没有变、为什么改
```

外部文档修改也必须由明确触发词触发：

```text
写进项目笔记
更新 plan.md
记到 Obsidian
同步到学习笔记
整理成文档
加入 tasks
记录到 decisions
```

触发后不做复杂硬过滤，而是先生成简单路线：

```text
utterance_search  查用户原话
active_topic      查最近活跃主题
time/event        查某段事件摘要或日期附近内容
topic             查某个明确主题
domain            查大类范围
global_light      轻量全局兜底
tool_lookup       调用工具查看外部资料/代码
external_edit     明确修改外部文档
```

第一版避免过度复杂：

```text
不要每轮全局深搜。
不要复杂多跳图检索。
不要把 domain/topic 判断当硬门。
结果不确定时说不确定。
自动读取可以多一点，自动写入必须少一点。
```

## 6. Context Block 与 External Context

参考 Zep 的 context block 思路：召回后不要把零散记忆结果直接塞给模型，而是整理成回答需要的小包。

但外部工具查看结果不一定进入 Memory Context Block。

```text
Memory Context Block
只整理 Personal Memory 和 Evidence Archive 的召回内容。

External Context
Project Notes、Code Tools、Learning Vault、Notion、Obsidian 等工具返回内容。

Output Inputs
当前上下文 + Memory Context Block + External Context。
```

Memory Context Block 可以包含：

```text
current facts       当前有效事实
active plans        当前计划/待办
recent events       最近相关事件摘要
raw evidence        必要时的用户原话证据
warnings            旧事实/原话证据/推测不能当 current fact
```

日常聊天时 Memory Context Block 应该尽量轻；工作问题可以更完整。

## 7. memory_card 字段

当前采用：**统一基础信息 + 类型专属信息**。

不要每种记忆一套完全不同结构，也不要所有字段全部摊在一张表里到处填 null。

### 7.1 基础信息

所有记忆都有：

```text
记忆编号
记忆类型
标题
内容
所属大类
所属主题
当前状态
关键词
来源
来源强度
可信度
创建时间
更新时间
去重标识
```

示例：

```text
标题：召回采用关键词触发
内容：用户决定第一版采用关键词触发召回，而不是每轮让模型自行判断。
所属大类：系统设计 / 项目参考
所属主题：阿祈记忆系统
记忆类型：决定
当前状态：当前有效
关键词：召回、关键词触发、检索
来源：用户原话 2026-07-07
来源强度：用户明确决定
可信度：高
```

### 7.2 类型专属信息

不同记忆类型再附加专属信息。

事实 / 决定 / 偏好：

```text
事实线编号
是否当前事实
有效开始时间
对应时间线
```

计划 / 任务：

```text
截止时间
优先级
是否完成
完成时间
阻塞原因
```

临时事件：

```text
开始时间
过期时间
结束时间
临时事件类型
```

说明：

```text
临时事件不使用“检查时间”作为通用字段。
临时事件是否需要提醒/确认，由后续规则或事件类型决定。
周期性事件（例如经期）比较特殊，不按普通 temporary_event 处理，需要单独规划。
```

事件摘要：

```text
时间范围
来源原话/事件范围
关键决定
未决问题
重要程度
是否已经被长期记忆吸收
```

教训 / 经验：

```text
来源事件
适用主题
建议做法
需要避免的做法
```

### 7.3 不属于 memory_card 的内容

用户原话不放进 memory_card，单独进入 Evidence Archive。

```text
raw_utterances
保存原话、时间、会话编号、消息位置、主题提示、所属事件摘要。

utterance_clusters
保存相似原话的代表句、出现次数、首次/最近出现时间、每次出现的位置。
```

fact_timeline 也单独存在，通过事实线编号与 memory_card 连接。

## 8. fact_timeline：事实演变

可变事实不用 `supersedes / superseded_by` 互相指来指去，改用时间线。

原则：

```text
时间线按发生顺序保存：最早 -> 最新。
只有 current 需要明确标注。
历史信息只按时间呈现，不需要 old/discarded/considered 一堆状态。
current_event_id 指向当前有效版本。
```

示例：

```json
{
  "fact_key": "retrieval.trigger_policy",
  "topic": "阿祈记忆系统",
  "current_event_id": "evt_keyword_trigger",
  "events": [
    {
      "id": "evt_model_judge",
      "time": "2026-07-07T10:00:00",
      "content": "讨论过让模型自行判断是否召回。",
      "source_refs": ["utterance_001"]
    },
    {
      "id": "evt_keyword_trigger",
      "time": "2026-07-07T11:00:00",
      "content": "决定第一版采用关键词触发召回。",
      "source_refs": ["utterance_002"]
    }
  ]
}
```

检索/回答：

```text
问“现在是什么？” -> 读 current_event_id 指向的事件。
问“怎么变成这样的？” -> 按时间正序讲 timeline。
问“最近变化？” -> 倒序看最近事件。
```

## 9. event_summary

event summary 不是长期事实，而是把一段原始对话/一组事件压成“发生了什么”。

作用：

```text
帮助回答“那段对话大概发生了什么”。
帮助快速定位上下文。
帮助后续生成 memory_card。
不替代用户原话。
不替代 current fact。
```

第一版不每轮生成 event_summary。达到阈值才生成。

触发阈值：

```text
会话结束。
topic 明显切换。
同一 topic 累积到足够多有效消息，例如 20 条消息或 4000 字左右。
用户明确要求“总结一下 / 记录一下 / 整理一下”。
```

出现明确决定/计划/结论时，可以先标记本段有重要事件，但不一定立刻生成 summary；等会话结束、topic 切换或消息量达到阈值时一起总结。

示例：

```json
{
  "id": "event_summary_20260707_memory_design",
  "time_range": {
    "start": "2026-07-07T10:00:00",
    "end": "2026-07-07T12:00:00"
  },
  "topic": "阿祈记忆系统",
  "summary": "讨论了召回触发、项目记忆外部化、时间线式事实更新、原话证据去重，以及 event summary 的作用。",
  "key_decisions": [
    "第一版召回采用关键词触发。",
    "可变事实用时间线，current_event_id 标当前有效版本。",
    "项目/代码类记忆外部化。"
  ],
  "open_questions": [
    "关键词触发列表待确认。",
    "周期性事件需要单独规划。"
  ],
  "source_event_ids": ["evt_001", "evt_002", "evt_003"]
}
```

定期审计：

```text
event_summary 不能只写不管。
需要定期检查哪些 summary 太碎、重复、已被 memory_card 吸收、可以归档。
被吸收的 summary 默认不召回，只在用户问历史过程或原话上下文时使用。
```

## 10. raw_utterances 与 utterance_clusters

raw utterance 保存用户原话，至少包含：

```json
{
  "id": "utt_xxx",
  "speaker": "user",
  "text": "原话内容",
  "time": "2026-07-07T...",
  "conversation_id": "conv_20260707",
  "message_index": 123,
  "topic_hint": "阿祈记忆系统",
  "event_summary_id": "event_summary_20260707_memory_design"
}
```

重复/相似原话不要直接丢掉，先聚类：

```json
{
  "id": "ucl_lmc_not_expand",
  "theme": "用户不想继续扩展 LMC，想重新做记忆系统",
  "canonical_utterance_id": "utt_20260706_001",
  "canonical_text": "我不太想扩展lmc了，我想重新做一下，但是需要参考lmc的记忆方式。",
  "occurrences": [
    {
      "utterance_id": "utt_20260706_001",
      "time": "2026-07-06T...",
      "conversation_id": "conv_20260706",
      "message_index": 143
    },
    {
      "utterance_id": "utt_20260706_009",
      "time": "2026-07-06T...",
      "conversation_id": "conv_20260706",
      "message_index": 168
    }
  ],
  "count": 2,
  "first_seen": "2026-07-06T...",
  "last_seen": "2026-07-06T..."
}
```

原则：

```text
展示时用 canonical_text。
保留重复出现的时间点和位置。
必要时通过 conversation_id + message_index 查前后上下文。
被 memory_card 引用的原话长期保留。
明显重复且无证据价值的原文可后期归档，但不丢时间索引。
```

## 11. 外部化策略

### 11.1 项目/代码

项目类记忆特殊，变化快，单独外部化。

```text
通用记忆只保存项目入口和长期协作偏好。
项目细节写 project notes。
代码事实以仓库实时查看为准。
需要项目记忆时，Router 调用工具读取外部文件和代码。
```

### 11.2 学习

学习资料也适合外部库。

```text
通用记忆保存学习目标、阶段、偏好、进度入口。
学习资料原文、阅读笔记、课程内容放 learning vault / Notion / Obsidian。
```

### 11.3 健康 / 财务 / 关系 / self

这些放 personal memory，但要谨慎：

```text
健康、财务以用户输入为主，不做模型诊断。
用户和其他人的关系以用户明确写入为主，模型推测只作低置信观察。
用户和模型的关系可以记录互动偏好、边界和踩雷点。
self 是长期稳定偏好的核心来源，但非常稳定的内容应进入 profile.md。
经期等周期性健康事件需要单独设计，不直接套普通 temporary_event。
```

## 12. 第一版 MVP

第一版只做这些：

```text
1. profile.md / system.md 作为稳定偏好入口，但不算记忆系统本体。
2. Project Notes / Learning Vault 外部化。
3. Personal memory cards：基础信息 + 类型专属信息。
4. fact_timeline：按时间正序 + current_event_id。
5. raw_utterances：保存 user 原话和上下文定位。
6. utterance_clusters：重复原话聚类。
7. event_summary：达到阈值才生成。
8. 关键词触发召回和工具调用。
9. Memory Context Block：只整理记忆系统召回内容。
10. External Context：工具返回内容单独提供。
11. 基础 UI/管理：删除、归档、改 topic/domain、标记错误。
12. 基础审计：temporary_event 过期、event_summary 归档、needs_review backlog。
```

暂时不做：

```text
完整 E 轴。
复杂 MemoryCandidate 审核池。
全局大知识图谱。
复杂多跳推理。
自动人格分析。
每轮模型判断是否召回。
自动重写大型 snapshot。
项目文件关系长期死记。
周期性健康事件的完整规则。
```

## 13. 已确认设计决策

```text
1. 新系统不直接扩展现有 LMC。
2. 第一版采用关键词触发召回。
3. 项目/代码类记忆外部化，通过工具读取 project notes 和代码。
4. 学习资料外部化，通用记忆只记目标和进度入口。
5. Profile Memory 写进 system.md/profile.md，不算记忆系统本体。
6. Personal Memory 使用 memory_card，但分成基础信息和类型专属信息。
7. 可变事实用 fact_timeline，不用 supersedes/superseded_by 主导。
8. 时间线底层按时间正序保存，current_event_id 标当前版本。
9. 历史信息用时间线表达，不需要给历史贴太多状态。
10. 原话证据不等于 current fact。
11. 重复原话用 utterance_clusters 聚类，保留时间和上下文定位。
12. Event summary 用于定位一段对话，不替代长期事实，也不每轮生成。
13. 外部文档修改必须明确触发，不让模型自动乱改。
14. 日常回答自然，不必每次刻意展示来源；工作场景可以更明确。
15. 健康、财务、关系记忆以用户输入为主，模型推测必须有边界。
16. 周期性事件（如经期）单独规划，不套普通临时事件模板。
```

## 14. 后续待确认

```text
1. 固定 domain 的最终名字。
2. 关键词触发列表的最终版本。
3. 记忆类型列表的最终版本。
4. 各类型专属信息的最终字段。
5. source_strength 的枚举值。
6. confidence 是否保留，以及如何避免伪精确。
7. fact_key 如何生成，中文/英文命名规则。
8. event_summary 生成粒度：按会话、按 topic 切换，还是按消息数量。
9. event_summary 审计和归档规则。
10. raw_utterances 的保留期限和归档规则。
11. utterance_clusters 的相似度阈值。
12. Project Notes 和 Learning Vault 的实际目录结构。
13. Memory Context Block 的具体格式。
14. External Context 与 Memory Context 的组合规则。
15. UI 第一版具体做哪些管理能力。
16. 周期性健康事件，例如经期记录，如何单独建模。
```
