'use strict';

// 对话删除/归档管理补丁（session-manage）单测（node --test）。
//
// 覆盖四层：
//   1. 全链一次应用：6 个目标文件（dsh-session / workspace-controller 三处
//      typert 协议同步 / api-remotes 客户端描述符 / 页内 slot 菜单）都写入，
//      关键注入产物齐备；
//   2. 逐项幂等：二遍零写入（本补丁用「insert/done 自身判完成」而非全局 MARKER
//      跳过，存量安装才能被后续新增替换项追补）；
//   3. 逐锚点反证：任一包内任一锚缺失 → 该包整体不落盘（单文件原子性），
//      其余包照常应用；
//   4. 锚点唯一性 + 链式安全：每个锚在自己的夹具里恰好命中一次，且每个 insert
//      都原样保留自己的锚（open-project-dir 会接在同一段原生代码之后，两补丁
//      任意先后都能命中）；
//   5. 链式幂等（真 pristine 字节）：与共享同一原生锚的 open-project-dir /
//      workspace-pin 连跑两遍，注入体必须各只有一份且产物可解析 —— 这是
//      2026-10-06 实测 P0 的回归位（见文件末尾两例）。
//
// 用法：node --test scripts/test/unit-session-manage.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { patchSessionManage, MARKER, TARGETS, buildFixtures } = require('../patch-session-manage');
const { DELETE_SESSION_MENU_GUARD } = require('../lib/host-capabilities');

function makeTree(t, fixtures) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = [];
  for (const fx of fixtures) {
    const file = path.join(root, ...fx.rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fx.text, 'utf8');
    files.push(file);
  }
  return { root, files };
}

/** 默认夹具：每包一份「只含本包锚点」的拼接文本。 */
function defaultFixtures() {
  return buildFixtures();
}

test('全链一次应用：6 个目标文件写入且关键产物齐备', (t) => {
  const { root, files } = makeTree(t, defaultFixtures());
  assert.equal(files.length, 6, '目标文件应为 6 个');
  const stats = { anchorMissing: 0, failed: 0 };
  const n = patchSessionManage(root, () => {}, stats);
  assert.equal(n, 6, '应修改 6 个文件');
  assert.equal(stats.anchorMissing, 0, '不应有锚点失配');
  assert.equal(stats.failed, 0, '不应有读写失败');

  const read = (rel) => fs.readFileSync(path.join(root, ...rel), 'utf8');
  const [session, ctrlHost, typertHost, ctrlClient, remotes, ui] = TARGETS.map((x) => read(x.rel));
  for (const [name, src] of [['dsh-session', session], ['workspace-controller', ctrlHost], ['typert.host', typertHost], ['controller client', ctrlClient], ['api-remotes', remotes], ['client-ui', ui]]) {
    assert.ok(src.includes(MARKER), `${name} 应写入 MARKER`);
  }
  // 1. dsh-session：live 注册表摘除能力。
  assert.ok(session.includes('remove(id)') && session.includes('this.detachEntered(entry)'), 'SessionStore.remove 应注入');
  // 2. 宿主控制器：命令 + 门面 + 依赖注入 + fs 侧清理。
  assert.ok(ctrlHost.includes('async deleteSession(request)'), 'deleteSession 命令应注入');
  assert.ok(ctrlHost.includes('return this.commands.deleteSession(request)'), '控制器门面应转发');
  assert.ok(ctrlHost.includes('static inject = ["typert", "workspaceRegistry", "agents", "sessions", "sessionPersistence"]'), 'inject 应补齐三个服务');
  assert.ok(ctrlHost.includes('import { rm } from "node:fs/promises"'), '应注入目录移除依赖');
  assert.ok(ctrlHost.includes('"cannot delete a running session: stop it first"'), '应拒绝运行中会话');
  // 3. typert 协议三处同步：宿主 STRICT 分发描述符。
  assert.ok(typertHost.includes('workspace/deleteSession'), 'typert.host 应含 deleteSession 描述符');
  assert.ok(typertHost.includes('_deepseek_ai_dsh_api_workspace_controller_workspace_deleteSession_parameter_0$schema'), 'typert.host 应含入参 schema');
  // 4. 客户端模型/门面。
  assert.ok(ctrlClient.includes('async deleteSession(sessionId)'), 'controller client 应注入模型方法');
  assert.ok(ctrlClient.includes('commandError("session delete"'), 'controller client 应注入门面错误串');
  // 5. api-remotes：remote.workspace.deleteSession 的 schema + descriptor。
  assert.ok(remotes.includes('"@deepseek-ai/dsh-api-workspace-controller#workspace/deleteSession"'), 'remotes 应注册 deleteSession 描述符');
  assert.ok(remotes.includes('WorkspaceDeleteSessionRequest'), 'remotes 应含请求类型符号');
  // 6. 页内：slot 注册 + 组件 + 注入闭包 + zh/en。
  assert.ok(ui.includes('id: "delete"') && ui.includes('order: 450'), '页内应注册 order 450 的删除行');
  assert.ok(ui.includes('function DeleteSessionMenuItem('), '页内应注入删除组件');
  // 桥缺失则整行不渲染。判定式按引用取契约常量（scripts/lib/host-capabilities
  // 的 DELETE_SESSION_MENU_GUARD，与 patch-session-manage 注入体逐字同源，并由
  // unit-host-capabilities 做跨文件核对）——这里原先手抄的是旧形态
  // `?.deleteSession === void 0`，注入体早已改成 `&& typeof … === "function"`，
  // 手抄漂移只会让断言钉不住真实字节。
  assert.ok(ui.includes('if (!(' + DELETE_SESSION_MENU_GUARD + ')) return null;'), '桥缺失时应整行不渲染');
  assert.ok(!ui.includes('?.deleteSession === void 0'), '不得退回旧的可选链判空形态');
  assert.ok(ui.includes('"menu.deleteSession": "删除对话"'), '应写入中文翻译');
  assert.ok(ui.includes('"menu.deleteSession": "Delete conversation"'), '应写入英文翻译');
});

