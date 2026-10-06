'use strict';

// issue #85 补丁脚本单元测试（node --test）。
//
// 覆盖五层：
//   1. 一次应用 → 产物为 0.2.0-rc.2 的槽位（slot）形态：项目行数组追加 +
//      会话行 slots.register(order 500) + 右键锚点矩形 + zh/en 翻译；
//   2. 二次幂等（MARKER 命中即整文件跳过）；
//   3. 逐锚点反证：抽掉 15 个锚里的任意一个，都必须「整文件跳过、字节级不变、
//      anchorMissing 计 1」——防止「某个锚其实根本没起作用、补丁默默少注入一处」
//      这种假绿（rc.2 换代时正是靠这条抓到 menuRect/open-folder 两处旧锚失效）；
//   4. 锚点唯一性：夹具里每个锚恰好命中一次（互不嵌套、互不重叠），否则
//      String.replace 会打到错误的那一处；
//   5. 链式安全：insert 默认必须原样保留自己的锚（这样任意两个共享原生锚的
//      补丁谁先跑都能命中）；确实要改写原生字节的替换显式列进 MUTATES 豁免表。
//
// 用法：node --test scripts/test/unit-open-project-dir.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { patchOpenProjectDir, MARKER, buildUiFixture, UI_REPLACEMENTS } = require('../patch-open-project-dir');

// 改写原生字段的替换（不是「保留锚再追加」）：图标名/guard 条件/onClick 体。
// 幂等靠 MARKER 整文件跳过兜住，跨补丁无关性靠实测两序全绿（见 .tmp-pi-apply）。
const MUTATES = [
  '}, {\n\t\t\t\tid: "delete",',                       // 项目行菜单尾部追加
  'if (id !== "rename" && id !== "delete") return;',   // 项目行 onSelect guard
  'items: workspaceMenuItems,',                        // 项目行 Menu 锚点矩形插桩
  '"aria-label": t("actions.workspace.aria"',          // 项目行 ⋯ 按钮 onClick
  '"aria-label": t("actions.session.aria"',            // 会话行 ⋯ 按钮 onClick
];

function tmpTree(t, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-open-dir-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content === undefined ? buildUiFixture() : content, 'utf8');
  return { root, file };
}

test('补丁脚本：一次应用产出 rc.2 槽位形态', (t) => {
  const tree = tmpTree(t);
  const n = patchOpenProjectDir(tree.root);
  assert.strictEqual(n, 1, '应补丁 1 个文件');
  const patched = fs.readFileSync(tree.file, 'utf8');
  assert.ok(patched.includes(MARKER), '应写入幂等标记');
  // 项目行：菜单项 + 点击直连宿主桥。
  assert.ok(patched.includes('id: "open-folder"'), '项目行菜单应含 open-folder 项');
  assert.ok(patched.includes('window.dshDesktop?.openPath?.(row.cwd)'), '项目行 open-folder 应直接引用宿主 openPath');
  // 会话行：rc.2 起改为 slot 注册（旧内联数组 sessionMenuItems 已退役）。
  assert.ok(patched.includes('function OpenProjectDirMenuItem('), '会话行应注入 slot 菜单组件');
  assert.ok(patched.includes('name: "sidebar.workspaces.session.menu.item"'), '会话行应注册进菜单 slot');
  assert.ok(patched.includes('order: 500'), '会话行 open-folder 应排在归档（400）之后');
  assert.ok(patched.includes('openSessionDir(sessionId, cwd)'), '会话行应经注入闭包打开目录');
  assert.ok(patched.includes('byId[sessionId]?.cwd'), 'cwd 应从 sessions 快照反查');
  // 降级：解析不到 cwd 或宿主桥缺失时整行不渲染，而不是留下点了没反应的死行。
  assert.ok(patched.includes('if (cwd === void 0 || !canOpenDir) return null;'), '不可用时应整行不渲染');
  assert.ok(patched.includes('canOpenDir: typeof window.dshDesktop?.openPath === "function"'), '桥在场性应显式探测');
  // 右键锚点矩形：四边齐备（只给 left/top 会让 portal 落到静态位置）。
  assert.ok(patched.includes('right: e.clientX + 1, bottom: e.clientY + 1'), '右键锚点矩形应含四边');
  assert.ok(patched.includes('getAnchorRect: () => menuRect'), '菜单应走 getAnchorRect');
  assert.ok(patched.includes('"menu.openProjectDir": "打开项目目录"'), '应写入中文翻译');
  assert.ok(patched.includes('"menu.openProjectDir": "Open project directory"'), '应写入英文翻译');
  // 幂等：二遍零写入且字节不变。
  const n2 = patchOpenProjectDir(tree.root);
  assert.strictEqual(n2, 0, '第二次应零写入');
  assert.strictEqual(fs.readFileSync(tree.file, 'utf8'), patched, '内容不应变化');
});

test('逐锚点反证：任一锚缺失都必须整文件跳过且不落盘', (t) => {
  const full = buildUiFixture();
  UI_REPLACEMENTS.forEach((r, i) => {
    const broken = full.replace(r.anchor, '/* ANCHOR-GONE */');
    assert.notStrictEqual(broken, full, `夹具里找不到锚 #${i}: ${r.anchor.slice(0, 40)}`);
    const tree = tmpTree(t, broken);
    const stats = { anchorMissing: 0, failed: 0 };
    const n = patchOpenProjectDir(tree.root, () => {}, stats);
    assert.strictEqual(n, 0, `锚 #${i} 缺失时不得计入 changed`);
    assert.strictEqual(stats.anchorMissing, 1, `锚 #${i} 缺失应计 anchorMissing=1`);
    assert.strictEqual(fs.readFileSync(tree.file, 'utf8'), broken, `锚 #${i} 缺失时文件字节级不变`);
  });
});

test('锚点唯一性：夹具中每个锚恰好命中一次', () => {
  const fx = buildUiFixture();
  UI_REPLACEMENTS.forEach((r, i) => {
    const hits = fx.split(r.anchor).length - 1;
    assert.strictEqual(hits, 1, `锚 #${i} 应命中 1 次，实为 ${hits}：${r.anchor.slice(0, 50)}`);
  });
});

test('链式安全：insert 保留锚，改写原生字节的须进 MUTATES 豁免表', () => {
  UI_REPLACEMENTS.forEach((r, i) => {
    if (r.insert.includes(r.anchor)) return;
    assert.ok(
      MUTATES.some((head) => r.anchor.startsWith(head) || r.anchor.includes(head)),
      `锚 #${i} 的 insert 未保留锚，也未登记为改写型：${r.anchor.slice(0, 60)}`
    );
  });
});

test('补丁脚本：目标包缺失时返回 0 且不抛异常', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-open-dir-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.strictEqual(patchOpenProjectDir(root), 0);
});

test('夹具本身不得含 MARKER（否则幂等分支吞掉首次应用）', () => {
  assert.ok(!buildUiFixture().includes(MARKER));
});
