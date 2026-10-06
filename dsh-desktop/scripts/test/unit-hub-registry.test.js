'use strict';

// 单测：scripts/lib/hub-registry.js —— DSH Hotplug Hub（ARFCON/dsh-hotplug-hub）
// 识别适配层。四层验证：
//   1. 适配层自身语义（issue #156 止血：v0.5.3 dependencies 脏数据幂等清理 /
//      不误删用户自装 / hotpack 指针 / 幂等 / 卸载联动 / 元数据校验）；
//   2. 断言级「hub 识别复现」：按 hub 源码（lib/core/state.js listPackIds/
//      readPackManifest、lib/core/status.js statusSync、lib/core/ensure.js
//      ensurePath、packages/shared-core/format/hotpack.js parseHotpack、
//      release/src/Main.cs GetPluginsJson）的扫描与校验逻辑复刻，喂我方布局，
//      断言内置件全部被识别；
//   3. 识别面取舍断言：内置件不再进 profile dependencies（issue #156 毒化
//      pnpm 的写入面已废除）——桌面端 GetPluginsJson 列表仅剩用户自装件；
//   4. 仓库级元数据收口断言：真实 assets/plugins 的 34 个配套件全部通过
//      校验环节（防 dsh-vision 式 version 漂移回归）。
// 运行：node --test scripts/test/unit-hub-registry.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  HUB_PACK_ID,
  HUB_PLUGIN_ID_RE,
  HUB_EXACT_VERSION_RE,
  inspectCompanionMeta,
  validateCompanionMetadata,
  collectRegistrablePlugins,
  cleanLegacyProfileDependencies,
  buildHotpackPointer,
  syncHotplugPackPointer,
  syncHubRecognition,
} = require('../lib/hub-registry');
const { COMPANION_PLUGINS, companionDirName, RETIRED_COMPANION_DIRS } = require('../lib/companion-plugins');
const { syncCompanionFiles } = require('../lib/companion-profile');

