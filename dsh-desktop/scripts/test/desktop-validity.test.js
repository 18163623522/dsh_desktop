'use strict';
// desktop-validity.js 单测：候选收集 / 单包体检 / 跨包 loader id 冲突。
// 注意：假 yaml 是 JSON.parse，故 patch 文件一律用 JSON 数组文本。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  collectPluginCandidates,
  checkPluginPackage,
  validatePlugins,
} = require('../desktop-validity.js');
const { findPristineFile } = require('../lib/pristine-kernel-roots');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-valid-test-'));
}

function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

/** 便捷假 yaml（JSON 数组文本即可）。 */
const jsonYaml = { load: (t) => JSON.parse(t) };

const patchJson = (inserts) => JSON.stringify([{ insert: inserts }]);

test('collectPluginCandidates 按 bundle 清单收集，跳过官方与垫片', () => {
  const dir = tmpdir();
  // bundle 清单：社区 a-pkg（assets 有缓存）、b-pkg、@scope/c-pkg（node_modules 有）
  write(dir, 'package.json', JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'a-pkg', 'b-pkg', '@scope/c-pkg'] } } }));
  write(dir, 'assets/a-pkg/package.json', '{"name":"a-pkg"}');
  write(dir, 'assets/no-pkg/package.json', '{"name":"@deepseek-ai/dsh-balance"}'); // 官方核心跳过
  write(dir, 'assets/extra-pkg/package.json', '{"name":"extra-pkg"}'); // 不在清单也收（内置配套）
  write(dir, 'node_modules/b-pkg/package.json', '{"name":"b-pkg"}');
  write(dir, 'node_modules/@scope/c-pkg/package.json', '{"name":"@scope/c-pkg"}');
  write(dir, 'node_modules/@deepseek-ai/dsh-web-app/package.json', '{"name":"@deepseek-ai/dsh-web-app"}'); // 官方跳过
  write(dir, 'node_modules/cosmokit/package.json', '{"name":"cosmokit"}'); // 依赖垫片（不在清单）跳过
  const out = collectPluginCandidates(dir, null, path.join(dir, 'assets'), fs);
  const names = out.map((c) => c.name).sort();
  assert.deepStrictEqual(names, ['@scope/c-pkg', 'a-pkg', 'b-pkg', 'extra-pkg']);
  assert.strictEqual(out.find((c) => c.name === 'a-pkg').source, 'assets');
  assert.strictEqual(out.find((c) => c.name === 'b-pkg').source, 'profile');
  assert.strictEqual(out.find((c) => c.name === 'extra-pkg').source, 'assets');
  assert.ok(!names.includes('@deepseek-ai/dsh-balance'));
  assert.ok(!names.includes('@deepseek-ai/dsh-web-app'));
  assert.ok(!names.includes('cosmokit'));
});

