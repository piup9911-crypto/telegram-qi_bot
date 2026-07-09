# 项目分区与拆分清单

生成时间：2026-06-30

这份清单用于把现在混在一起的网页、机器人、记忆系统和桥接工具拆成更清楚的项目边界。当前原则是：先建立边界和兼容路径，不直接移动正在运行的入口文件。

## 当前主项目定位

`C:\Users\yx\Documents\Codex\2026-04-21-gemini-cli-telegram`

保留为 **Gem 主 bot / Telegram-Antigravity 桥接主项目**。它应该只承载：

- Telegram Gem 主 bot：`telegram-gem-bridge.cjs`
- 主 bot 工作区：`bridge-workspace/`
- 主 bot 状态：`bridge-state/`
- LMC 记忆底座：`lmc-*.cjs`、`memory-*.cjs`、`shared-memory-sync.cjs`、`memory-docs/`
- Antigravity/sidecar 适配：`antigravity-*.cjs`、`sidecar-bootstrap.cjs`
- 主 bot 启动、健康检查、prompt preview、向量索引相关脚本

已恢复的主 bot prompt 文件：

- `bridge-workspace/GEMINI.md`

注意：`GEMINI.md` 当前同时包含静态 persona、运行时上下文和检索记忆段。后续应拆成：

- 静态：`persona.md`
- 动态：每轮生成的 runtime prompt
- 记忆：LMC 检索结果和压缩摘要

## 独立项目候选

### mini notion

来源仓库：`C:\Users\yx\Documents\New project\hello-vercel`

当前文件：

- `notion.html`
- `shared/notion-app.js`
- `shared/supabase-auth.js`
- `api/supabase-config.mjs`
- `supabase/schema.sql` 中的 `mini_notion_notes`
- `shared/pwa.js` 可选

拆分建议：可以作为独立静态 Web App。需要保留 Supabase 配置 API 和 auth helper。不要复制真实 env 或 token。

### 秘密日记

来源仓库：`C:\Users\yx\Documents\New project\hello-vercel`

当前文件：

- `secret-diary.html`
- `shared/secret-diary-app.js`
- `shared/supabase-auth.js`
- `api/supabase-config.mjs`
- `supabase/schema.sql` 中的 `secret_diary_entries`
- `shared/pwa.js` 可选

拆分建议：可以作为独立静态 Web App。`secret-diary.html` 内还有一段已经标记废弃的 localStorage 旧脚本注释，拆分时可以顺手清掉。

### 魔法实验室

来源仓库：`C:\Users\yx\Documents\New project\hello-vercel`

当前文件：

- `magic.html`
- `shared/pwa.js` 可选

拆分建议：最容易独立。它基本是纯前端页面，可以先单独成项目。

### 阿祈的小世界

来源仓库：`C:\Users\yx\Documents\New project\hello-vercel`

当前文件：

- `aqi-world.html`
- `data/aqi-answer-book.json` 需要再确认是否仍被页面或未来功能使用
- `shared/pwa.js` 可选

拆分建议：可以作为独立静态 Web App。当前页面主体是内联交互，拆分风险低。

### RP bot / RP Studio

来源仓库：

- `C:\Users\yx\Documents\Codex\2026-04-21-gemini-cli-telegram`
- `C:\Users\yx\Documents\New project\hello-vercel\tools\gemini-cli-telegram`

当前文件：

- `gem-chat-record-manager.cjs`
- `gem-chat-record-manager.html`
- `rp-runtime/`
- `rp-config/`
- `bridge-workspace-rp/`
- `bridge-state/rp-chats/`
- `tools/gemini-cli-telegram/rp-studio.html` 是 hello-vercel 侧的真实 RP Studio 页面
- 根目录 `rp-studio.html` 只是跳转壳

拆分建议：不要直接移动。`gem-chat-record-manager.cjs` 当前还引用主项目的 `sidecar-bootstrap.cjs` 和 `antigravity-sidecar-adapter.cjs`，并默认读取 `bridge-state/`。先复制成独立项目，再把状态目录和 sidecar 依赖参数化。

### Codex bot

来源仓库：`C:\Users\yx\Documents\Codex\2026-04-21-gemini-cli-telegram`

当前文件：