// ---------------------------------------------------------------------------
// hub 契约规则的测试侧复刻（与 hub packages/shared-core 同源；测试不依赖
// hub 仓库，规则变更时以 hub shared-core 为准同步这里）
// ---------------------------------------------------------------------------
const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PLUGIN_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** hub lib/core/state.js listPackIds + readPackManifest 复刻。 */
function hubListPacks(home) {
  const packsDir = path.join(home, 'hotplug-hub', 'packs');
  let entries;
  try { entries = fs.readdirSync(packsDir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && PACK_ID_RE.test(e.name))
    .map((e) => e.name)
    .sort()
    .map((id) => ({ id, manifest: JSON.parse(fs.readFileSync(path.join(packsDir, id, 'hotpack.json'), 'utf8')) }));
}

/** hub lib/core/status.js statusSync 的插件行复刻（present/cached 判定）。 */
function hubStatusPluginRows(home, pack) {
  return (pack.manifest.plugins ?? []).map((entry) => {
    const dir = entry.source.type === 'path' ? entry.source.path
      : path.join(home, 'hotplug-store', `${entry.name}@${entry.source.ref}`);
    const present = fs.existsSync(path.join(dir, 'package.json'));
    return {
      id: entry.id,
      name: entry.name,
      version: entry.version ?? null,
      source: entry.source.type,
      path: dir,
      cached: entry.source.type === 'npm' ? null : present,
    };
  });
}

/** hub lib/core/ensure.js ensurePath 判定复刻（activate 时的 reused 条件）。 */
function hubEnsurePathOk(entry) {
  const dir = entry.source.path;
  if (!fs.existsSync(path.join(dir, 'package.json'))) return false;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  return meta.name === entry.name;
}

/** hub parseHotpack（format/hotpack.js）必检项复刻：形状不合法即 import 失败。 */
function hubParseHotpackShape(pack) {
  assert.strictEqual(pack.hotpack, '1.0', 'hotpack 版本必须是 1.0');
  assert.ok(PACK_ID_RE.test(pack.id), 'pack id 须过 PACK_ID_RE');
  assert.ok(typeof pack.name === 'string' && pack.name.trim(), 'name 必填');
  assert.ok(HUB_EXACT_VERSION_RE.test(pack.version), 'version 须为精确 semver');
  assert.ok(Array.isArray(pack.plugins) && pack.plugins.length > 0, 'plugins 必须非空');
  assert.strictEqual(pack.description.length <= 300, true, 'description ≤300');
  const seenIds = new Set();
  const seenNames = new Set();
  for (const p of pack.plugins) {
    assert.ok(HUB_PLUGIN_ID_RE.test(p.id), '插件 id 须过 hub 规则: ' + p.id);
    assert.ok(PLUGIN_NAME_RE.test(p.name), '插件 name 须为合法 npm 包名: ' + p.name);
    const idKey = p.id.toLowerCase();
    assert.ok(!seenIds.has(idKey), '插件 id 重复: ' + p.id);
    seenIds.add(idKey);
    const nameKey = p.name.toLowerCase();
    assert.ok(!seenNames.has(nameKey), '插件 name 重复: ' + p.name);
    seenNames.add(nameKey);
    assert.strictEqual(p.source.type, 'path');
    const src = p.source.path;
    assert.ok(path.isAbsolute(src) || /^[a-zA-Z]:[\\/]/.test(src), 'source.path 须绝对路径');
    assert.ok(!/^\\\\|^\/\//.test(src), 'source.path 不得为 UNC');
    for (const seg of src.split(/[\\/]/)) {
      assert.ok(seg !== '..' && seg !== '.', 'source.path 不得含 ../ 段');
    }
  }
  return true;
}

/** hub 桌面端 GetPluginsJson（Main.cs）复刻：dependencies 键 → 插件行。 */
function hubDesktopPluginList(profileDir) {
  const root = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  const deps = root.dependencies ?? {};
  return Object.keys(deps).map((name) => {
    const pkgFile = path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json');
    let version = null;
    try { version = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version ?? null; } catch { /* 同 hub：读不到按未安装 */ }
    return { name, spec: deps[name], version };
  });
}

// ---------------------------------------------------------------------------
// fixture：临时 home + 两个假配套件（一个 bundle / 一个普通），走真实
// syncCompanionFiles 落位后跑适配层
// ---------------------------------------------------------------------------

function writePluginDir(root, name, version, extra = {}) {
  const dir = path.join(root, companionDirName({ name }));
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  const pkg = { name, version, description: '测试配套件 ' + name, private: true, main: './lib/index.js' };
  if (extra.dsh) pkg.dsh = extra.dsh;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), `'use strict';\nmodule.exports = {};\n`);
  if (extra.dsh) {
    // bundle 插件：dsh.bundle.patch 指向包内 cordis.patch.yml（verifyBundleDir 要求）
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert:\n    - id: ' + extra.loaderId + '\n      name: ' + JSON.stringify(name) + '\n');
  }
  if (extra.pluginMeta) {
    fs.writeFileSync(path.join(dir, 'dsh.plugin.json'), JSON.stringify(extra.pluginMeta, null, 2));
  }
  return dir;
}

function buildFixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-reg-'));
  const assetsRoot = path.join(home, 'assets-plugins');
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  writePluginDir(assetsRoot, '@deepseek-ai/dsh-fixture-beta', '1.2.3');
  writePluginDir(assetsRoot, 'dsh-fixture-bundle', '0.4.5', {
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    loaderId: 'fixture-bundle',
  });
  // profile manifest：dsh 首启初始化后的形态（核心 bundles + bundle 登记）。
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-fixture-bundle'] } },
  }, null, 2) + '\n');
  // 用户自装的第三方插件（不在配套清单内）：dependencies 里必须原样保留。
  const userDeps = { 'some-user-plugin': '^2.0.0' };
  const manifestFile = path.join(profileDir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.dependencies = userDeps;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  return { home, assetsRoot, profileDir, plugins: [
    { id: 'fixture-beta', name: '@deepseek-ai/dsh-fixture-beta' },
    { id: 'fixture-bundle', name: 'dsh-fixture-bundle' },
  ] };
}

function installFixturePlugins(assetsRoot, profileDir, plugins, removedIds = new Set()) {
  return syncCompanionFiles({
    assetsRoot,
    profileDir,
    plugins,
    vendorRoot: path.join(assetsRoot, 'no-vendor'),
    removedIds,
    log: () => {},
    fail: () => {},
  });
}