test('checkPluginPackage 正常包无 issue，ids 收集', () => {
  const dir = tmpdir();
  write(dir, 'pkg/package.json', JSON.stringify({ name: 'ok-pkg', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  write(dir, 'pkg/cordis.patch.yml', patchJson([{ id: 'entry-a', name: 'ok-pkg' }]));
  const out = checkPluginPackage('ok-pkg', path.join(dir, 'pkg'), jsonYaml, fs);
  assert.deepStrictEqual(out.issues, []);
  assert.deepStrictEqual(out.ids, ['entry-a']);
  assert.strictEqual(out.patchOk, true);
});

test('issue #76: 启动清单内 bundle 缺 main 入口 → error（总结论不再误报“无问题”）', () => {
  const dir = tmpdir();
  // 声明 main 但入口文件不存在，且该包在启动清单中 → 必须是 error 级别
  write(dir, 'assets/graph-memory/package.json', JSON.stringify({
    name: 'graph-memory',
    main: 'dist/index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }));
  write(dir, 'assets/graph-memory/cordis.patch.yml', patchJson([{ id: 'gm', name: 'graph-memory' }]));
  const listed = checkPluginPackage('graph-memory', path.join(dir, 'assets/graph-memory'), jsonYaml, fs, true);
  const err = listed.issues.find((i) => /main 入口不存在/.test(i.text));
  assert.ok(err, '应有 main 入口缺失 issue');
  assert.strictEqual(err.level, 'error', '清单内缺 main 入口必须是 error');
  // 未列入清单 → 降级为 warning
  const unlisted = checkPluginPackage('graph-memory', path.join(dir, 'assets/graph-memory'), jsonYaml, fs, false);
  const warn = unlisted.issues.find((i) => /main 入口不存在/.test(i.text));
  assert.strictEqual(warn.level, 'warning', '未列入清单的缺 main 入口降级为 warning');
  // validatePlugins 汇总：清单内坏包 → ok:false（总结论不再与明细矛盾）
  write(dir, 'package.json', JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['graph-memory'] } } }));
  const out = validatePlugins(dir, null, path.join(dir, 'assets'), jsonYaml, fs);
  assert.strictEqual(out.ok, false, '存在清单内缺 main 入口的 bundle 时总结论必须为“会失败”');
  assert.ok(out.summary.errors >= 1, 'summary.errors 应包含该致命问题');
});

test('checkPluginPackage 缺 package.json / 无 dsh / 补丁缺失 / 解析失败', () => {
  const dir = tmpdir();
  // 缺 package.json
  const noPkg = checkPluginPackage('x-pkg', path.join(dir, 'no-pkg'), jsonYaml, fs);
  assert.strictEqual(noPkg.issues[0].level, 'error');
  assert.strictEqual(noPkg.patchOk, false);
  // 无 dsh 字段
  write(dir, 'plain/package.json', '{"name":"plain-pkg"}');
  const plain = checkPluginPackage('plain-pkg', path.join(dir, 'plain'), jsonYaml, fs);
  assert.strictEqual(plain.issues[0].level, 'warning');
  assert.match(plain.issues[0].text, /未声明 dsh 插件清单/);
  // 声明的 patch 文件不存在
  write(dir, 'ghost/package.json', JSON.stringify({ name: 'ghost-pkg', dsh: { bundle: { patch: './nope.yml' } } }));
  const ghost = checkPluginPackage('ghost-pkg', path.join(dir, 'ghost'), jsonYaml, fs);
  assert.strictEqual(ghost.issues[0].level, 'error');
  assert.match(ghost.issues[0].text, /补丁文件不存在/);
  // patch 解析失败
  write(dir, 'bad/package.json', JSON.stringify({ name: 'bad-pkg', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  write(dir, 'bad/cordis.patch.yml', '[{broken');
  const bad = checkPluginPackage('bad-pkg', path.join(dir, 'bad'), { load: () => { throw new Error('boom'); } }, fs);
  assert.strictEqual(bad.issues[0].level, 'error');
  assert.match(bad.issues[0].text, /解析失败/);
});

test('checkPluginPackage 包内重复 loader id 报 error', () => {
  const dir = tmpdir();
  write(dir, 'pkg/package.json', JSON.stringify({ name: 'dup-pkg', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  write(dir, 'pkg/cordis.patch.yml', patchJson([{ id: 'same-id' }, { id: 'same-id' }]));
  const out = checkPluginPackage('dup-pkg', path.join(dir, 'pkg'), jsonYaml, fs);
  assert.ok(out.issues.some((i) => i.level === 'error' && /重复的 loader 条目 id「same-id」/.test(i.text)));
});

test('checkPluginPackage 自动探测未声明 patch 的 cordis.patch.yml', () => {
  const dir = tmpdir();
  write(dir, 'pkg/package.json', '{"name":"probe-pkg","dsh":{"bundle":{}}}');
  write(dir, 'pkg/cordis.patch.yml', patchJson([{ id: 'probed' }]));
  const out = checkPluginPackage('probe-pkg', path.join(dir, 'pkg'), jsonYaml, fs);
  assert.deepStrictEqual(out.ids, ['probed']);
});

test('validatePlugins 跨包 id 冲突（含 profile 主 patch）', () => {
  const dir = tmpdir();
  const profileDir = dir;
  write(profileDir, 'package.json', '{"name":"p"}');
  write(dir, 'assets/a-pkg/package.json', JSON.stringify({ name: 'a-pkg', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  write(dir, 'assets/a-pkg/cordis.patch.yml', patchJson([{ id: 'clash' }]));
  write(dir, 'assets/b-pkg/package.json', JSON.stringify({ name: 'b-pkg', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  write(dir, 'assets/b-pkg/cordis.patch.yml', patchJson([{ id: 'clash' }, { id: 'solo' }]));
  // profile 主 patch 也有 clash（组合层 insert）
  write(profileDir, 'cordis.patch.yml', '[{"id":"web","insert":[{"id":"clash"},{"id":"only-me"}]}]');
  const out = validatePlugins(profileDir, null, path.join(dir, 'assets'), jsonYaml, fs);
  assert.strictEqual(out.ok, false);
  const clash = out.conflicts.find((c) => c.id === 'clash');
  assert.ok(clash, 'clash 应被检出');
  assert.deepStrictEqual(clash.owners.sort(), ['a-pkg', 'b-pkg', 'profile/cordis.patch.yml']);
  assert.ok(out.summary.errors >= 1);
  // solo / only-me 不冲突
  assert.ok(!out.conflicts.some((c) => c.id === 'solo'));
  assert.ok(!out.conflicts.some((c) => c.id === 'only-me'));
});

test('validatePlugins 健康 profile 全绿', () => {
  const dir = tmpdir();
  const profileDir = dir;
  write(profileDir, 'package.json', '{"name":"p"}');
  write(profileDir, 'cordis.patch.yml', '[{"id":"web","insert":[{"id":"p-main"}]}]');
  write(dir, 'assets/a-pkg/package.json', JSON.stringify({ name: 'a-pkg', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  write(dir, 'assets/a-pkg/cordis.patch.yml', patchJson([{ id: 'p-a', name: 'a-pkg' }]));
  const out = validatePlugins(profileDir, null, path.join(dir, 'assets'), jsonYaml, fs);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.checked.length, 1);
  assert.deepStrictEqual(out.conflicts, []);
  assert.deepStrictEqual(out.contractViolations, []);
});

// ---------- 启动清单契约（0.2.0-rc.2：逐 bundle 容错跳过，不再 fail-loud）----------

test('checkPluginPackage: 清单内（listed）缺 dsh 声明 → error，未列出 → warning', () => {
  const dir = tmpdir();
  write(dir, 'plain/package.json', '{"name":"plain-pkg"}');
  const notListed = checkPluginPackage('plain-pkg', path.join(dir, 'plain'), jsonYaml, fs, false);
  assert.strictEqual(notListed.issues[0].level, 'warning');
  const listed = checkPluginPackage('plain-pkg', path.join(dir, 'plain'), jsonYaml, fs, true);
  assert.strictEqual(listed.issues[0].level, 'error');
  assert.match(listed.issues[0].text, /启动清单/);
  // rc.2 起后果是「跳过该 bundle + stderr 一行」，不是击穿启动。正文必须写真实
  // 形态：仍升级为 error（我们发出去的插件会静默哑掉），但不得再声称 fail-loud。
  assert.match(listed.issues[0].text, /跳过该 bundle/);
  assert.match(listed.issues[0].text, /skipping profile bundle/);
  assert.doesNotMatch(listed.issues[0].text, /下次启动会 fail-loud/);
});

test('checkPluginPackage: listed 且 dsh.bundle 缺 patch 声明 → error', () => {
  const dir = tmpdir();
  // dsh.bundle 是空对象（无 patch 字符串声明）
  write(dir, 'pkg/package.json', '{"name":"bad-bundle","dsh":{"bundle":{}}}');
  const out = checkPluginPackage('bad-bundle', path.join(dir, 'pkg'), jsonYaml, fs, true);
  const err = out.issues.find((i) => i.level === 'error' && /启动清单/.test(i.text));
  assert.ok(err, '应报「在启动清单中但未声明 dsh.bundle.patch」error');
  // 两种缺声明在 rc.2 内核里抛的是两条不同的 reason 串，正文要分别点名，
  // 否则排查时按一个串去 grep stderr 会扑空。
  assert.match(err.text, /declares no dsh\.bundle/);
  assert.match(err.text, /dsh\.bundle\.patch must be a file path/);
  // 同包未列出时该契约问题不升级为 error
  const notListed = checkPluginPackage('bad-bundle', path.join(dir, 'pkg'), jsonYaml, fs, false);
  assert.ok(!notListed.issues.some((i) => i.level === 'error' && /启动清单/.test(i.text)), '未列出不报契约 error');
});

// 内容契约：诊断正文引用的三条内核串，必须是 rc.2 内核真的会打出来的串。
// 内核换版改文案时这条先红，避免我们的指引让用户去 stderr 找一行不存在的话。
test('rc.2 正证：诊断正文引用的 reason 串确实来自内核 loadProfileDirectory', () => {
  const rel = 'dsh-app-boot/lib/index.js';
  const hit = findPristineFile(rel);
  const target = hit || path.join(__dirname, '..', '..', 'node_modules', '@deepseek-ai', ...rel.split('/'));
  assert.ok(fs.existsSync(target), '找不到内核 dsh-app-boot 入口：' + target);
  const src = fs.readFileSync(target, 'utf8');
  assert.ok(/for \(const packageName of bundles\) try \{/.test(src), 'rc.2 内核应逐 bundle try/catch');
  assert.ok(src.includes('skipping profile bundle'), 'reportSkippedBundles 的 stderr 前缀');
  assert.ok(src.includes('declares no dsh.bundle in its package.json'), '缺 dsh.bundle 的 reason 串');
  assert.ok(src.includes('dsh.bundle.patch must be a file path or a list of file paths'), '缺/错 patch 的 reason 串');
});

test('validatePlugins: 清单内坏包 → ok:false + contractViolations 列出', () => {
  const dir = tmpdir();
  const profileDir = dir;
  // 清单声明 bad-pkg（缺声明）与 good-pkg（正常）
  write(profileDir, 'package.json', JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['bad-pkg', 'good-pkg'] } } }));
  write(dir, 'assets/bad-pkg/package.json', '{"name":"bad-pkg"}');
  write(dir, 'assets/good-pkg/package.json', JSON.stringify({ name: 'good-pkg', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  write(dir, 'assets/good-pkg/cordis.patch.yml', patchJson([{ id: 'good' }]));
  const out = validatePlugins(profileDir, null, path.join(dir, 'assets'), jsonYaml, fs);
  assert.strictEqual(out.ok, false, '清单内坏包 → 体检不通过');
  assert.deepStrictEqual(out.contractViolations, ['bad-pkg']);
  assert.ok(out.checked.find((c) => c.name === 'bad-pkg').listed, 'checked 项带 listed 标志');
  assert.ok(!out.checked.find((c) => c.name === 'good-pkg').issues.some((i) => i.level === 'error'));
});

test('validatePlugins: 覆盖条目（disabled/config）不算注册 → 不产生假跨包冲突', () => {
  const dir = tmpdir();
  const profileDir = dir;
  // 包 harness-pet 注册 id=harness-pet；profile 主 patch 里同名条目是
  // disabled 覆盖（默认禁用），不注册 —— 二者不应构成冲突
  write(profileDir, 'package.json', JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['harness-pet'] } } }));
  write(profileDir, 'cordis.patch.yml', '[{"id":"harness-pet","disabled":true},{"id":"web","insert":[{"id":"balance"}]}]');
  write(dir, 'assets/harness-pet/package.json', JSON.stringify({ name: 'harness-pet', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  write(dir, 'assets/harness-pet/cordis.patch.yml', patchJson([{ id: 'harness-pet', name: 'harness-pet' }]));
  const out = validatePlugins(profileDir, null, path.join(dir, 'assets'), jsonYaml, fs);
  assert.strictEqual(out.ok, true, '覆盖条目不参与注册，无冲突');
  assert.deepStrictEqual(out.conflicts, []);
  // 反向对照：若同名条目是纯注册直条目（name-only），则构成真冲突
  write(profileDir, 'cordis.patch.yml', '[{"id":"harness-pet","name":"harness-pet"},{"id":"web","insert":[{"id":"balance"}]}]');
  const out2 = validatePlugins(profileDir, null, path.join(dir, 'assets'), jsonYaml, fs);
  assert.strictEqual(out2.ok, false, '纯注册直条目构成跨包冲突');
  assert.ok(out2.conflicts.some((c) => c.id === 'harness-pet'));
  // 定向 insert 的组名 id 不算注册（收集 insert 内 id）
  write(profileDir, 'cordis.patch.yml', '[{"id":"pet-group","insert":[{"id":"balance"}]}]');
  const out3 = validatePlugins(profileDir, null, path.join(dir, 'assets'), jsonYaml, fs);
  assert.strictEqual(out3.ok, true, '定向 insert 组名不算注册');
});

test('issue #99: profile package.json 存在但解析失败 → manifestError + ok:false，不再假绿', () => {
  const dir = tmpdir();
  const profileDir = dir;
  // 清单文件损坏（存在但 JSON 解析失败）—— 修复前这里会静默当空清单处理
  write(profileDir, 'package.json', '{broken json');
  write(dir, 'assets/good-pkg/package.json', JSON.stringify({ name: 'good-pkg', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  write(dir, 'assets/good-pkg/cordis.patch.yml', patchJson([{ id: 'good' }]));
  const out = validatePlugins(profileDir, null, path.join(dir, 'assets'), jsonYaml, fs);
  assert.strictEqual(out.ok, false, 'manifest 损坏必须显式失败，不得静默假绿');
  assert.match(out.manifestError, /无法解析/, '返回结构应带 manifestError 描述');
  assert.ok(out.summary.errors >= 1, 'manifest 损坏必须计入 errors');
  // 对照：健康 manifest → manifestError 为 null，总结论正常
  const healthy = tmpdir();
  write(healthy, 'package.json', '{"name":"p"}');
  const out2 = validatePlugins(healthy, null, null, jsonYaml, fs);
  assert.strictEqual(out2.manifestError, null);
  assert.strictEqual(out2.ok, true);
});

test('issue #99: profile package.json 缺失 = 合法空清单，不误报（与损坏对照）', () => {
  // PR #102 曾主张缺失也判失败；main 取舍为「存在但读不了」才是硬错误
  // （新装 profile 首次启动无清单属正常），此处固化 main 语义。
  const dir = tmpdir();
  const profileDir = dir;
  const assetsDir = path.join(dir, 'assets');
  write(assetsDir, 'good-pkg/package.json', JSON.stringify({ name: 'good-pkg', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  write(assetsDir, 'good-pkg/cordis.patch.yml', patchJson([{ id: 'good' }]));
  const out = validatePlugins(profileDir, null, assetsDir, jsonYaml, fs);
  assert.strictEqual(out.manifestError, null, '缺失不产生 manifestError（ENOENT 静默）');
  assert.strictEqual(out.ok, true, '缺失 = 合法空清单，不判失败');
  assert.ok(out.checked.some((c) => c.name === 'good-pkg'), 'checked 照常执行（清单之外的内置配套照查）');
  assert.ok(out.checked.every((c) => c.listed === false), '无清单时所有 listed 为 false');
});

test('issue #99 补强 B4: dsh.profile.bundles 存在但非数组 → manifestError + ok:false（假绿变体）', () => {
  const dir = tmpdir();
  const profileDir = dir;
  const assetsDir = path.join(dir, 'assets');
  write(assetsDir, 'good-pkg/package.json', JSON.stringify({ name: 'good-pkg', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  write(assetsDir, 'good-pkg/cordis.patch.yml', patchJson([{ id: 'good' }]));
  // 情况一：bundles 字段非数组（结构损坏的合法 JSON）——静默置空会假绿，必须显式报错
  write(profileDir, 'package.json', JSON.stringify({ name: 'p', dsh: { profile: { bundles: 'oops' } } }));
  let out = validatePlugins(profileDir, null, assetsDir, jsonYaml, fs);
  assert.strictEqual(out.ok, false, 'bundles 非数组必须判失败（#99 假绿变体）');
  assert.ok(out.manifestError, 'manifestError 应有信息');
  assert.match(out.manifestError, /bundles 不是数组/);
  // 情况二：字段缺失 → 合法空清单，不误报
  write(profileDir, 'package.json', JSON.stringify({ name: 'p' }));
  out = validatePlugins(profileDir, null, assetsDir, jsonYaml, fs);
  assert.strictEqual(out.manifestError, null, 'bundles 字段缺失 = 合法空清单，不误报');
  assert.strictEqual(out.ok, true);
});
