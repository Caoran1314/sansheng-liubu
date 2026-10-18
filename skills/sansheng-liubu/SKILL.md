---
name: sansheng-liubu
description: 三省六部制多智能体任务编排（Claude Code 原生版）。当用户要求“走三省六部 / 下旨 / 朝堂流程”，或希望把复杂任务按太子分拣、中书规划、门下审议、尚书派发、六部执行的流程推进时使用。含 12 状态状态机、封驳退回、高风险确认、越权矩阵、委派防环与审计。
---

# 三省六部 · Claude Code 原生版

把复杂任务当成一道“旨意”，按三省六部流程推进。所有状态由本地 CLI 持久化，子代理通过 CLI 流转，不直接改状态文件。

## 何时使用

- 用户明确说“走三省六部 / 下旨 / 朝堂流程 / 让六部来做”。
- 任务跨多个模块、需要先规划再审议再分派执行。
- 闲聊、单步查询、小改动不要走本流程，直接处理。

## 快速开始

> **脚本路径**：下面的命令用 `${CLAUDE_PLUGIN_ROOT}`，Claude Code 在插件安装时会替换它。独立技能安装（通过 `npx skills add`）时该变量不会替换，请改用 `node ~/.claude/skills/sansheng-liubu/scripts/edict.mjs`。

```bash
# 1. 初始化（幂等）
node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs" init

# 2. 皇上（主代理）下旨
node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs" create \
  --title "把首页加载时间降到 1 秒以内" --as huangshang

# 3. 依次调用子代理：taizi -> zhongshu -> menxia -> shangshu -> 六部
```

状态默认存放在 `~/.claude/edict/<项目名-哈希>/`，可用 `EDICT_HOME` 覆盖。

## 编排步骤

1. **下旨**：主代理以 `huangshang` 身份 `create`，拿到 `JJC-YYYYMMDD-NNN`。
2. **太子分拣**：调用 `taizi` 子代理，把任务从 `Pending` 流转到 `Taizi`，再交 `Zhongshu`。
3. **中书规划**：调用 `zhongshu` 子代理，产出方案与子任务，流转到 `Menxia`。
4. **门下审议**：调用 `menxia` 子代理。准奏 → `Assigned`；封驳 → 退回 `Zhongshu` 并写清理由。
5. **尚书派发**：调用 `shangshu` 子代理，流转到 `Doing`，按专业分派六部。
6. **六部执行**：调用对应部门子代理。每个子任务先 `in_progress`，完成后 `completed` 并写 `--detail`；全部完成后 `done` 进入 `Review`。
7. **终审**：`Review -> Done` 属高风险，会进入 `PendingConfirm`，由 `menxia` 或皇上 `confirm --approve/--reject`。
8. **汇报**：`status --id <id>` 取最终状态，向用户汇报产出、验证证据和未完成项。

## 核心规则

- 子代理必须带身份：`--as taizi|zhongshu|menxia|shangshu|hubu|libu|bingbu|xingbu|gongbu|libu_hr|zaochao`。
- 不直接读写 `state.json`；所有变更走 CLI。
- 不得跳过门下省；封驳必须写明原因。
- 高风险转换（`Review->Done`、`Doing->Cancelled`、`Menxia->Cancelled`）必须确认。
- 同一任务同时只允许一个 `in_progress` 子任务。
- 委派遵循越权矩阵，最大深度 3，禁止循环。
- 简单问题直接回答；只有正式任务才创建旨意。

## 常用命令

```bash
# 查看
node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs" status [<id>] [--json] [--html]
node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs" list [--state Review]
node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs" audit [--id <id>] [--limit 50]

# 推进
node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs" move <id> --to <state> --as <role> [--note "说明"]
node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs" confirm <id> --approve|--reject --as menxia|shangshu [--note]

# 执行
node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs" progress <id> --now "当前动态" [--plan "a|b|c"] --as <role>
node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs" todo <id> --todo-id 1 --title "子任务" --status in_progress --as <role>
node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs" todo <id> --todo-id 1 --title "子任务" --status completed --detail "产出" --as <role>
node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs" done <id> --output "产出" --as <六部>
node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs" block <id> --reason "原因" --as <role>

# 协作
node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs" flow <id> --from 兵部 --to 尚书省 --remark "说明" --as <role>
node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs" delegate <id> --to <role> --instruction "内容" --as <zhongshu|shangshu>
node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs" delegate-result <id> --output "结果" --as <六部>
node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs" memory --text "记忆" [--pin] [--list] --as <role>
node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs" task-memo <id> --text "备忘" --as <role>
node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs" shared-memo --text "备忘" --as shangshu
```

状态、角色职责、越权矩阵和完整流转图见 [reference.md](reference.md)。

## 子代理

本技能配套 11 个子代理：`taizi`、`zhongshu`、`menxia`、`shangshu`、`hubu`、`libu`、`bingbu`、`xingbu`、`gongbu`、`libu_hr`、`zaochao`。

插件安装时，子代理带插件命名空间：`sansheng-liubu:taizi`、`sansheng-liubu:zhongshu`、`sansheng-liubu:menxia`、`sansheng-liubu:shangshu`，六部同理。独立技能安装时使用实际可用的 agent 名。

主代理负责按顺序调用；子代理只做本职工作并返回结论 + 证据 + 下一步。若当前环境不能调用子代理，主代理可临时以对应身份执行，但必须在汇报里标注“未走子代理”。

## 失败处理

- 非法转换 / 越权 / 封驳：CLI 会返回非零退出码和原因；按原因修正，不要绕过。
- 状态文件损坏：备份 `state.json` 后重新 `init`；已损坏文件不要直接覆盖。
- 委派深度或循环被拒：改为直接执行，或由尚书省重新分派。
- 卡住：先 `status --id` 和 `audit --id` 查最近流转，再决定回到哪一步。