/** 向 profile manifest 写入 dependencies（模拟 v0.5.3 落盘 / 用户自装形态）。 */
function seedDependencies(profileDir, deps) {
  const manifestFile = path.join(profileDir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.dependencies = { ...(manifest.dependencies || {}), ...deps };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
}

function readManifest(profileDir) {
  return JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
}

// ---------------------------------------------------------------------------
// 适配层语义：syncHubRecognition（编排面）
// ---------------------------------------------------------------------------

test('syncHubRecognition: 只写 hotpack 指针包；清掉 v0.5.3 脏数据；二次运行零写入', () => {
  const { home, assetsRoot, profileDir, plugins } = buildFixtureHome();
  installFixturePlugins(assetsRoot, profileDir, plugins);
  // 模拟 v0.5.3（6070d5ab）在用户机器上写下的脏 dependencies（精确版本）。
  seedDependencies(profileDir, {
    '@deepseek-ai/dsh-fixture-beta': '1.2.3',
    'dsh-fixture-bundle': '0.4.5',
  });
  const logs = [];
  const r1 = syncHubRecognition({
    home, profileDir, assetsRoot, plugins,
    desktopVersion: '0.5.2',
    log: (m) => logs.push(m),
  });
  assert.strictEqual(r1.registrable, 2, '两个配套件都应可登记（hotpack 指针面）');
  assert.deepStrictEqual(r1.deps.removed.sort(), ['@deepseek-ai/dsh-fixture-beta', 'dsh-fixture-bundle'],
    'v0.5.3 写入的 dependencies 脏数据必须被清除');
  assert.strictEqual(r1.deps.skipped, false);
  assert.strictEqual(r1.pack.written, true);

  // dependencies：脏数据已清、用户自装条目保留、绝不新增任何内置件登记
  const manifest = readManifest(profileDir);
  assert.deepStrictEqual(manifest.dependencies, { 'some-user-plugin': '^2.0.0' },
    '清理后 dependencies 只剩用户自装条目');
  // bundles 登记不受影响
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-fixture-bundle'));

  // hotpack 指针
  const packFile = path.join(home, 'hotplug-hub', 'packs', HUB_PACK_ID, 'hotpack.json');
  assert.ok(fs.existsSync(packFile));
  const pack = JSON.parse(fs.readFileSync(packFile, 'utf8'));
  assert.strictEqual(pack.id, HUB_PACK_ID);
  assert.strictEqual(pack.plugins.length, 2);

  // 幂等：内容一致零写入（mtime 不变），脏数据清后不再有任何 dependencies 动作
  const statBefore = fs.statSync(packFile);
  const manifestBefore = fs.statSync(path.join(profileDir, 'package.json'));
  const r2 = syncHubRecognition({ home, profileDir, assetsRoot, plugins, desktopVersion: '0.5.2', log: () => {} });
  assert.deepStrictEqual(r2.deps.removed, []);
  assert.strictEqual(r2.pack.written, false);
  assert.strictEqual(fs.statSync(packFile).mtimeMs, statBefore.mtimeMs, '指针包不得重写（健康零写入）');
  assert.strictEqual(fs.statSync(path.join(profileDir, 'package.json')).mtimeMs, manifestBefore.mtimeMs,
    'manifest 无变化不得重写（健康零写入）');
});

test('syncHubRecognition: 卸载标记联动——指针包剔除（dependencies 面已废除）', () => {
  const { home, assetsRoot, profileDir, plugins } = buildFixtureHome();
  installFixturePlugins(assetsRoot, profileDir, plugins);
  syncHubRecognition({ home, profileDir, assetsRoot, plugins, desktopVersion: '0.5.2', log: () => {} });

  const removedIds = new Set(['fixture-bundle']);
  installFixturePlugins(assetsRoot, profileDir, plugins, removedIds); // 卸载后不同步文件
  const r = syncHubRecognition({ home, profileDir, assetsRoot, plugins, removedIds, desktopVersion: '0.5.2', log: () => {} });
  assert.strictEqual(r.registrable, 1, '卸载件不得再登记');
  assert.deepStrictEqual(r.deps.removed, [], 'dependencies 面已废除：本就无登记可撤');

  const manifest = readManifest(profileDir);
  assert.deepStrictEqual(manifest.dependencies, { 'some-user-plugin': '^2.0.0' });

  const pack = JSON.parse(fs.readFileSync(path.join(home, 'hotplug-hub', 'packs', HUB_PACK_ID, 'hotpack.json'), 'utf8'));
  assert.strictEqual(pack.plugins.length, 1);
  assert.strictEqual(pack.plugins[0].name, '@deepseek-ai/dsh-fixture-beta');
});

// ---------------------------------------------------------------------------
// 适配层语义：cleanLegacyProfileDependencies（issue #156 止血核心）
// ---------------------------------------------------------------------------

test('cleanLegacyProfileDependencies: v0.5.3 脏数据（安装包版本）清除且幂等', () => {
  const { assetsRoot, profileDir, plugins } = buildFixtureHome();
  installFixturePlugins(assetsRoot, profileDir, plugins);
  seedDependencies(profileDir, {
    '@deepseek-ai/dsh-fixture-beta': '1.2.3', // = assets 版本 = node_modules 版本（正常脏数据位形）
    'dsh-fixture-bundle': '0.4.5',
    'some-user-plugin': '^2.0.0',
  });
  const r1 = cleanLegacyProfileDependencies({ profileDir, plugins, assetsRoot, log: () => {} });
  assert.deepStrictEqual(r1.removed.sort(), ['@deepseek-ai/dsh-fixture-beta', 'dsh-fixture-bundle']);
  assert.deepStrictEqual(readManifest(profileDir).dependencies, { 'some-user-plugin': '^2.0.0' });

  // 幂等：清干净后二次运行零写入（mtime 不变）
  const statBefore = fs.statSync(path.join(profileDir, 'package.json'));
  const r2 = cleanLegacyProfileDependencies({ profileDir, plugins, assetsRoot, log: () => {} });
  assert.deepStrictEqual(r2.removed, []);
  assert.strictEqual(fs.statSync(path.join(profileDir, 'package.json')).mtimeMs, statBefore.mtimeMs);
});

test('cleanLegacyProfileDependencies: 版本漂移脏数据（条目=旧版本）也清除', () => {
  const { assetsRoot, profileDir, plugins } = buildFixtureHome();
  installFixturePlugins(assetsRoot, profileDir, plugins);
  // 升级漂移位形：v0.5.3 写下旧版本，修复版已把 assets/node_modules 升到 9.9.9。
  // 条目值 ≠ 安装包版本 ≠ 已装版本 —— 不清则非 npm 包名照旧 404 锁死。
  seedDependencies(profileDir, { 'dsh-fixture-bundle': '0.1.0' });
  const r = cleanLegacyProfileDependencies({ profileDir, plugins, assetsRoot, log: () => {} });
  assert.deepStrictEqual(r.removed, ['dsh-fixture-bundle']);
  assert.strictEqual(readManifest(profileDir).dependencies['dsh-fixture-bundle'], undefined);
});

test('cleanLegacyProfileDependencies: 插件中心 npm 更新的配套件条目保留（不误删用户安装）', () => {
  const { assetsRoot, profileDir, plugins } = buildFixtureHome();
  installFixturePlugins(assetsRoot, profileDir, plugins);
  // keep-newer 位形：用户经插件中心把 billion-context-dsh 风格的配套件更到 2.0.0
  //（companion-profile 保留更新版本），dependencies 条目是用户自己的安装记录。
  const installed = path.join(profileDir, 'node_modules', 'dsh-fixture-bundle', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(installed, 'utf8'));
  pkg.version = '2.0.0';
  fs.writeFileSync(installed, JSON.stringify(pkg, null, 2));
  seedDependencies(profileDir, {
    'dsh-fixture-bundle': '2.0.0', // = 已装版本 ≠ assets 版本（0.4.5）→ 用户更新位形
    '@deepseek-ai/dsh-fixture-beta': '1.2.3', // 正常脏数据 → 清
  });
  const r = cleanLegacyProfileDependencies({ profileDir, plugins, assetsRoot, log: () => {} });
  assert.deepStrictEqual(r.removed, ['@deepseek-ai/dsh-fixture-beta'], '更新位形条目绝不能删');
  const deps = readManifest(profileDir).dependencies;
  assert.strictEqual(deps['dsh-fixture-bundle'], '2.0.0');
});

test('cleanLegacyProfileDependencies: 用户自装条目一律不动（非配套名 / 范围 / file: 形状）', () => {
  const { assetsRoot, profileDir, plugins } = buildFixtureHome();
  installFixturePlugins(assetsRoot, profileDir, plugins);
  seedDependencies(profileDir, {
    'some-user-plugin': '^2.0.0',                       // 非配套名
    'lodash.get': '4.4.2',                               // 非配套名（精确版本也不动）
    '@deepseek-ai/dsh-fixture-beta': '^1.2.3',           // 配套名 + 范围 spec（非旧写入器形状）
    'dsh-fixture-bundle': 'file:../somewhere',           // 配套名 + file: spec
    '@deepseek-ai/dsh-web-app': 'workspace:*',           // 核心包名（不在配套清单）
  });
  const r = cleanLegacyProfileDependencies({ profileDir, plugins, assetsRoot, log: () => {} });
  assert.deepStrictEqual(r.removed, [], '用户自装/异形条目绝不能删');
  const deps = readManifest(profileDir).dependencies;
  assert.strictEqual(deps['some-user-plugin'], '^2.0.0');
  assert.strictEqual(deps['lodash.get'], '4.4.2');
  assert.strictEqual(deps['@deepseek-ai/dsh-fixture-beta'], '^1.2.3');
  assert.strictEqual(deps['dsh-fixture-bundle'], 'file:../somewhere');
  assert.strictEqual(deps['@deepseek-ai/dsh-web-app'], 'workspace:*');
});

test('cleanLegacyProfileDependencies: 落位文件缺失的脏条目清除（与旧写入器撤下语义一致）', () => {
  const { assetsRoot, profileDir, plugins } = buildFixtureHome();
  installFixturePlugins(assetsRoot, profileDir, plugins);
  fs.rmSync(path.join(profileDir, 'node_modules', 'dsh-fixture-bundle'), { recursive: true, force: true });
  seedDependencies(profileDir, { 'dsh-fixture-bundle': '0.4.5' });
  const r = cleanLegacyProfileDependencies({ profileDir, plugins, assetsRoot, log: () => {} });
  assert.deepStrictEqual(r.removed, ['dsh-fixture-bundle']);
});

test('cleanLegacyProfileDependencies: assets 缺源时退化为保守判定（条目=已装版本即保留）', () => {
  const { profileDir, plugins } = buildFixtureHome();
  const assetsRoot = path.join(profileDir, 'no-such-assets');
  // 无 assets 指纹可对照：条目与已装版本一致 → 无法证明是脏数据 → 保留。
  const r = cleanLegacyProfileDependencies({ profileDir, plugins, assetsRoot, log: () => {} });
  assert.deepStrictEqual(r.removed, []);
});

test('cleanLegacyProfileDependencies: dry-run 只计算不落盘', () => {
  const { assetsRoot, profileDir, plugins } = buildFixtureHome();
  installFixturePlugins(assetsRoot, profileDir, plugins);
  seedDependencies(profileDir, { 'dsh-fixture-bundle': '0.4.5' });
  const before = fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8');
  const logs = [];
  const r = cleanLegacyProfileDependencies({ profileDir, plugins, assetsRoot, dryRun: true, log: (m) => logs.push(m) });
  assert.deepStrictEqual(r.removed, ['dsh-fixture-bundle'], 'dry-run 也要报告将清理的条目');
  assert.ok(logs.some((m) => m.includes('dry-run')), 'dry-run 计划须进日志');
  assert.strictEqual(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'), before, 'dry-run 绝不落盘');
});

test('cleanLegacyProfileDependencies: 清空后 dependencies 键整体移除（不留空对象）', () => {
  const { assetsRoot, profileDir, plugins } = buildFixtureHome();
  installFixturePlugins(assetsRoot, profileDir, plugins);
  const manifestFile = path.join(profileDir, 'package.json');
  const manifest = readManifest(profileDir);
  manifest.dependencies = { 'dsh-fixture-bundle': '0.4.5' }; // 只有脏数据，无用户条目
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  const r = cleanLegacyProfileDependencies({ profileDir, plugins, assetsRoot, log: () => {} });
  assert.deepStrictEqual(r.removed, ['dsh-fixture-bundle']);
  assert.strictEqual(readManifest(profileDir).dependencies, undefined, '空 dependencies 对象应删除（同 removeRetiredDshMarketDir 先例）');
});

test('cleanLegacyProfileDependencies: manifest 未初始化时跳过且不创建文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-reg-noinit-'));
  const out = cleanLegacyProfileDependencies({
    profileDir: dir,
    plugins: [{ id: 'a', name: 'a' }],
    log: () => {},
  });
  assert.strictEqual(out.skipped, true);
  assert.strictEqual(fs.existsSync(path.join(dir, 'package.json')), false, '绝不凭空创建 manifest');
});