test('逐项幂等：二遍零写入且字节不变', (t) => {
  const { root, files } = makeTree(t, defaultFixtures());
  assert.equal(patchSessionManage(root, () => {}, { anchorMissing: 0, failed: 0 }), 6);
  const before = files.map((f) => fs.readFileSync(f, 'utf8'));
  const stats = { anchorMissing: 0, failed: 0 };
  assert.equal(patchSessionManage(root, () => {}, stats), 0, '第二遍应零写入');
  assert.equal(stats.anchorMissing, 0, '第二遍不应报锚点失配');
  files.forEach((f, i) => assert.equal(fs.readFileSync(f, 'utf8'), before[i], `第 ${i} 个文件内容不应变化`));
});

test('逐锚点反证：任一锚缺失 → 该包整体不落盘，其余包照常应用', (t) => {
  TARGETS.forEach((target, ti) => {
    target.replacements.forEach((r, ri) => {
      const fixtures = defaultFixtures().map((fx, i) =>
        i === ti ? { rel: fx.rel, text: fx.text.replace(r.anchor, '/* ANCHOR-GONE */') } : fx
      );
      const { root, files } = makeTree(t, fixtures);
      const stats = { anchorMissing: 0, failed: 0 };
      const n = patchSessionManage(root, () => {}, stats);
      assert.equal(stats.anchorMissing, 1, `T${ti} 锚 #${ri} 缺失应计 anchorMissing=1`);
      assert.equal(n, TARGETS.length - 1, `T${ti} 锚 #${ri} 缺失应只少写 1 个文件`);
      const broken = fs.readFileSync(files[ti], 'utf8');
      assert.ok(!broken.includes(MARKER), `T${ti} 锚 #${ri} 缺失时不得落盘半截（MARKER 不应出现）`);
      assert.equal(broken, fixtures[ti].text, `T${ti} 锚 #${ri} 缺失时该文件字节级不变`);
    });
  });
});