- `telegram-codex-bridge.cjs`
- `codex-sdk-session.cjs`
- `codex-openai-bridge.cjs`
- `codex-control-agent.cjs`
- `codex-bridge.env`
- `codex-bridge-state/`
- `codex-bridge-workspace/`
- `external/telecodex/` 如果仍在使用

拆分建议：可以独立，但需要单独的 env、state、workspace 和启动脚本。它不应该继续共享 Gem 主 bot 的运行状态。

## 暂时不拆或先冻结

### 桥接工具箱

暂时保留在主项目，直到确认哪些是 Gem 主 bot 专用、哪些是 RP/Codex 共用。

候选内容：

- `antigravity-*.cjs`
- `sidecar-bootstrap.cjs`
- `cloud-memory-client.cjs`
- `cloudflared.exe`
- 启动脚本、健康检查脚本、代理/隧道脚本

建议后续变成 `packages/bridge-toolbox` 或独立 npm-style 工具包，但现在先不要移动。

### memory.html

来源仓库：`C:\Users\yx\Documents\New project\hello-vercel`

当前判断：不建议继续在原页面上小修。它承载了旧 pending/approved 模型、LMC 分类管理、云端 CRUD 和旧 UI 假设，已经不适合作为新记忆系统主入口。

建议动作：

- 保留为 legacy 页面，短期不要删除路由
- 新建 `memory-console.html` 或重构为新页面
- 新页面围绕 LMC：curated memories、profile、evidence、relations、retrieval traces
- 删除前先确认 `index.html`、`memory-monitor.html`、`bridge-tools.html` 和文档链接都已改到新入口

### backend-cockpit.html

来源仓库：`C:\Users\yx\Documents\New project\hello-vercel`

当前判断：大部分 triage 内容已经过时，但页面还有“排查导航”的价值。建议降级为 legacy cockpit，不继续作为权威后台。

建议动作：

- 保留路由，标记 legacy
- 把真正的运行时状态看板迁到 Gem 主 bot 项目或新 `ops-console`
- 删除前先处理 `README.md`、`docs/BACKEND_COCKPIT.md`、`index.html`、`api/backend-overview.mjs`

## 记忆系统清理方向

`kind=long_term` 不应该继续作为新架构主分类，但不能直接删除兼容路径。

当前代码事实：

- `shared-memory-sync.cjs` 已经接受 `curated_memory`，并兼容旧的 `long_term`
- `memory-context.cjs` 仍有多处 `kinds: ["long_term"]` 检索点

建议顺序：

1. 把动态检索统一改为 `curated_memory` + `temporalType=stable`
2. 给旧 `long_term` 做只读兼容，不再写入
3. 验证 `CORE_MEMORY.md`、prompt preview、Telegram 实际回复都正常
4. 再删除 UI 里的旧分类显示和旧迁移按钮

## 是否需要 git worktree

暂时不需要为了“分项目”立刻建 worktree。

原因：

- 当前主仓库有大量未提交运行时状态和用户改动
- worktree 适合做同一仓库的并行分支，不适合直接把不同产品拆成独立生命周期
- 未提交内容不会自动进入新 worktree，容易误以为文件已经被带过去

推荐策略：

1. 先在现有目录完成边界标注和 legacy 冻结
2. 对纯前端页面先建立独立副本项目
3. 对 RP/Codex bot 使用“复制源代码 + 参数化路径 + 独立 env/state”的方式抽离
4. Gem 主 bot 保持当前路径稳定，先完成 LMC/上下文架构重整

真正需要 worktree 的场景：

- 要开一条 `codex/gem-main-cleanup` 分支做大规模重构
- 要保留当前运行态，同时在另一个目录做可回滚改造
- 要在拆分前准备干净 commit 边界

## 建议执行顺序

1. Gem 主 bot：修 prompt 分层、LMC 检索、sidecar 同步默认值和上下文预算
2. memory 页面：旧中心页删除；新记忆系统先分散到 records、profile、外部 notes 等真实入口
3. mini notion / 秘密日记 / 魔法实验室 / 阿祈的小世界：复制成独立 Web App
4. RP bot：抽离 `gem-chat-record-manager` 和 `rp-runtime`
5. Codex bot：独立 state/env/workspace
6. 桥接工具箱：最后再决定是共享包还是保留在 Gem 主 bot