test('cleanLegacyProfileDependencies: 无 dependencies / 无可清条目零写入', () => {
  const { assetsRoot, profileDir, plugins } = buildFixtureHome();
  installFixturePlugins(assetsRoot, profileDir, plugins);
  const manifestFile = path.join(profileDir, 'package.json');
  const statBefore = fs.statSync(manifestFile);
  const r = cleanLegacyProfileDependencies({ profileDir, plugins, assetsRoot, log: () => {} });
  assert.deepStrictEqual(r.removed, []);
  assert.strictEqual(fs.statSync(manifestFile).mtimeMs, statBefore.mtimeMs, '无可清条目不得重写 manifest');
});

// ---------------------------------------------------------------------------
// 适配层语义：登记集合与指针包（识别面②）
// ---------------------------------------------------------------------------

test('collectRegistrablePlugins: 包名漂移/版本缺失的落位目录被拒', () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-reg-badmeta-'));
  const mk = (rel, pkg) => {
    const dir = path.join(profileDir, 'node_modules', rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  };
  mk('bad-name', { name: 'wrong-name', version: '1.0.0', description: 'x' });
  mk('bad-version', { name: 'bad-version', description: 'x' });
  mk(path.join('@s', 'good'), { name: '@s/good', version: '2.0.0', description: 'x' });
  const rows = collectRegistrablePlugins({
    profileDir,
    plugins: [
      { id: 'bad-name', name: 'bad-name' },
      { id: 'bad-version', name: 'bad-version' },
      { id: 'good', name: '@s/good' },
    ],
    log: () => {},
  });
  assert.deepStrictEqual(rows.map((r) => r.name), ['@s/good']);
});

