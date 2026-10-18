# 三省六部参考

## 角色

| ID | 名称 | 职责 |
|---|---|---|
| `huangshang` | 皇上 | 下旨、最终确认；由主代理担任 |
| `taizi` | 太子 | 接收与分拣，把正式任务交给中书省 |
| `zhongshu` | 中书省 | 规划方案、拆子任务、交门下省审议 |
| `menxia` | 门下省 | 审议方案；准奏或封驳；终审高风险操作 |
| `shangshu` | 尚书省 | 派发六部、协调、汇总结果 |
| `hubu` | 户部 | 数据、统计、资源与成本 |
| `libu` | 礼部 | 文档、规范、界面与对外沟通 |
| `bingbu` | 兵部 | 工程实现、架构与功能开发 |
| `xingbu` | 刑部 | 质量保障、测试验收与合规审计 |
| `gongbu` | 工部 | 基础设施、部署运维与性能监控 |
| `libu_hr` | 吏部 | 人员、团队与能力建设 |
| `zaochao` | 钦天监 | 早朝简报、状态巡检与风险提示 |

## 状态机

```
Pending -> Taizi -> Zhongshu -> Menxia -> Assigned -> Doing -> Review -> Done
                         ^          |                    |
                         |          v                    v
                         +------ Zhongshu             Blocked
                                      \                 /
                                       +-> Cancelled <--+
```

合法转换：

| 当前 | 可去 |
|---|---|
| Pending | Taizi, Cancelled |
| Taizi | Zhongshu, Cancelled |
| Zhongshu | Menxia, Cancelled, Blocked |
| Menxia | Assigned, Zhongshu, Cancelled |
| Assigned | Doing, Next, Blocked, Cancelled |
| Next | Doing, Blocked, Cancelled |
| Doing | Review, Done, Blocked, Cancelled |
| Review | Done, Menxia, Doing, Cancelled, PendingConfirm |
| PendingConfirm | Done, Review, Cancelled |
| Blocked | Taizi, Zhongshu, Menxia, Assigned, Next, Doing, Review, Cancelled |
| Done / Cancelled | 终态 |

## 高风险确认

以下转换不会直接生效，而是进入 `PendingConfirm`：

| 转换 | 确认方 |
|---|---|
| `Review -> Done` | `menxia` |
| `Doing -> Cancelled` | `shangshu` |
| `Menxia -> Cancelled` | `zhongshu` |

确认命令：

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs" confirm <id> --approve --as <confirm_by>
node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs" confirm <id> --reject  --as <confirm_by>
```

驳回后退回原状态。

## 越权矩阵（委派）

| 来自 | 可委派给 |
|---|---|
| taizi | zhongshu |
| zhongshu | menxia, shangshu |
| menxia | shangshu, zhongshu |
| shangshu | zhongshu, menxia, hubu, libu, bingbu, xingbu, gongbu, libu_hr |
| 六部 | shangshu |
| zaochao | 无 |
| huangshang | 任意 |

委派最大深度 3；路径中出现重复角色即判循环并拒绝。

## 角色可用命令

| 角色 | 命令 |
|---|---|
| taizi | create, state, flow, progress, todo, memory, task-memo |
| zhongshu | state, flow, progress, todo, memory, task-memo, delegate |
| menxia | state, flow, progress, todo, confirm, memory, task-memo |
| shangshu | state, flow, progress, todo, confirm, delegate, memory, task-memo, shared-memo |
| 六部 | progress, todo, done, block, memory, task-memo, delegate-result |
| zaochao | progress, todo, memory |
| huangshang | 全部 |

## 数据与审计

- 状态目录：`~/.claude/edict/<项目名-哈希>/`
- `state.json`：任务、子任务、记忆、共享备忘、委派记录
- `audit.jsonl`：追加式审计；超过 2 MB 自动保留最近 5000 行
- `board.html`：`status --html` 生成的静态看板
- 并发写使用 `state.lock` + 临时文件原子重命名

## 典型流程示例

```bash
E="node "${CLAUDE_PLUGIN_ROOT}/skills/sansheng-liubu/scripts/edict.mjs""

$E create --title "把首页加载时间降到 1 秒以内" --as huangshang
# 假设返回 JJC-20261018-001

$E move JJC-20261018-001 --to Taizi --as taizi
$E move JJC-20261018-001 --to Zhongshu --as taizi
$E move JJC-20261018-001 --to Menxia --as zhongshu
$E move JJC-20261018-001 --to Assigned --as menxia
$E move JJC-20261018-001 --to Doing --as shangshu

$E todo JJC-20261018-001 --todo-id 1 --title "定位慢请求" --status in_progress --as xingbu
$E todo JJC-20261018-001 --todo-id 1 --title "定位慢请求" --status completed --detail "已定位到 N+1" --as xingbu
$E todo JJC-20261018-001 --todo-id 2 --title "改为批量查询" --status in_progress --as bingbu
$E todo JJC-20261018-001 --todo-id 2 --title "改为批量查询" --status completed --detail "P95 从 2.1s 降到 420ms" --as bingbu

$E done JJC-20261018-001 --output "首页 P95 420ms" --as bingbu
$E move JJC-20261018-001 --to Done --as menxia
$E confirm JJC-20261018-001 --approve --note "验收通过" --as menxia
$E status JJC-20261018-001
```
