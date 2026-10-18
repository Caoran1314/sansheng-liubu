---
description: 走三省六部流程处理一个任务
argument-hint: [任务描述]
---

按 `sansheng-liubu` 技能处理以下旨意：

$ARGUMENTS

执行要求：

1. 读取技能说明 `skills/sansheng-liubu/SKILL.md`。
2. 用 `${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs` 初始化并下旨。
3. 依次调用 `sansheng-liubu:taizi`、`sansheng-liubu:zhongshu`、`sansheng-liubu:menxia`、`sansheng-liubu:shangshu` 和六部子代理。
4. 高风险操作必须确认；不得跳过门下省。
5. 最终汇报：任务 ID、最终状态、产出、验证证据、未完成项。