test('inspectCompanionMeta: dsh.plugin.json version 漂移被检出（dsh-vision 回归）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-reg-dpj-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '0.2.1', description: 'd' }));
  fs.writeFileSync(path.join(dir, 'dsh.plugin.json'), JSON.stringify({ id: 'p', version: '0.1.0' }));
  const bad = inspectCompanionMeta(dir, { id: 'p', name: 'p' });
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.reasons.some((r) => r.includes('dsh.plugin.json version')), '必须报出 dpj 版本漂移');
  fs.writeFileSync(path.join(dir, 'dsh.plugin.json'), JSON.stringify({ id: 'p', version: '0.2.1' }));
  assert.strictEqual(inspectCompanionMeta(dir, { id: 'p', name: 'p' }).ok, true);
});

test('syncHotplugPackPointer: UNC profile 跳过指针包（hub validateSourcePath 拒绝 UNC）', () => {
  const out = syncHotplugPackPointer({
    home: 'C:/fake-home',
    profileDir: '\\\\wsl$\\Ubuntu\\home\\u\\.dsh\\profiles\\web',
    desktopVersion: '0.5.2',
    registrable: [{ id: 'a', name: 'a', version: '1.0.0' }],
    log: () => {},
  });
  assert.strictEqual(out.skipped, true);
  assert.strictEqual(out.written, false);
});

