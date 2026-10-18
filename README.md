# 三省六部 · Claude Code 插件 / 技能

把复杂任务当成一道“旨意”，按太子分拣 → 中书规划 → 门下审议 → 尚书派发 → 六部执行的流程推进。状态机、封驳、高风险确认、越权矩阵、委派防环与审计全部在本地完成，无需 OpenClaw 或外部服务。

## 功能

- 12 状态状态机：`Pending`、`Taizi`、`Zhongshu`、`Menxia`、`Assigned`、`Next`、`Doing`、`Review`、`PendingConfirm`、`Blocked`、`Done`、`Cancelled`
- 门下省准奏 / 封驳退回
- 高风险操作进入 `PendingConfirm`（`Review -> Done`、`Doing -> Cancelled`、`Menxia -> Cancelled`）
- 11 个角色：太子、中书省、门下省、尚书省、户部、礼部、兵部、刑部、工部、吏部、钦天监
- 越权矩阵、委派最大深度 3、循环委派拒绝
- 子任务单一 `in_progress` 校验
- 追加式审计 `audit.jsonl` 与静态 HTML 看板

## 安装为 Claude Code 插件

```bash
claude plugin marketplace add Caoran1314/sansheng-liubu
claude plugin install sansheng-liubu@sansheng-liubu-marketplace
```

重启 Claude Code（或在会话内 `/reload-plugins`）后生效。

用法：

```text
/sansheng-liubu:edict 把首页加载时间降到 1 秒以内
```

插件同时提供技能 `sansheng-liubu`，也可以直接说“走三省六部”。

## 安装为技能

```bash
npx skills add Caoran1314/sansheng-liubu -g -a claude-code
```

用法：

```text
/sansheng-liubu
```

## 要求

- Node.js 18+（无第三方依赖）
- Claude Code（插件方式）或任意支持 Agent Skills 的宿主（技能方式）

## 状态位置

默认：`~/.claude/edict/<项目名-哈希>/`

- `state.json`：任务、子任务、记忆、共享备忘、委派记录
- `audit.jsonl`：追加式审计
- `board.html`：`status --html` 生成的静态看板

可用 `EDICT_HOME` 覆盖状态目录。

## 目录结构

```text
.
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── commands/
│   └── edict.md
├── skills/
│   └── sansheng-liubu/
│       ├── SKILL.md
│       ├── reference.md
│       └── scripts/edict.mjs
├── agents/
│   └── *.md
├── README.md
└── LICENSE
```

## 许可

MIT
