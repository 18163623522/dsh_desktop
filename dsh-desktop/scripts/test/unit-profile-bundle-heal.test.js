'use strict';

// profile-bundle-heal 单元测试：纯函数（bundlePatchRel / bundleEntryOf /
// verifyBundleDir / packageDirUpward / writeFileAtomic）与两个源码变换
// （app-boot bundle 防护 / app-boot 用户补丁层防护）的幂等性、锚点匹配与语法
// 有效性。变换针对 vendored dsh-app-boot built 文件（只读）；产出写入临时 .mjs
// 用 node --check 验证。
//
// 注意：集成测试（真实启动）会把这些防护实际应用到 node_modules，
// 因此本测试对「文件已注入」与「文件未注入」两种状态都给出有意义断言：
// 未注入 → 变换必须命中锚点并产出合法语法；已注入 → 变换必须识别标记并
// 原样返回（幂等）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  PROFILE_BUNDLE_GUARD_MARKER,
  APP_BOOT_PATCH_LAYER_GUARD_MARKER,
  bundlePatchRel,
  bundleEntryOf,
  verifyBundleDir,
  packageDirUpward,
  scanProfileBundles,
  recoverManifestBundles,
  writeFileAtomic,
  applyAppBootBundleGuard,
  applyAppBootPatchLayerGuard,
} = require('../../profile-bundle-heal');
const { markers } = require('../lib/patch-adapters');

const repoRoot = path.resolve(__dirname, '..', '..');
const appBootFile = path.join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');

// rc.2 换代：0.1.6 及更早的 profile-boot-*.js（homePatchPath / composeLive 形态）
// 装配面已消失，原 applyProfileBootBundleGuard / applyProfileBootHealGuard 连同
// 其 6 条用例一并退役；继任者是 readProfilePatches 层的 applyAppBootPatchLayerGuard
// （注册表 id: profile-patch-layer-guard，order 130），本文件下方为其覆盖。