test('buildHotpackPointer: 空集合返回 null；windows 路径归一为正斜杠', () => {
  assert.strictEqual(buildHotpackPointer({ profileDir: 'C:/x', desktopVersion: '0.5.2', registrable: [] }), null);
  const pack = buildHotpackPointer({
    profileDir: 'C:\\Users\\u\\.dsh\\profiles\\web',
    desktopVersion: '0.5.2',
    registrable: [{ id: 'a', name: '@s/a', version: '1.0.0' }],
  });
  assert.strictEqual(pack.plugins[0].source.path.includes('\\'), false, '指针路径须正斜杠（JSON 可移植）');
  assert.strictEqual(pack.plugins[0].source.path, 'C:/Users/u/.dsh/profiles/web/node_modules/@s/a');
});

// ---------------------------------------------------------------------------
// 断言级 hub 识别复现：hub 的扫描函数喂我方布局
// ---------------------------------------------------------------------------

test('hub 识别复现：lib statusSync 把指针包插件全部判 cached，ensurePath 全 reused', () => {
  const { home, assetsRoot, profileDir, plugins } = buildFixtureHome();
  installFixturePlugins(assetsRoot, profileDir, plugins);
  syncHubRecognition({ home, profileDir, assetsRoot, plugins, desktopVersion: '0.5.2', log: () => {} });

  const packs = hubListPacks(home);
  assert.strictEqual(packs.length, 1, 'packs 目录应恰好识别出内置指针包');
  const pack = packs[0];
  assert.strictEqual(pack.id, HUB_PACK_ID);
  assert.strictEqual(hubParseHotpackShape(pack.manifest), true, '指针包必须能过 hub parseHotpack 形状校验');

  const rows = hubStatusPluginRows(home, pack);
  assert.strictEqual(rows.length, 2);
  for (const row of rows) {
    assert.strictEqual(row.cached, true, 'statusSync 必须判 cached: ' + row.name);
    assert.ok(row.version !== null, '插件版本供 hub 展示');
    assert.strictEqual(hubEnsurePathOk({ name: row.name, source: { path: row.path } }), true,
      'ensurePath（activate 时的 reused 判定）必须通过: ' + row.name);
  }
});