test('锚点唯一性 + 链式安全（insert 必须原样保留自己的锚）', () => {
  // 唯一豁免：inject 声明是「就地改写数组元素」而非追加，原生那一行不可能原样保留。
  // 它幂等靠 insert 自身判完成、跨补丁靠别的包各写各的文件，不与本页内补丁抢锚。
  const MUTATES = ['static inject = [' ];
  const fixtures = buildFixtures();
  TARGETS.forEach((target, ti) => {
    const fx = fixtures[ti].text;
    target.replacements.forEach((r, ri) => {
      const hits = fx.split(r.anchor).length - 1;
      assert.equal(hits, 1, `T${ti} 锚 #${ri} 应命中 1 次，实为 ${hits}：${r.anchor.slice(0, 50)}`);
      if (!r.insert.includes(r.anchor)) {
        assert.ok(
          MUTATES.some((head) => r.anchor.startsWith(head)),
          `T${ti} 锚 #${ri} 的 insert 未保留锚 —— 与共享同一原生锚的补丁会互相挤掉`
        );
      }
    });
  });
});

test('目标包缺失时返回 0 且不抛异常', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sm-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stats = { anchorMissing: 0, failed: 0 };
  assert.equal(patchSessionManage(root, () => {}, stats), 0);
  assert.equal(stats.anchorMissing, 0, '包不在位不应计失配');
});

test('dryRun 不得写盘', (t) => {
  const fixtures = defaultFixtures();
  const { root, files } = makeTree(t, fixtures);
  const n = patchSessionManage(root, () => {}, { anchorMissing: 0, failed: 0 }, { dryRun: true });
  assert.equal(n, 0, 'dryRun 不应计入 changed');
  files.forEach((f, i) => assert.equal(fs.readFileSync(f, 'utf8'), fixtures[i].text, 'dryRun 不得改动文件'));
});

// ---------------------------------------------------------------------------
// 5. 链式幂等（真 pristine 字节）—— 2026-10-06 实测 P0 的回归位。
//
// 故障：dsh-client-ui-workspace/lib/client.js 同时是 session-manage(190)、
// open-project-dir(200)、workspace-pin(215) 三个 root 应用器的靶，而前两者共用
// 同两行原生锚（`function ArchiveSessionMenuItem(…)` / `const archiveInjected
// = () => ({`）。open-project-dir 把自己的注入体插在锚点行之前，那段位置正落在
// session-manage 的 insert 字节区间内部 → 「用 insert 判已完成」被从中间劈开 →
// 二遍 boot 重插一次 → DeleteSessionMenuItem / deleteInjected 各声明两遍 →
// 该 bundle 直接 SyntaxError（Identifier 'deleteInjected' has already been
// declared）。dsh-desktop/node_modules 的存量树当时实测已坏（delInj=2）。
//
// 为什么单测里原来抓不到：上面「逐项幂等」跑的是 sm 自己的合成夹具（没有第二
// 个补丁来劈它），而劈它的补丁只在真字节 + 全链编排里才动到那一段。ta3-boot-chain
// 的「二遍幂等」断言是这类跨补丁劈裂的通用守卫（changed 必须归零），本组两例是
// 它的定点版本（能直接指出坏在哪个注入体、判据是哪一条）。
// ---------------------------------------------------------------------------

const WS_REL = path.join('@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js');
const WS_PKG_REL = path.join('dsh-client-ui-workspace', 'lib', 'client.js');
// 只认 pristine 闭包树（findPristineFile 不回退 dsh-desktop/node_modules —— 那里
// 是打过补丁的存量树，拿它当 pristine 会让本组两例变成假绿）。
const { findPristineFile, describePristineRoots } = require('../lib/pristine-kernel-roots');
const wsPristineFile = findPristineFile(WS_PKG_REL);
const SKIP_NO_WS = '无 pristine 的 dsh-client-ui-workspace/lib/client.js（查过：' + describePristineRoots() + '）';

/** 只含工作区页内包的假 node_modules 根，靶文件为真 pristine 字节。 */
function makeWsTree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sm-chain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, WS_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(wsPristineFile, file);
  return { root, file };
}

/** 三个注入体各出现几次（>1 即重复注入）。 */
function injectionCounts(src) {
  return {
    deleteMenuItem: src.split('function DeleteSessionMenuItem(').length - 1,
    deleteInjected: src.split('const deleteInjected = ').length - 1,
    deleteRow: src.split('id: "delete",\n\t\t\t\t\torder: 450').length - 1,
    openDirItem: src.split('function OpenProjectDirMenuItem(').length - 1,
  };
}