function syntaxCheck(name, src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbg-unit-'));
  const file = path.join(dir, name + '.mjs');
  fs.writeFileSync(file, src, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function tmpFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbg-fix-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  return dir;
}

test('bundlePatchRel: 只接受非空字符串 patch 声明', () => {
  assert.equal(bundlePatchRel({ dsh: { bundle: { patch: './cordis.patch.yml' } } }), './cordis.patch.yml');
  assert.equal(bundlePatchRel({ dsh: { bundle: { client: './lib/client.js' } } }), '');
  assert.equal(bundlePatchRel({ dsh: { bundle: {} } }), '');
  assert.equal(bundlePatchRel({}), '');
  assert.equal(bundlePatchRel(null), '');
  assert.equal(bundlePatchRel({ dsh: { bundle: { patch: 123 } } }), '');
  assert.equal(bundlePatchRel({ dsh: { bundle: { patch: '' } } }), '');
  assert.equal(bundlePatchRel({ dsh: { bundle: { patch: '   ' } } }), '');
});

test('bundleEntryOf: exports["."] 优先，其次 main', () => {
  assert.equal(bundleEntryOf({ exports: { '.': './dist/index.js' } }), './dist/index.js');
  assert.equal(bundleEntryOf({ exports: { '.': { import: './dist/index.js' } } }), './dist/index.js');
  assert.equal(bundleEntryOf({ exports: { '.': { default: './dist/index.js' } } }), './dist/index.js');
  assert.equal(bundleEntryOf({ exports: { '.': { types: './dist/index.d.ts' } }, main: './dist/index.js' }), '', 'exports["."] 无 import/default 时 Node 无法 import 该包，入口判定为空');
  assert.equal(bundleEntryOf({ exports: ['./dist/index.js'] }), '');
  assert.equal(bundleEntryOf({ main: './lib/index.js' }), './lib/index.js');
  assert.equal(bundleEntryOf({}), '');
  assert.equal(bundleEntryOf(null), '');
});

test('verifyBundleDir: 健康目录通过，缺失/损坏逐项拒绝', () => {
  const ok = tmpFixture({
    'package.json': JSON.stringify({ name: 'x', main: 'dist/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'cordis.patch.yml': '[]\n',
    'dist/index.js': 'export {};\n',
  });
  assert.deepEqual(verifyBundleDir(ok), { ok: true, reason: '' });

  const noPatchFile = tmpFixture({
    'package.json': JSON.stringify({ name: 'x', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  });
  const r1 = verifyBundleDir(noPatchFile);
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /补丁层缺失/);

  const noEntry = tmpFixture({
    'package.json': JSON.stringify({ name: 'x', main: 'dist/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'cordis.patch.yml': '[]\n',
  });
  const r2 = verifyBundleDir(noEntry);
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /入口文件缺失/);

  const noDecl = tmpFixture({
    'package.json': JSON.stringify({ name: 'x', main: 'dist/index.js' }),
  });
  const r3 = verifyBundleDir(noDecl);
  assert.equal(r3.ok, false);
  assert.match(r3.reason, /未声明 dsh\.bundle\.patch/);

  // client bundle 入口（exports["./client"] 声明）：dshmarket 类插件装配时
  // client-modules 按该路径读客户端 bundle，缺失即 MissingClientBundleError。
  const withClient = tmpFixture({
    'package.json': JSON.stringify({ name: 'x', main: 'dist/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } }, exports: { './client': './client/client.js' } }),
    'cordis.patch.yml': '[]\n',
    'dist/index.js': 'export {};\n',
    'client/client.js': 'export {};\n',
  });
  assert.deepEqual(verifyBundleDir(withClient), { ok: true, reason: '' });

  const noClientFile = tmpFixture({
    'package.json': JSON.stringify({ name: 'x', main: 'dist/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } }, exports: { './client': './client/client.js' } }),
    'cordis.patch.yml': '[]\n',
    'dist/index.js': 'export {};\n',
  });
  const r5 = verifyBundleDir(noClientFile);
  assert.equal(r5.ok, false);
  assert.match(r5.reason, /client 入口缺失/);

  const badJson = tmpFixture({ 'package.json': '{"name": "x", BAD' });
  const r4 = verifyBundleDir(badJson);
  assert.equal(r4.ok, false);
  assert.match(r4.reason, /不可读或不是合法 JSON/);
});

test('packageDirUpward: 沿 node_modules 父目录链解析，未找到返回空串', () => {
  const base = tmpFixture({
    'node_modules/@scope/pkg/package.json': '{}',
  });
  assert.equal(packageDirUpward(path.join(base, 'a', 'b', 'c'), '@scope/pkg'), path.join(base, 'node_modules', '@scope', 'pkg'));
  assert.equal(packageDirUpward(path.join(base, 'a'), 'missing-pkg'), '');
});

test('writeFileAtomic: 落盘内容正确且不留 .tmp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbg-wa-'));
  const file = path.join(dir, 'package.json');
  writeFileAtomic(file, '{"a":1}\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n');
  assert.equal(fs.existsSync(file + '.tmp'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanProfileBundles: 只返回可装配的第三方 bundle，排除核心/配套/普通依赖/损坏包', () => {
  const base = tmpFixture({
    'node_modules/@dsh-external/tavily/package.json': JSON.stringify({ name: '@dsh-external/tavily', version: '1.2.3', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'node_modules/@dsh-external/tavily/cordis.patch.yml': '[]\n',
    'node_modules/@dsh-external/tavily/lib/index.js': 'export {};\n',
    'node_modules/@deepseek-ai/dsh-base/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml': '[]\n',
    'node_modules/@deepseek-ai/dsh-base/lib/index.js': 'export {};\n',
    'node_modules/plain-lib/package.json': JSON.stringify({ name: 'plain-lib', version: '1.0.0' }),
    // 声明了 dsh.bundle 但补丁层/入口缺失：不得恢复登记
    'node_modules/broken-bundle/package.json': JSON.stringify({ name: 'broken-bundle', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'node_modules/bad-json/package.json': '{BAD',
  });
  const found = scanProfileBundles(path.join(base, 'node_modules'), new Set(['@deepseek-ai/dsh-base']));
  assert.deepEqual(found, [{ name: '@dsh-external/tavily', version: '1.2.3' }]);
  assert.deepEqual(scanProfileBundles(path.join(base, 'missing'), new Set()), []);
});

test('recoverManifestBundles: 追加缺失登记并补回 dependencies，保留既有顺序与内容', () => {
  const manifest = { name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@dsh-external/tavily'] } } };
  const recovered = recoverManifestBundles(manifest, [
    { name: '@dsh-external/tavily', version: '1.2.3' },
    { name: 'other-bundle', version: '2.0.0' },
  ]);
  assert.deepEqual(recovered, ['other-bundle']);
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@dsh-external/tavily', 'other-bundle']);
  assert.deepEqual(manifest.dependencies, { 'other-bundle': '2.0.0' });

  const m2 = { dsh: { profile: { bundles: [] } }, dependencies: { x: '' } };
  assert.deepEqual(recoverManifestBundles(m2, [{ name: 'x', version: '3.0.0' }]), ['x']);
  assert.deepEqual(m2.dependencies, { x: '3.0.0' });
  assert.deepEqual(m2.dsh.profile.bundles, ['x']);

  const m3 = { dsh: { profile: { bundles: ['a'] } }, dependencies: { a: '^1.0.0' } };
  assert.deepEqual(recoverManifestBundles(m3, [{ name: 'a', version: '9.9.9' }]), []);
  assert.deepEqual(m3.dependencies, { a: '^1.0.0' }, '既有依赖版本不得覆盖');
});

// 变换锚点合成源（必须与 profile-bundle-heal.js 内的锚点字节一致）。
// 0.2.0-rc.2：逐 bundle 的容错上游已原生实装（loadProfileDirectory 内
// `for (const packageName of bundles) try {…} catch { skippedBundles.push(…) }` +
// reportSkippedBundles），原 `bundles.map(...)` 严格装配块随之消失；本守卫只补
// 仍留在 try 之外的两处——profile 自己的 manifest 读取、`dsh.profile.bundles`
// 非数组。合成源按 rc.2 宿主包裹（签名里没有 name 形参，profile 名以
// basename(dir) 派生）。
const SYNTHETIC_APP_MANIFEST = '\tnormalizeShippedProfile(name, dir, readProfileManifest(binName, dir));';
const SYNTHETIC_APP_BUNDLES = '\tconst bundles = readProfileManifest(binName, dir).dsh?.profile?.bundles ?? [];';
const SYNTHETIC_APP_INSERT = 'function composeEntries(layers, warn = () => {}) {';

test('applyAppBootBundleGuard: 合成源命中锚点并替换', () => {
  const src = [
    'export const x = 1;',
    'function loadProfileDirectory(binName, dir, installAnchor, options = {}) {',
    SYNTHETIC_APP_MANIFEST,
    SYNTHETIC_APP_BUNDLES,
    '\treturn { name: basename(dir), dir, bundles };',
    '}',
    SYNTHETIC_APP_INSERT,
    '\treturn null;',
    '}',
  ].join('\n');
  const out = applyAppBootBundleGuard(src);
  assert.equal(out.changed, true, 'rc.2 两处严格读取锚点应命中');
  assert.ok(out.src.includes(PROFILE_BUNDLE_GUARD_MARKER), '应写入幂等标记');
  assert.ok(out.src.includes('function loadProfileManifestSafe(binName, name, dir)'), '应注入 manifest 自愈读取');
  assert.ok(out.src.includes('function loadProfileBundlesSafe(binName, name, dir)'), '应注入 bundles 非数组降级');
  assert.ok(out.src.includes('\tnormalizeShippedProfile(name, dir, loadProfileManifestSafe(binName, name, dir));'),
    'manifest 调用点应替换');
  assert.ok(out.src.includes('\tconst bundles = loadProfileBundlesSafe(binName, basename(dir), dir);'),
    'bundles 调用点应替换（宿主作用域无 name 形参，以 basename(dir) 派生）');
  assert.ok(!out.src.includes('= loadProfileBundlesSafe(binName, name,'),
    'bundles 调用点不得引用裸 name（loadProfileDirectory 作用域内未定义，会抛 ReferenceError）');
  assert.ok(!out.src.includes(SYNTHETIC_APP_BUNDLES), '严格 bundles 读取应整体移除');
  syntaxCheck('app-boot-synthetic', out.src);
  const again = applyAppBootBundleGuard(out.src);
  assert.equal(again.changed, false, '二次应用应为幂等空操作');
  assert.equal(again.src, out.src);
});

test('applyAppBootBundleGuard: 锚点缺失时原样返回', () => {
  assert.deepEqual(applyAppBootBundleGuard('export const x = 1;\n' + SYNTHETIC_APP_INSERT + '\n}'),
    { changed: false, src: 'export const x = 1;\n' + SYNTHETIC_APP_INSERT + '\n}' },
    '两个读取锚点全缺时必须零改写');
  // 反证：只缺其一（manifest 在、bundles 被上游改写）同样不得半写——否则会留下
  // 「manifest 已自愈、bundles 仍严格」的混合状态，用户看到的仍是启动失败页。
  const halfMissing = 'function loadProfileDirectory(binName, dir) {\n' + SYNTHETIC_APP_MANIFEST + '\n}';
  assert.deepEqual(applyAppBootBundleGuard(halfMissing), { changed: false, src: halfMissing });
  const insertMissing = 'function loadProfileDirectory(binName, dir) {\n'
    + SYNTHETIC_APP_MANIFEST + '\n' + SYNTHETIC_APP_BUNDLES + '\n}';
  assert.deepEqual(applyAppBootBundleGuard(insertMissing), { changed: false, src: insertMissing });
  assert.deepEqual(applyAppBootBundleGuard(''), { changed: false, src: '' });
  assert.deepEqual(applyAppBootBundleGuard(null), { changed: false, src: null });
});

test('applyAppBootBundleGuard: 真实 vendored 文件（两种状态均成立）', () => {
  const src = fs.readFileSync(appBootFile, 'utf8');
  const out = applyAppBootBundleGuard(src);
  if (src.includes(PROFILE_BUNDLE_GUARD_MARKER)) {
    // 已被集成测试应用过：必须识别标记并不再改写。
    assert.equal(out.changed, false);
    assert.equal(out.src, src);
  } else {
    // 未被应用：必须命中锚点、产出合法 ESM 且二次应用幂等。
    assert.equal(out.changed, true, 'vendored app-boot 锚点应命中（dsh 版本变更时需同步更新锚点）');
    assert.ok(out.src.includes('function loadProfileLayers'));
    syntaxCheck('app-boot', out.src);
    assert.equal(applyAppBootBundleGuard(out.src).changed, false);
  }
});

// ---------------------------------------------------------------------------
// applyAppBootPatchLayerGuard（rc.2 继任 profile-boot 半边的补丁层防护）
// ---------------------------------------------------------------------------

// rc.2 dsh-app-boot/lib/index.js 的三处锚点（实测各 hits=1），逐字照抄。
const PL_USER = '\t\t...initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? [],';
const PL_HOME = '\t\t...loadOptionalPatches(binName, join(context.home, "cordis.patch.yml")) ?? [],';
const PL_INSERT = 'function readProfilePatches(binName, context, initialProfile) {';

function patchLayerFixture() {
  return [
    'async function composeProfile(context, initialProfile) {',
    '\treturn {',
    PL_USER,
    PL_HOME,
    '\t};',
    '}',
    PL_INSERT,
    '\treturn loadOptionalPatches(binName, context.patchPath) ?? [];',
    '}',
  ].join('\n');
}

test('applyAppBootPatchLayerGuard: 合成源命中三锚点并替换两处严格读取', () => {
  const src = patchLayerFixture();
  const out = applyAppBootPatchLayerGuard(src);
  assert.equal(out.changed, true, '三锚点齐备时必须命中');
  assert.ok(out.src.includes(APP_BOOT_PATCH_LAYER_GUARD_MARKER), '应注入 safeLoadUserPatchLayer');
  assert.ok(out.src.includes('\t\t...initialProfile?.patches ?? safeLoadUserPatchLayer(binName, context.patchPath),'),
    'profile 层调用点应换成自愈读取');
  assert.ok(out.src.includes('\t\t...safeLoadUserPatchLayer(binName, join(context.home, "cordis.patch.yml")),'),
    '家级层调用点应换成自愈读取');
  assert.ok(!out.src.includes(PL_USER), 'profile 层的严格 ?? [] 形态应被移除');
  assert.ok(!out.src.includes(PL_HOME), '家级层的严格 ?? [] 形态应被移除');
  assert.ok(out.src.includes(PL_INSERT), 'readProfilePatches 定义行应原样保留');
  syntaxCheck('patch-layer', out.src);
  assert.equal(applyAppBootPatchLayerGuard(out.src).changed, false, '二次应用应为幂等空操作');
});

test('applyAppBootPatchLayerGuard: 三锚点逐一缺失都原样返回（反证判据起作用）', () => {
  assert.deepEqual(applyAppBootPatchLayerGuard(null), { changed: false, src: null });
  assert.deepEqual(applyAppBootPatchLayerGuard(''), { changed: false, src: '' });
  // 每条锚点各自挖掉：任一失配都必须整体不动，绝不留下「半自愈」的混合读取。
  for (const anchor of [PL_USER, PL_HOME, PL_INSERT]) {
    const missing = patchLayerFixture().replace(anchor, '/* ANCHOR-REMOVED */');
    const out = applyAppBootPatchLayerGuard(missing);
    assert.deepEqual(out, { changed: false, src: missing }, `锚点 ${anchor.trim().slice(0, 40)} 缺失时不得改写`);
  }
  // 已注入过（marker 命中）时同样零改写。
  const once = applyAppBootPatchLayerGuard(patchLayerFixture()).src;
  assert.deepEqual(applyAppBootPatchLayerGuard(once), { changed: false, src: once });
});

test('applyAppBootPatchLayerGuard: 与补丁层另一处防护的标记互不为子串', () => {
  // 两条防护都插在「读用户补丁层」附近；marker 互相包含会让先应用的那条把后一条
  // 判成 already，第二层防护静默消失（profile-boot 时代踩过的名字约束）。
  const other = markers.PROFILE_PATCH_GUARD_MARKER;
  assert.ok(other && APP_BOOT_PATCH_LAYER_GUARD_MARKER.includes('safeLoadUserPatchLayer'));
  assert.ok(!APP_BOOT_PATCH_LAYER_GUARD_MARKER.includes(other), '两 marker 不得互相包含');
  assert.ok(!other.includes(APP_BOOT_PATCH_LAYER_GUARD_MARKER), '两 marker 不得互相包含');
});

test('applyAppBootPatchLayerGuard: 真实 vendored 文件（两种状态均成立）', () => {
  const src = fs.readFileSync(appBootFile, 'utf8');
  const out = applyAppBootPatchLayerGuard(src);
  if (src.includes(APP_BOOT_PATCH_LAYER_GUARD_MARKER)) {
    assert.equal(out.changed, false);
    assert.equal(out.src, src);
  } else {
    assert.equal(out.changed, true, 'vendored app-boot 补丁层锚点应命中（dsh 版本变更时需同步更新锚点）');
    syntaxCheck('patch-layer-real', out.src);
    assert.equal(applyAppBootPatchLayerGuard(out.src).changed, false);
  }
});