test('hub 识别复现：桌面端 GetPluginsJson 只列用户自装件——内置件不进 dependencies（issue #156 取舍）', () => {
  const { home, assetsRoot, profileDir, plugins } = buildFixtureHome();
  installFixturePlugins(assetsRoot, profileDir, plugins);
  // 预埋 v0.5.3 脏数据 + 用户自装，同步后：脏数据清除、用户条目在列。
  seedDependencies(profileDir, { 'dsh-fixture-bundle': '0.4.5' });
  syncHubRecognition({ home, profileDir, assetsRoot, plugins, desktopVersion: '0.5.2', log: () => {} });

  const rows = hubDesktopPluginList(profileDir);
  const byName = new Map(rows.map((r) => [r.name, r]));
  for (const p of plugins) {
    assert.strictEqual(byName.has(p.name), false,
      '内置件不得再出现在 dependencies（识别面①的取舍，见模块头注释）: ' + p.name);
  }
  assert.ok(byName.has('some-user-plugin'), '用户自装插件仍在列');
  const user = byName.get('some-user-plugin');
  assert.strictEqual(user.spec, '^2.0.0');
});

// ---------------------------------------------------------------------------
// 仓库级收口断言：真实 assets/plugins 全量元数据校验
// ---------------------------------------------------------------------------

test('收口：真实 assets/plugins 全部配套件元数据校验通过（防漂移回归）', () => {
  const assetsRoot = path.join(__dirname, '..', '..', 'assets', 'plugins');
  const out = validateCompanionMetadata({ assetsRoot, plugins: COMPANION_PLUGINS, log: () => {} });
  assert.strictEqual(out.checked, COMPANION_PLUGINS.length);
  assert.deepStrictEqual(out.bad, [], '元数据漂移：' + JSON.stringify(out.bad, null, 2));
  const onDisk = new Set(fs.readdirSync(assetsRoot).filter((n) => {
    try { return fs.statSync(path.join(assetsRoot, n)).isDirectory(); } catch { return false; }
  }));
  // 清单 ↔ assets 目录一一对应（多目录/漏登记都算漂移）。RETIRED_COMPANION_DIRS
  // 是唯一豁免面：退役伴随件的源目录按用户要求保留（源级用例仍读），但绝不进清单。
  const listed = new Set(COMPANION_PLUGINS.map(companionDirName));
  const retired = new Set(RETIRED_COMPANION_DIRS);
  for (const dir of retired) {
    assert.ok(!listed.has(dir), '退役目录不得同时出现在清单里: ' + dir);
    assert.ok(onDisk.has(dir), '退役目录的源应保留（要真退役就删源，不要只摘清单）: ' + dir);
  }
  for (const dir of onDisk) {
    if (retired.has(dir)) continue;
    assert.ok(listed.has(dir), 'assets/plugins/' + dir + ' 不在 COMPANION_PLUGINS 清单（会被过期清理误删或漏同步）');
  }
  for (const dir of listed) assert.ok(onDisk.has(dir), '清单声明的目录缺失: ' + dir);
});
