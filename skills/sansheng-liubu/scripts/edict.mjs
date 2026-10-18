#!/usr/bin/env node
/**
 * 三省六部状态机 CLI（Claude Code 原生实现）。
 *
 * 设计参考 cft0808/edict 的公开流程规格，但为独立重写：
 * 无 OpenClaw、无 Python、无第三方依赖，状态存于 ~/.claude/edict/。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const STATES = [
  'Pending', 'Taizi', 'Zhongshu', 'Menxia', 'Assigned', 'Next',
  'Doing', 'Review', 'PendingConfirm', 'Blocked', 'Done', 'Cancelled',
];
const TERMINAL = new Set(['Done', 'Cancelled']);

const TRANSITIONS = {
  Pending: ['Taizi', 'Cancelled'],
  Taizi: ['Zhongshu', 'Cancelled'],
  Zhongshu: ['Menxia', 'Cancelled', 'Blocked'],
  Menxia: ['Assigned', 'Zhongshu', 'Cancelled'],
  Assigned: ['Doing', 'Next', 'Blocked', 'Cancelled'],
  Next: ['Doing', 'Blocked', 'Cancelled'],
  Doing: ['Review', 'Done', 'Blocked', 'Cancelled'],
  Review: ['Done', 'Menxia', 'Doing', 'Cancelled', 'PendingConfirm'],
  PendingConfirm: ['Done', 'Review', 'Cancelled'],
  Blocked: [
    'Taizi', 'Zhongshu', 'Menxia', 'Assigned', 'Next', 'Doing',
    'Review', 'Cancelled',
  ],
  Done: [],
  Cancelled: [],
};

const HIGH_RISK = {
  'Review->Done': 'menxia',
  'Doing->Cancelled': 'shangshu',
  'Menxia->Cancelled': 'zhongshu',
};

const ROLES = {
  taizi: '太子',
  zhongshu: '中书省',
  menxia: '门下省',
  shangshu: '尚书省',
  hubu: '户部',
  libu: '礼部',
  bingbu: '兵部',
  xingbu: '刑部',
  gongbu: '工部',
  libu_hr: '吏部',
  zaochao: '钦天监',
  huangshang: '皇上',
};

const STATE_ORG = {
  Pending: '中书省',
  Taizi: '太子',
  Zhongshu: '中书省',
  Menxia: '门下省',
  Assigned: '尚书省',
  Next: '尚书省',
  Doing: '执行中',
  Review: '尚书省',
  PendingConfirm: '尚书省',
  Blocked: '阻塞',
  Done: '完成',
  Cancelled: '已取消',
};

const ALLOW_AGENTS = {
  taizi: ['zhongshu'],
  zhongshu: ['menxia', 'shangshu'],
  menxia: ['shangshu', 'zhongshu'],
  shangshu: ['zhongshu', 'menxia', 'hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr'],
  hubu: ['shangshu'],
  libu: ['shangshu'],
  bingbu: ['shangshu'],
  xingbu: ['shangshu'],
  gongbu: ['shangshu'],
  libu_hr: ['shangshu'],
  zaochao: [],
  huangshang: Object.keys(ROLES).filter((role) => role !== 'huangshang'),
};

const ROLE_COMMANDS = {
  taizi: ['create', 'state', 'flow', 'progress', 'todo', 'memory', 'task-memo'],
  zhongshu: ['state', 'flow', 'progress', 'todo', 'memory', 'task-memo', 'delegate'],
  menxia: ['state', 'flow', 'progress', 'todo', 'confirm', 'memory', 'task-memo'],
  shangshu: [
    'state', 'flow', 'progress', 'todo', 'confirm', 'delegate',
    'memory', 'task-memo', 'shared-memo',
  ],
  zaochao: ['progress', 'todo', 'memory'],
  hubu: ['progress', 'todo', 'done', 'block', 'memory', 'task-memo', 'delegate-result'],
  libu: ['progress', 'todo', 'done', 'block', 'memory', 'task-memo', 'delegate-result'],
  bingbu: ['progress', 'todo', 'done', 'block', 'memory', 'task-memo', 'delegate-result'],
  xingbu: ['progress', 'todo', 'done', 'block', 'memory', 'task-memo', 'delegate-result'],
  gongbu: ['progress', 'todo', 'done', 'block', 'memory', 'task-memo', 'delegate-result'],
  libu_hr: ['progress', 'todo', 'done', 'block', 'memory', 'task-memo', 'delegate-result'],
};

const TRANSITION_ACTORS = {
  'Pending->Taizi': ['taizi', 'huangshang'],
  'Taizi->Zhongshu': ['taizi', 'huangshang'],
  'Zhongshu->Menxia': ['zhongshu', 'huangshang'],
  'Zhongshu->Blocked': ['zhongshu', 'huangshang'],
  'Menxia->Assigned': ['menxia', 'huangshang'],
  'Menxia->Zhongshu': ['menxia', 'huangshang'],
  'Assigned->Doing': ['shangshu', 'huangshang'],
  'Assigned->Next': ['shangshu', 'huangshang'],
  'Next->Doing': ['shangshu', 'huangshang'],
  'Doing->Review': [
    'shangshu', 'hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr', 'huangshang',
  ],
  'Review->Done': ['menxia', 'huangshang'],
  'Review->Menxia': ['menxia', 'huangshang'],
  'Review->Doing': ['menxia', 'huangshang'],
  'Blocked->Taizi': ['taizi', 'huangshang'],
  'Blocked->Zhongshu': ['zhongshu', 'huangshang'],
  'Blocked->Menxia': ['menxia', 'huangshang'],
  'Blocked->Assigned': ['shangshu', 'huangshang'],
  'Blocked->Next': ['shangshu', 'huangshang'],
  'Blocked->Doing': ['shangshu', 'huangshang'],
  'Blocked->Review': ['shangshu', 'huangshang'],
};

const READ_ONLY = new Set(['status', 'list', 'audit', 'help', 'init']);
const MAX_DELEGATION_DEPTH = 3;
const MAX_AUDIT_BYTES = 2 * 1024 * 1024;
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed', 'blocked']);

const CWD = process.cwd();
const EDICT_HOME = process.env.EDICT_HOME
  ? path.resolve(process.env.EDICT_HOME)
  : path.join(os.homedir(), '.claude', 'edict', projectSlug(CWD));
const STATE_FILE = path.join(EDICT_HOME, 'state.json');
const AUDIT_FILE = path.join(EDICT_HOME, 'audit.jsonl');
const LOCK_FILE = path.join(EDICT_HOME, 'state.lock');
const BOARD_FILE = path.join(EDICT_HOME, 'board.html');

const ARGS = parseArgs(process.argv.slice(2));
const COMMAND = ARGS._[0];
const POSITIONAL = ARGS._.slice(1);

class CliError extends Error {}

function main() {
  try {
    runCommand();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (ARGS.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    } else {
      process.stderr.write(`❌ ${message}\n`);
    }
    process.exit(1);
  }
}

function runCommand() {
  if (!COMMAND || COMMAND === 'help' || ARGS.help) {
    printHelp();
    return;
  }
  if (COMMAND === 'init') {
    ensureHome();
    print(`已初始化：${EDICT_HOME}`);
    return;
  }
  ensureHome();
  const handler = COMMANDS[COMMAND];
  if (!handler) {
    throw new CliError(`未知命令：${COMMAND}（运行 help 查看用法）`);
  }
  withState((state) => handler(state));
}

function projectSlug(dir) {
  const base = path.basename(dir).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'root';
  const digest = crypto.createHash('sha1').update(dir.toLowerCase()).digest('hex').slice(0, 10);
  return `${base}-${digest}`;
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      result._.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      result[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      result[body] = next;
      i += 1;
    } else {
      result[body] = true;
    }
  }
  return result;
}

function ensureHome() {
  fs.mkdirSync(EDICT_HOME, { recursive: true });
}

function emptyState() {
  return {
    version: 1,
    project: CWD,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    tasks: [],
    memories: {},
    sharedMemos: [],
    delegations: [],
  };
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) {
    return emptyState();
  }
  const raw = fs.readFileSync(STATE_FILE, 'utf8');
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    throw new Error(`状态文件损坏：${STATE_FILE}；请先备份后运行 init`);
  }
  state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
  state.memories = state.memories && typeof state.memories === 'object' ? state.memories : {};
  state.sharedMemos = Array.isArray(state.sharedMemos) ? state.sharedMemos : [];
  state.delegations = Array.isArray(state.delegations) ? state.delegations : [];
  return state;
}

function writeState(state) {
  state.updatedAt = nowIso();
  const tmp = `${STATE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

function withState(fn) {
  const lockFd = acquireLock();
  try {
    const state = readState();
    const result = fn(state);
    writeState(state);
    return result;
  } finally {
    fs.closeSync(lockFd);
    try {
      fs.rmSync(LOCK_FILE, { force: true });
    } catch {
      // 锁文件删除失败不阻断结果；下次 acquiring 会因 EEXIST 重试。
    }
  }
}

function acquireLock() {
  for (let i = 0; i < 100; i += 1) {
    try {
      return fs.openSync(LOCK_FILE, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err;
      }
      sleep(20);
    }
  }
  throw new Error('状态文件被占用，请稍后重试');
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function nowIso() {
  return new Date().toISOString();
}

function todayId() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function nextTaskId(state) {
  const date = todayId();
  const prefix = `JJC-${date}-`;
  const used = state.tasks
    .map((task) => task.id)
    .filter((id) => typeof id === 'string' && id.startsWith(prefix))
    .map((id) => Number.parseInt(id.slice(prefix.length), 10))
    .filter((n) => Number.isFinite(n));
  const next = used.length ? Math.max(...used) + 1 : 1;
  return `${prefix}${String(next).padStart(3, '0')}`;
}

function actor() {
  const role = ARGS.as ?? ARGS.role ?? process.env.EDICT_ROLE;
  if (!role || role === true) {
    return null;
  }
  if (!ROLES[role]) {
    fail(`未知身份：${role}。可选：${Object.keys(ROLES).join(', ')}`);
  }
  return role;
}

function requireActor(command) {
  const role = actor();
  if (!role) {
    fail(`${command} 需要身份：加 --as <role> 或设置 EDICT_ROLE`);
  }
  if (role === 'huangshang' || READ_ONLY.has(command)) {
    return role;
  }
  const allowed = ROLE_COMMANDS[role] || [];
  if (!allowed.includes(command)) {
    fail(`越权：${ROLES[role]}（${role}）无权执行 ${command}`);
  }
  return role;
}

function requireTask(state, id) {
  const taskId = id || ARGS.id || POSITIONAL[0];
  if (!taskId || taskId === true) {
    fail('缺少任务 ID');
  }
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) {
    fail(`任务不存在：${taskId}`);
  }
  return task;
}

function requireValue(name, value) {
  if (value === undefined || value === true || String(value).trim() === '') {
    fail(`缺少参数 --${name}`);
  }
  return String(value);
}

function cleanText(value, max = 200) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function audit(state, action, extra = {}) {
  const entry = {
    at: nowIso(),
    actor: extra.actor ?? actor() ?? 'huangshang',
    action,
    ...extra,
  };
  try {
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
    const stat = fs.statSync(AUDIT_FILE);
    if (stat.size > MAX_AUDIT_BYTES) {
      const lines = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n');
      fs.writeFileSync(AUDIT_FILE, `${lines.slice(-5000).join('\n')}\n`, 'utf8');
    }
  } catch (err) {
    throw new Error(`审计写入失败：${err.message}`);
  }
  state.updatedAt = nowIso();
}

function taskSummary(task) {
  const todos = task.todos || [];
  const doneCount = todos.filter((todo) => todo.status === 'completed').length;
  return [
    `${task.id}  ${task.title}`,
    `状态: ${task.state}  归口: ${task.org || '-'}  负责人: ${task.official || '-'}`,
    `动态: ${task.now || '-'}`,
    todos.length ? `子任务: ${doneCount}/${todos.length} 完成` : '子任务: 无',
    task.block ? `阻塞: ${task.block}` : '',
    task.pending_confirm
      ? `待确认: ${task.pending_confirm.from_state} -> ${task.pending_confirm.target_state}（${task.pending_confirm.confirm_by}）`
      : '',
  ].filter(Boolean).join('\n');
}

function print(message) {
  if (ARGS.json) {
    process.stdout.write(`${JSON.stringify(message, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${message}\n`);
}

function ok(data, message) {
  if (ARGS.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  throw new CliError(message);
}

function validateTransition(from, to) {
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new Error(`非法状态转换：${from} -> ${to}（允许：${allowed.join(', ') || '无'}）`);
  }
}

function validateActorForTransition(role, from, to) {
  if (role === 'huangshang') {
    return;
  }
  if (to === 'Cancelled') {
    const allowed = ['taizi', 'zhongshu', 'menxia', 'shangshu', 'huangshang'];
    if (!allowed.includes(role)) {
      throw new Error(`越权：${ROLES[role]} 不能取消任务`);
    }
    return;
  }
  const allowed = TRANSITION_ACTORS[`${from}->${to}`];
  if (!allowed) {
    throw new Error(`没有为 ${from} -> ${to} 配置执行身份`);
  }
  if (!allowed.includes(role)) {
    throw new Error(`越权：${ROLES[role]} 不能执行 ${from} -> ${to}`);
  }
}

function applyState(task, nextState, note) {
  task.state = nextState;
  task.org = STATE_ORG[nextState] || task.org || '';
  if (note) {
    task.now = cleanText(note, 120);
  }
  task.updatedAt = nowIso();
}

const COMMANDS = {
  create(state) {
    const role = requireActor('create');
    if (!['taizi', 'huangshang'].includes(role)) {
      fail('只有皇上或太子可以下旨');
    }
    const title = cleanText(requireValue('title', ARGS.title ?? POSITIONAL[0]), 60);
    if (!title) {
      fail('旨意标题不能为空');
    }
    const id = nextTaskId(state);
    const task = {
      id,
      title,
      official: '-',
      org: STATE_ORG.Pending,
      state: 'Pending',
      now: '已下旨，等待太子分拣',
      risk: cleanText(ARGS.risk || 'medium', 20),
      block: '',
      output: '',
      ac: '',
      flow_log: [{
        at: nowIso(),
        from: '皇上',
        to: STATE_ORG.Pending,
        remark: title,
      }],
      progress_log: [],
      todos: [],
      memos: [],
      pending_confirm: null,
      delegation: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    state.tasks.unshift(task);
    audit(state, 'create', { taskId: id, detail: title });
    ok({ id, state: task.state }, `✅ 已下旨 ${id}：${title}`);
    return task;
  },

  move(state) {
    const role = requireActor('state');
    const task = requireTask(state, ARGS.id ?? POSITIONAL[0]);
    const to = ARGS.to ?? POSITIONAL[1];
    if (!to || to === true) {
      fail('缺少目标状态：--to <state>');
    }
    if (!STATES.includes(to)) {
      fail(`未知状态：${to}`);
    }
    if (TERMINAL.has(task.state)) {
      fail(`${task.id} 已处于终态 ${task.state}，不可再流转`);
    }
    if (task.state === 'PendingConfirm') {
      fail(`${task.id} 正在等待确认，请使用 confirm 命令`);
    }
    const from = task.state;
    validateTransition(from, to);
    validateActorForTransition(role, from, to);
    const note = cleanText(ARGS.note ?? '', 120);
    const riskKey = `${from}->${to}`;
    if (HIGH_RISK[riskKey]) {
      task.pending_confirm = {
        from_state: from,
        target_state: to,
        requested_by: role,
        requested_at: nowIso(),
        confirm_by: HIGH_RISK[riskKey],
      };
      task.state = 'PendingConfirm';
      task.org = STATE_ORG.PendingConfirm;
      task.now = `待确认: ${from} -> ${to}`;
      task.updatedAt = nowIso();
      audit(state, 'pending_confirm', {
        taskId: task.id, from, to, detail: `需 ${HIGH_RISK[riskKey]} 确认`,
      });
      ok(
        { id: task.id, state: task.state, confirmBy: HIGH_RISK[riskKey] },
        `⏳ ${task.id} 高风险操作 ${from} -> ${to}，已进入 PendingConfirm，需 ${ROLES[HIGH_RISK[riskKey]]} 确认`,
      );
      return;
    }
    applyState(task, to, note);
    audit(state, 'state', { taskId: task.id, from, to, detail: note });
    ok({ id: task.id, state: task.state, org: task.org }, `✅ ${task.id}: ${from} -> ${to}`);
  },

  confirm(state) {
    const role = requireActor('confirm');
    const task = requireTask(state, ARGS.id ?? POSITIONAL[0]);
    if (task.state !== 'PendingConfirm' || !task.pending_confirm) {
      fail(`${task.id} 没有待确认项`);
    }
    if (role !== 'huangshang' && role !== task.pending_confirm.confirm_by) {
      fail(`越权：该确认应由 ${ROLES[task.pending_confirm.confirm_by]} 执行`);
    }
    const approve = Boolean(ARGS.approve);
    const reject = Boolean(ARGS.reject);
    if (approve === reject) {
      fail('必须且只能指定 --approve 或 --reject');
    }
    const pending = task.pending_confirm;
    const note = cleanText(ARGS.note ?? '', 120);
    if (approve) {
      applyState(task, pending.target_state, note || '确认通过');
      task.pending_confirm = null;
      audit(state, 'confirmed', {
        taskId: task.id,
        from: pending.from_state,
        to: pending.target_state,
        detail: note,
      });
      ok(
        { id: task.id, state: task.state },
        `✅ ${task.id} 已确认：${pending.from_state} -> ${pending.target_state}`,
      );
      return;
    }
    applyState(task, pending.from_state, note || '确认驳回');
    task.pending_confirm = null;
    audit(state, 'confirm_rejected', {
      taskId: task.id,
      from: pending.target_state,
      to: pending.from_state,
      detail: note,
    });
    ok(
      { id: task.id, state: task.state },
      `↩️ ${task.id} 确认被驳回，退回 ${pending.from_state}`,
    );
  },

  flow(state) {
    const role = requireActor('flow');
    const task = requireTask(state, ARGS.id ?? POSITIONAL[0]);
    const fromDept = cleanText(requireValue('from', ARGS.from), 40);
    const toDept = cleanText(requireValue('to', ARGS.to), 40);
    const remark = cleanText(ARGS.remark ?? '', 120);
    task.flow_log = task.flow_log || [];
    task.flow_log.push({ at: nowIso(), from: fromDept, to: toDept, remark, actor: role });
    task.updatedAt = nowIso();
    audit(state, 'flow', { taskId: task.id, from: fromDept, to: toDept, detail: remark });
    ok({ id: task.id }, `✅ ${task.id} 流转记录：${fromDept} -> ${toDept}`);
  },

  progress(state) {
    const role = requireActor('progress');
    const task = requireTask(state, ARGS.id ?? POSITIONAL[0]);
    const now = cleanText(requireValue('now', ARGS.now ?? POSITIONAL[1]), 120);
    task.now = now;
    task.progress_log = task.progress_log || [];
    task.progress_log.push({ at: nowIso(), role, now });
    if (ARGS.plan) {
      task.plan = String(ARGS.plan)
        .split('|')
        .map((item) => cleanText(item, 60))
        .filter(Boolean);
    }
    task.updatedAt = nowIso();
    audit(state, 'progress', { taskId: task.id, detail: now });
    ok({ id: task.id, now }, `📡 ${task.id} 进展：${now}`);
  },

  todo(state) {
    requireActor('todo');
    const task = requireTask(state, ARGS.id ?? POSITIONAL[0]);
    const todoId = requireValue('todo-id', ARGS['todo-id'] ?? POSITIONAL[1]);
    const title = cleanText(requireValue('title', ARGS.title ?? POSITIONAL[2]), 60);
    const status = String(ARGS.status || 'pending');
    if (!TODO_STATUSES.has(status)) {
      fail(`非法 todo 状态：${status}（可选：${[...TODO_STATUSES].join(', ')}）`);
    }
    task.todos = task.todos || [];
    if (status === 'in_progress') {
      const another = task.todos.find(
        (todo) => todo.id !== todoId && todo.status === 'in_progress',
      );
      if (another) {
        fail(`已存在进行中的子任务 ${another.id}，同一任务只允许一个 in_progress`);
      }
    }
    let todo = task.todos.find((item) => item.id === todoId);
    if (!todo) {
      todo = { id: todoId, title, status, detail: '', createdAt: nowIso() };
      task.todos.push(todo);
    }
    todo.title = title;
    todo.status = status;
    if (ARGS.detail) {
      todo.detail = cleanText(ARGS.detail, 300);
    }
    todo.updatedAt = nowIso();
    task.updatedAt = nowIso();
    audit(state, 'todo', { taskId: task.id, detail: `${todoId}:${status}` });
    ok({ id: task.id, todo: todoId, status }, `✅ ${task.id} 子任务 ${todoId} -> ${status}`);
  },

  done(state) {
    const role = requireActor('done');
    const task = requireTask(state, ARGS.id ?? POSITIONAL[0]);
    if (task.state !== 'Doing') {
      fail(`${task.id} 当前状态 ${task.state}，只有 Doing 可以回报完成`);
    }
    const blockers = (task.todos || []).filter((todo) => todo.status !== 'completed');
    if (blockers.length) {
      fail(`还有未完成子任务：${blockers.map((todo) => todo.id).join(', ')}`);
    }
    const output = cleanText(ARGS.output ?? '', 600);
    task.output = output;
    task.official = ROLES[role] || role;
    applyState(task, 'Review', '六部回报完成，等待门下省审议');
    audit(state, 'done', { taskId: task.id, detail: output });
    ok({ id: task.id, state: task.state }, `✅ ${task.id} 已回报完成 -> Review`);
  },

  block(state) {
    const role = requireActor('block');
    const task = requireTask(state, ARGS.id ?? POSITIONAL[0]);
    const reason = cleanText(requireValue('reason', ARGS.reason ?? POSITIONAL[1]), 160);
    if (task.state === 'Blocked') {
      fail(`${task.id} 已经是 Blocked`);
    }
    task.block = reason;
    applyState(task, 'Blocked', `阻塞：${reason}`);
    audit(state, 'block', { taskId: task.id, detail: reason });
    ok({ id: task.id, state: task.state }, `⛔ ${task.id} 已阻塞：${reason}`);
  },

  delegate(state) {
    const role = requireActor('delegate');
    const task = requireTask(state, ARGS.id ?? POSITIONAL[0]);
    const to = String(ARGS.to ?? POSITIONAL[1] ?? '');
    if (!ROLES[to] || to === 'huangshang') {
      fail(`未知委派目标：${to}`);
    }
    const allowed = ALLOW_AGENTS[role] || [];
    if (!allowed.includes(to)) {
      fail(`越权：${ROLES[role]} 不能委派给 ${ROLES[to]}（允许：${allowed.map((r) => ROLES[r]).join(', ') || '无'}）`);
    }
    const instruction = cleanText(requireValue('instruction', ARGS.instruction), 200);
    const previous = task.delegation || { depth: 0, path: [] };
    const depth = previous.depth + 1;
    if (depth > MAX_DELEGATION_DEPTH) {
      fail(`委派深度超限（${depth} > ${MAX_DELEGATION_DEPTH}）`);
    }
    const history = previous.path.length ? previous.path : [role];
    if (history.includes(to)) {
      fail(`检测到循环委派：${[...history, to].join(' -> ')}`);
    }
    const nextPath = [...history, to];
    task.delegation = { depth, path: nextPath, last_to: to };
    const record = {
      id: `DLG-${Date.now()}-${state.delegations.length + 1}`,
      taskId: task.id,
      from: role,
      to,
      instruction,
      returnSpec: cleanText(ARGS['return-spec'] ?? '', 200),
      depth,
      path: nextPath,
      at: nowIso(),
      result: '',
    };
    state.delegations.push(record);
    task.updatedAt = nowIso();
    audit(state, 'delegate', {
      taskId: task.id, from: role, to, detail: instruction,
    });
    ok({ delegationId: record.id, depth, path: nextPath }, `✅ 已委派 ${record.id}：${ROLES[role]} -> ${ROLES[to]}`);
  },

  'delegate-result'(state) {
    const role = requireActor('delegate-result');
    const task = requireTask(state, ARGS.id ?? POSITIONAL[0]);
    const output = cleanText(requireValue('output', ARGS.output), 600);
    const records = state.delegations.filter((item) => item.taskId === task.id);
    if (!records.length) {
      fail(`${task.id} 没有委派记录`);
    }
    const record = records[records.length - 1];
    record.result = output;
    record.resultAt = nowIso();
    record.resultBy = role;
    task.updatedAt = nowIso();
    audit(state, 'delegate_result', { taskId: task.id, detail: output });
    ok({ delegationId: record.id }, `✅ ${task.id} 委派结果已回写`);
  },

  memory(state) {
    const role = requireActor('memory');
    const targetRole = String(ARGS.target || role);
    if (!ROLES[targetRole]) {
      fail(`未知衙门：${targetRole}`);
    }
    if (ARGS.list) {
      const items = state.memories[targetRole] || [];
      const ordered = [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned));
      ok({ role: targetRole, items: ordered }, ordered.map((item) => `${item.pinned ? '📌 ' : ''}${item.text}`).join('\n') || '（空）');
      return;
    }
    const text = cleanText(requireValue('text', ARGS.text), 200);
    const items = state.memories[targetRole] || [];
    items.push({ text, pinned: Boolean(ARGS.pin), at: nowIso() });
    while (items.length > 200) {
      const index = items.findIndex((item) => !item.pinned);
      items.splice(index === -1 ? 0 : index, 1);
    }
    state.memories[targetRole] = items;
    audit(state, 'memory', { detail: `${targetRole}: ${text}` });
    ok({ role: targetRole, count: items.length }, `🧠 ${ROLES[targetRole]} 记忆已记录`);
  },

  'task-memo'(state) {
    requireActor('task-memo');
    const task = requireTask(state, ARGS.id ?? POSITIONAL[0]);
    const text = cleanText(requireValue('text', ARGS.text), 200);
    task.memos = task.memos || [];
    task.memos.push({ text, at: nowIso() });
    task.updatedAt = nowIso();
    audit(state, 'task_memo', { taskId: task.id, detail: text });
    ok({ id: task.id }, `📝 ${task.id} 备忘已记录`);
  },

  'shared-memo'(state) {
    const role = requireActor('shared-memo');
    if (!['shangshu', 'huangshang'].includes(role)) {
      fail('只有尚书省或皇上可以写共享备忘');
    }
    const text = cleanText(requireValue('text', ARGS.text), 200);
    state.sharedMemos.push({ text, by: role, at: nowIso() });
    audit(state, 'shared_memo', { detail: text });
    ok({ count: state.sharedMemos.length }, '🗂️ 共享备忘已记录');
  },

  status(state) {
    if (ARGS.id || POSITIONAL[0]) {
      const task = requireTask(state, ARGS.id ?? POSITIONAL[0]);
      if (ARGS.html) {
        writeBoard(state);
        print(`已生成看板：${BOARD_FILE}`);
        return;
      }
      ok(task, taskSummary(task));
      return;
    }
    if (ARGS.html) {
      writeBoard(state);
      print(`已生成看板：${BOARD_FILE}`);
      return;
    }
    const counts = Object.fromEntries(STATES.map((stateName) => [stateName, 0]));
    for (const task of state.tasks) {
      counts[task.state] = (counts[task.state] || 0) + 1;
    }
    const pending = state.tasks.filter((task) => task.state === 'PendingConfirm');
    const lines = [
      `军机处看板（${state.project}）`,
      STATES.map((stateName) => `${stateName}:${counts[stateName]}`).join('  '),
      `任务总数: ${state.tasks.length}`,
      pending.length ? `待确认: ${pending.map((task) => task.id).join(', ')}` : '待确认: 无',
      '',
      ...state.tasks.map((task) => `${task.id}  [${task.state}]  ${task.title}`),
    ];
    ok({ counts, total: state.tasks.length, tasks: state.tasks }, lines.join('\n'));
  },

  list(state) {
    const filter = ARGS.state ? String(ARGS.state) : null;
    const tasks = state.tasks.filter((task) => !filter || task.state === filter);
    const lines = tasks.map(
      (task) => `${task.id}  [${task.state}]  ${task.org || '-'}  ${task.title}`,
    );
    ok({ tasks }, lines.join('\n') || '（无任务）');
  },

  audit(state) {
    if (!fs.existsSync(AUDIT_FILE)) {
      ok({ entries: [] }, '（无审计记录）');
      return;
    }
    const limit = Number(ARGS.limit || 50);
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const entries = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((entry) => !ARGS.id || entry.taskId === ARGS.id)
      .slice(-limit);
    ok(
      { entries },
      entries.map((entry) => `${entry.at}  ${entry.actor}  ${entry.action}  ${entry.taskId || ''}  ${entry.detail || ''}`).join('\n') || '（无审计记录）',
    );
  },
};

function writeBoard(state) {
  const escape = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const columns = STATES.map((stateName) => {
    const tasks = state.tasks.filter((task) => task.state === stateName);
    return `
      <section>
        <h2>${stateName} <span>${tasks.length}</span></h2>
        ${tasks.map((task) => `
          <article>
            <strong>${escape(task.id)}</strong>
            <p>${escape(task.title)}</p>
            <small>${escape(task.org || '-')} · ${escape(task.now || '')}</small>
          </article>
        `).join('')}
      </section>`;
  }).join('');
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>三省六部 · 军机处看板</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; background: #f5f2ea; color: #222; }
  h1 { font-size: 20px; }
  main { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
  section { background: #fff; border: 1px solid #ddd5c7; border-radius: 8px; padding: 12px; }
  h2 { font-size: 14px; margin: 0 0 8px; display: flex; justify-content: space-between; }
  article { border-top: 1px solid #eee; padding: 8px 0; }
  article p { margin: 4px 0; font-size: 13px; }
  small { color: #777; }
</style>
</head>
<body>
<h1>三省六部 · 军机处看板</h1>
<p>${escape(state.project)} · 更新于 ${escape(state.updatedAt)}</p>
<main>${columns}</main>
</body>
</html>`;
  fs.writeFileSync(BOARD_FILE, html, 'utf8');
}

function printHelp() {
  process.stdout.write(`三省六部 · Claude Code 原生实现

用法:
  node edict.mjs <命令> [参数]

身份:
  --as <role>    taizi | zhongshu | menxia | shangshu | hubu | libu |
                 bingbu | xingbu | gongbu | libu_hr | zaochao | huangshang
  也可设置环境变量 EDICT_ROLE。

命令:
  create   --title "旨意" [--risk high] [--as taizi|huangshang]
  move     <id> --to <state> --as <role> [--note "说明"]
  confirm  <id> --approve|--reject --as <menxia|shangshu|huangshang> [--note "说明"]
  flow     <id> --from <部门> --to <部门> --as <role> [--remark "备注"]
  progress <id> --now "当前动态" [--plan "计划1|计划2"] --as <role>
  todo     <id> --todo-id 1 --title "子任务" --status pending|in_progress|completed|blocked [--detail "..."]
  done     <id> --output "产出" --as <六部>
  block    <id> --reason "原因" --as <role>
  delegate <id> --to <role> --instruction "委派内容" --as <zhongshu|shangshu>
  delegate-result <id> --output "结果" --as <六部>
  memory   --text "记忆" [--pin] [--target <role>] [--list] --as <role>
  task-memo <id> --text "备忘" --as <role>
  shared-memo --text "备忘" --as <shangshu|huangshang>
  status   [<id>] [--json] [--html]
  list     [--state <state>] [--json]
  audit    [--id <id>] [--limit 50] [--json]
  init     初始化状态目录

状态:
  Pending -> Taizi -> Zhongshu -> Menxia -> Assigned -> Doing -> Review -> Done
  高风险: Review->Done（门下省）、Doing->Cancelled（尚书省）、
          Menxia->Cancelled（中书省）会进入 PendingConfirm。

状态目录: ${EDICT_HOME}
`);
}

main();