/** ESM 语法可解析性（node --check 只认 .mjs/.cjs 后缀，故落一份 .mjs 副本）。 */
function syntaxErrorOf(root, src) {
  const probe = path.join(root, '_syntax-probe.mjs');
  fs.writeFileSync(probe, src, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', probe], { stdio: ['ignore', 'ignore', 'pipe'] });
    return null;
  } catch (err) {
    return String(err.stderr || err.message).split('\n').filter(Boolean)[0];
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

const wsChain = (root) => {
  const { patchOpenProjectDir } = require('../patch-open-project-dir');
  const { patchWorkspacePin } = require('../patch-workspace-pin');
  return [
    patchSessionManage(root, () => {}, { anchorMissing: 0, failed: 0 }),
    patchOpenProjectDir(root, () => {}, { anchorMissing: 0, failed: 0 }),
    patchWorkspacePin(root, () => {}, { anchorMissing: 0, failed: 0 }),
  ];
};

test('链式幂等（真字节）：sm→opd→wp 连跑两遍，注入体各一份且语法可解析', { skip: wsPristineFile ? false : SKIP_NO_WS }, (t) => {
  const { root, file } = makeWsTree(t);
  assert.deepEqual(wsChain(root).slice(1), [1, 1], '一遍应写入 opd / wp 各 1 个文件');
  const first = fs.readFileSync(file, 'utf8');
  assert.deepEqual(injectionCounts(first), { deleteMenuItem: 1, deleteInjected: 1, deleteRow: 1, openDirItem: 1 },
    '一遍后四个注入体都应恰好一份');
  assert.equal(syntaxErrorOf(root, first), null, '一遍后必须可解析');

  const second = wsChain(root);
  const after = fs.readFileSync(file, 'utf8');
  assert.deepEqual(second, [0, 0, 0], `二遍三个应用器都应零写入（实际 sm=${second[0]} opd=${second[1]} wp=${second[2]}）`);
  assert.equal(after, first, '二遍字节不得变化');
  assert.deepEqual(injectionCounts(after), { deleteMenuItem: 1, deleteInjected: 1, deleteRow: 1, openDirItem: 1 }, '不得出现重复声明');
  assert.equal(syntaxErrorOf(root, after), null, '二遍后仍须可解析');
});

test('反证：done 判据退回 insert 字节 → 链式二遍立刻重复注入并坏掉语法', { skip: wsPristineFile ? false : SKIP_NO_WS }, (t) => {
  const { root, file } = makeWsTree(t);
  assert.deepEqual(wsChain(root), [1, 1, 1], '前置：一遍各写 1');
  const ui = TARGETS.find((x) => x.rel.join('/').includes('dsh-client-ui-workspace'));
  const saved = ui.replacements.map((r) => r.done);
  try {
    // 复刻修复前形态：除第 0 项外都不声明 done，幂等判据退回「insert 全字节」。
    ui.replacements.forEach((r, i) => { if (i !== 0) r.done = undefined; });
    const n = patchSessionManage(root, () => {}, { anchorMissing: 0, failed: 0 });
    const src = fs.readFileSync(file, 'utf8');
    assert.equal(n, 1, 'insert 字节判据下二遍必然重写工作区文件（判据确实被劈开）');
    assert.equal(injectionCounts(src).deleteMenuItem, 2, '重写的后果是 DeleteSessionMenuItem 声明两遍');
    assert.equal(injectionCounts(src).deleteInjected, 2, 'deleteInjected 同样两遍');
    assert.ok(syntaxErrorOf(root, src), '产物必须是语法错误 —— 否则本反证没有证明任何东西');
  } finally {
    ui.replacements.forEach((r, i) => { r.done = saved[i]; });
  }
  // 判据复原后同一棵树立刻停止恶化（零写入）—— 起作用的是判据本身，不是文件状态。
  assert.deepEqual(wsChain(root), [0, 0, 0], 'done 判据复原后应零写入');
});
