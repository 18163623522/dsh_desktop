'use strict';

// scripts/lib/profile-reconcile.js 单元测试（node --test，无需 Electron）：
//   · validateBundleEntry 全失败码与健康判定；
//   · reconcileProfileBundles 全流程（健康零写入 / 无效登记移除 + 隔离记录 /
//     核心异常保留 / 损坏备份重建 / 核心预写 / 配套追加 / 源缺失与卸载标记移除 /
//     重置恢复 / dry-run 零落盘 / 恢复健康后隔离记录清除 / 记录文件容错）；
//   · CLI 契约（initMissing=false：缺失 manifest 不凭空创建，损坏且核心不可
//     解析时不落盘空骨架）；
//   · 真实 dsh-app-boot 复现：无 dsh.bundle 声明的登记被 rc.2 上游逐 bundle 原生
//     跳过（skippedBundles + stderr 诊断，不再击穿启动；旧内核的
//     "declares no dsh.bundle" 必崩形态有 pristine 字节正证），对账后从清单
//     移除并落隔离记录（仓库 node_modules 已安装时执行）；
//   · issue #132：pnpm 虚拟仓回落（不可穿透符号链接 / scoped / 版本选择 /
//     传递依赖门 / junction）与 WSL UNC 防误删保护（解析受限 unverifiable →
//     保留登记仅告警、清除历史误判隔离记录；本地路径确证缺失语义不变）。
// 用法：node --test scripts/test/unit-profile-reconcile.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { findPristineFile, describePristineRoots } = require('../lib/pristine-kernel-roots');

const {
  BUNDLE_CHECK_CODES,
  inspectBundleDir,
} = require('../../profile-bundle-heal');
const { CORE_BUNDLE_NAMES } = require('../../profile-manifest');
const {
  BROKEN_BUNDLES_RECORD_FILENAME,
  createEntryListYamlParser,
  isWslUncPath,
  readBrokenBundlesRecord,
  validateBundleEntry,
  reconcileProfileBundles,
} = require('../../scripts/lib/profile-reconcile');

const repoRoot = path.resolve(__dirname, '..', '..');
const CORES = [...CORE_BUNDLE_NAMES];

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbr-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 在 base 下构造一个健康的 bundle 包目录（声明 patch + 补丁层 + 入口）。
 *  注意 packageDirUpward 的语义：包位于 <base>/node_modules/<name>。 */
function writeHealthyBundle(base, name, extra = {}) {
  const dir = path.join(base, 'node_modules', ...name.split('/'));
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(Object.assign({
    name,
    version: '1.0.0',
    main: 'lib/index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, extra), null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '[]\n');
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'export {};\n');
  return dir;
}

function readManifest(profileDir) {
  return JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
}

function recordFile(profileDir) {
  return path.join(profileDir, BROKEN_BUNDLES_RECORD_FILENAME);
}

/** 解析器桩：与 dsh 方言同构（JSON_SCHEMA + !!js）；'BAD' 内容抛错。 */
function makeParser() {
  const yaml = require('js-yaml');
  const jsType = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
  });
  return (content) => yaml.load(content, { schema: yaml.JSON_SCHEMA.extend(jsType) });
}

// ---------------------------------------------------------------------------
// validateBundleEntry
// ---------------------------------------------------------------------------

test('validateBundleEntry: 健康登记通过，11 种失败码逐项命中', (t) => {
  const base = tmpdir(t);
  writeHealthyBundle(base, 'good-bundle');
  const ok = validateBundleEntry('good-bundle', { installAnchorDir: base, profileDir: base, parsePatch: null });
  assert.equal(ok.ok, true);
  assert.equal(ok.packageDir, path.join(base, 'node_modules', 'good-bundle'));

  // INVALID_NAME：非字符串 / 空串
  assert.equal(validateBundleEntry('', { installAnchorDir: base, profileDir: base }).code, BUNDLE_CHECK_CODES.INVALID_NAME);
  assert.equal(validateBundleEntry(42, { installAnchorDir: base, profileDir: base }).code, BUNDLE_CHECK_CODES.INVALID_NAME);
  assert.equal(validateBundleEntry(null, { installAnchorDir: base, profileDir: base }).code, BUNDLE_CHECK_CODES.INVALID_NAME);

  // UNRESOLVABLE：双锚点均解析不到
  assert.equal(
    validateBundleEntry('ghost-bundle', { installAnchorDir: base, profileDir: base }).code,
    BUNDLE_CHECK_CODES.UNRESOLVABLE,
  );

  // NO_BUNDLE_DECL：普通库 / 仅客户端 bundle（用户反馈的 dsh-hub 形状）
  const clientOnly = writeHealthyBundle(base, 'client-only-bundle', {
    dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-runtime'] } },
  });
  fs.writeFileSync(path.join(clientOnly, 'package.json'), JSON.stringify({
    name: 'client-only-bundle', version: '1.0.0', main: 'lib/index.js',
    dsh: { client: { platform: 'web' } },
  }, null, 2) + '\n');
  assert.equal(
    validateBundleEntry('client-only-bundle', { installAnchorDir: base, profileDir: base }).code,
    BUNDLE_CHECK_CODES.NO_BUNDLE_DECL,
  );

  // PATCH_MISSING：声明了补丁层但文件缺失
  const noPatch = path.join(base, 'node_modules', 'no-patch-file');
  fs.mkdirSync(noPatch, { recursive: true });
  fs.writeFileSync(path.join(noPatch, 'package.json'), JSON.stringify({
    name: 'no-patch-file', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n');
  assert.equal(
    validateBundleEntry('no-patch-file', { installAnchorDir: base, profileDir: base }).code,
    BUNDLE_CHECK_CODES.PATCH_MISSING,
  );

  // PATCH_UNPARSEABLE：补丁层存在但 YAML 损坏（提供解析器时）
  const badPatch = writeHealthyBundle(base, 'bad-patch');
  fs.writeFileSync(path.join(badPatch, 'cordis.patch.yml'), '- id: [BAD\n', 'utf8');
  assert.equal(
    validateBundleEntry('bad-patch', { installAnchorDir: base, profileDir: base, parsePatch: makeParser() }).code,
    BUNDLE_CHECK_CODES.PATCH_UNPARSEABLE,
  );
  // 不提供解析器：可解析性不检查，其余通过 → 健康
  assert.equal(validateBundleEntry('bad-patch', { installAnchorDir: base, profileDir: base, parsePatch: null }).ok, true);

  // ENTRY_MISSING：声明了入口但文件缺失
  const noEntry = path.join(base, 'node_modules', 'no-entry');
  fs.mkdirSync(path.join(noEntry, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(noEntry, 'package.json'), JSON.stringify({
    name: 'no-entry', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(noEntry, 'cordis.patch.yml'), '[]\n');
  assert.equal(
    validateBundleEntry('no-entry', { installAnchorDir: base, profileDir: base }).code,
    BUNDLE_CHECK_CODES.ENTRY_MISSING,
  );

  // ENTRY_MISSING（目录形态）：入口路径存在但是目录——Loader 用 ESM import()
  // 激活，指向目录的 main/exports 必然 ERR_UNSUPPORTED_DIR_IMPORT（存在性
  // 检查会放过，必须校验是普通文件）
  const dirEntry = path.join(base, 'node_modules', 'dir-entry');
  fs.mkdirSync(path.join(dirEntry, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dirEntry, 'package.json'), JSON.stringify({
    name: 'dir-entry', main: 'lib', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dirEntry, 'cordis.patch.yml'), '[]\n');
  fs.writeFileSync(path.join(dirEntry, 'lib', 'index.js'), 'export {};\n');
  assert.equal(
    validateBundleEntry('dir-entry', { installAnchorDir: base, profileDir: base }).code,
    BUNDLE_CHECK_CODES.ENTRY_MISSING,
    '入口指向目录必须判 ENTRY_MISSING（ESM 无法导入目录）',
  );
  // 对照：入口是普通文件 → 健康
  assert.equal(validateBundleEntry('good-bundle', { installAnchorDir: base, profileDir: base }).ok, true);

  // PATCH_OUTSIDE / ENTRY_OUTSIDE：路径越界围栏
  const escaping = path.join(base, 'node_modules', 'escaping');
  fs.mkdirSync(escaping, { recursive: true });
  fs.writeFileSync(path.join(escaping, 'package.json'), JSON.stringify({
    name: 'escaping', dsh: { bundle: { patch: '../../outside.yml' } },
  }, null, 2) + '\n');
  assert.equal(
    validateBundleEntry('escaping', { installAnchorDir: base, profileDir: base }).code,
    BUNDLE_CHECK_CODES.PATCH_OUTSIDE,
  );
  fs.writeFileSync(path.join(escaping, 'package.json'), JSON.stringify({
    name: 'escaping', main: '../../outside.js', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(escaping, 'cordis.patch.yml'), '[]\n');
  assert.equal(
    validateBundleEntry('escaping', { installAnchorDir: base, profileDir: base }).code,
    BUNDLE_CHECK_CODES.ENTRY_OUTSIDE,
  );

  // CLIENT_ENTRY_MISSING / CLIENT_ENTRY_OUTSIDE：exports["./client"] 字符串声明
  // （dshmarket 形状）——client-modules 装配按该路径读取客户端 bundle，缺失
  // 会让整个 client 模块注册 fail-loud（MissingClientBundleError → dsh web
  // 启动失败）。上游在 verifyBundleDir 增加该校验（3 个单测），对账侧同步
  // 收口为结构化失败码（CLIENT_ENTRY_*），保证「每条登记都可装配」判定覆盖
  // 该形状；健康包不受影响。
  const clientOk = path.join(base, 'node_modules', 'client-ok');
  fs.mkdirSync(path.join(clientOk, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(clientOk, 'client'), { recursive: true });
  fs.writeFileSync(path.join(clientOk, 'package.json'), JSON.stringify({
    name: 'client-ok', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } },
    exports: { './client': './client/client.js' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(clientOk, 'cordis.patch.yml'), '[]\n');
  fs.writeFileSync(path.join(clientOk, 'lib', 'index.js'), 'export {};\n');
  fs.writeFileSync(path.join(clientOk, 'client', 'client.js'), 'export {};\n');
  assert.equal(
    validateBundleEntry('client-ok', { installAnchorDir: base, profileDir: base }).ok,
    true,
    'client 入口落盘时判定健康',
  );
  const clientMissing = path.join(base, 'node_modules', 'client-missing');
  fs.mkdirSync(path.join(clientMissing, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(clientMissing, 'package.json'), JSON.stringify({
    name: 'client-missing', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } },
    exports: { './client': './client/client.js' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(clientMissing, 'cordis.patch.yml'), '[]\n');
  fs.writeFileSync(path.join(clientMissing, 'lib', 'index.js'), 'export {};\n');
  assert.equal(
    validateBundleEntry('client-missing', { installAnchorDir: base, profileDir: base }).code,
    BUNDLE_CHECK_CODES.CLIENT_ENTRY_MISSING,
  );
  const clientEsc = path.join(base, 'node_modules', 'client-esc');
  fs.mkdirSync(path.join(clientEsc, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(clientEsc, 'package.json'), JSON.stringify({
    name: 'client-esc', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } },
    exports: { './client': '../../client.js' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(clientEsc, 'cordis.patch.yml'), '[]\n');
  fs.writeFileSync(path.join(clientEsc, 'lib', 'index.js'), 'export {};\n');
  assert.equal(
    validateBundleEntry('client-esc', { installAnchorDir: base, profileDir: base }).code,
    BUNDLE_CHECK_CODES.CLIENT_ENTRY_OUTSIDE,
  );

  // PACKAGE_JSON_INVALID：package.json 不可解析
  const badJson = path.join(base, 'node_modules', 'bad-json');
  fs.mkdirSync(badJson, { recursive: true });
  fs.writeFileSync(path.join(badJson, 'package.json'), '{"name": BAD\n');
  assert.equal(
    validateBundleEntry('bad-json', { installAnchorDir: base, profileDir: base }).code,
    BUNDLE_CHECK_CODES.PACKAGE_JSON_INVALID,
  );

  // 第一锚点为空（CLI 未定位到 dsh 包）：不得依据进程 cwd 相对探测误判健康
  assert.equal(
    validateBundleEntry('ghost-bundle', { installAnchorDir: '', profileDir: base }).code,
    BUNDLE_CHECK_CODES.UNRESOLVABLE,
  );
});

test('validateBundleEntry: parsePatch 接受 { load } 形态（main.js loadDshYamlDialect 返回值），防止形态漂移静默跳过校验', (t) => {
  const base = tmpdir(t);
  const bad = writeHealthyBundle(base, 'bad-patch');
  fs.writeFileSync(path.join(bad, 'cordis.patch.yml'), '- id: [BAD\n', 'utf8');
  // 函数形态
  assert.equal(
    validateBundleEntry('bad-patch', { installAnchorDir: base, profileDir: base, parsePatch: makeParser() }).code,
    BUNDLE_CHECK_CODES.PATCH_UNPARSEABLE,
  );
  // { load } 对象形态
  const dialect = { load: (content) => makeParser()(content) };
  assert.equal(
    validateBundleEntry('bad-patch', { installAnchorDir: base, profileDir: base, parsePatch: dialect }).code,
    BUNDLE_CHECK_CODES.PATCH_UNPARSEABLE,
  );
  // 其它值 → 跳过可解析性检查（保守降级，不抛错）
  assert.equal(validateBundleEntry('bad-patch', { installAnchorDir: base, profileDir: base, parsePatch: 42 }).ok, true);
});

test('validateBundleEntry: 顶层数组但条目非映射（dsh parsePatchList 契约）判 PATCH_UNPARSEABLE', (t) => {
  const base = tmpdir(t);
  // 四种畸形形状：标量 / 字符串 / 嵌套数组 / null —— yaml.load 得到数组，
  // 但 dsh-app-boot parsePatchList 对每项要求是映射（"must be a mapping"）。
  const shapes = ['- 42\n', '- "string-entry"\n', '- [1, 2]\n', '- null\n'];
  for (const shape of shapes) {
    const dir = writeHealthyBundle(base, 'odd-entry');
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), shape, 'utf8');
    const check = validateBundleEntry('odd-entry', { installAnchorDir: base, profileDir: base, parsePatch: makeParser() });
    assert.equal(check.code, BUNDLE_CHECK_CODES.PATCH_UNPARSEABLE, '形状 ' + JSON.stringify(shape) + ' 应判 PATCH_UNPARSEABLE');
  }
  // 合法 mapping 条目不受影响
  const ok = writeHealthyBundle(base, 'fine-entry');
  fs.writeFileSync(path.join(ok, 'cordis.patch.yml'), '- id: x\n  config: { a: 1 }\n', 'utf8');
  assert.equal(validateBundleEntry('fine-entry', { installAnchorDir: base, profileDir: base, parsePatch: makeParser() }).ok, true);
  // 不提供解析器：跳过（保守降级）
  const dir = writeHealthyBundle(base, 'odd-entry-2');
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- 42\n', 'utf8');
  assert.equal(validateBundleEntry('odd-entry-2', { installAnchorDir: base, profileDir: base, parsePatch: null }).ok, true);
});

test('resolveBundleDirLike: 与官方双锚点语义同构（第一锚点优先，其次 profile）', (t) => {
  const base = tmpdir(t);
  const installDir = path.join(base, 'install');
  const profileDir = path.join(base, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  writeHealthyBundle(installDir, 'in-install');
  writeHealthyBundle(profileDir, 'in-profile');
  writeHealthyBundle(installDir, 'in-both');
  writeHealthyBundle(profileDir, 'in-both');
  const {
    resolveBundleDirLike,
  } = require('../../scripts/lib/profile-reconcile');
  // 第一锚点命中（安装优先于 profile）
  assert.equal(
    resolveBundleDirLike(path.join(installDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'in-both'),
    path.join(installDir, 'node_modules', 'in-both'),
  );
  // 仅 profile 锚点命中（第二锚点语义）
  assert.equal(
    resolveBundleDirLike(path.join(profileDir, 'package.json'), 'in-profile'),
    path.join(profileDir, 'node_modules', 'in-profile'),
  );
  // 双锚点组合（validateBundleEntry 语义）：第一锚点不中 → 第二锚点命中
  const first = resolveBundleDirLike(path.join(installDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'in-profile');
  const second = resolveBundleDirLike(path.join(profileDir, 'package.json'), 'in-profile');
  assert.equal(first, '', '第一锚点不得命中 profile 内的包');
  assert.ok(second, '第二锚点应命中');
  // 都不中 → 空串
  assert.equal(
    resolveBundleDirLike(path.join(installDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'ghost'),
    '',
  );
  assert.equal(resolveBundleDirLike(path.join(profileDir, 'package.json'), 'ghost'), '');
  // 空锚点目录（CLI 未定位 dsh 包）→ 空串（不抛错）
  assert.equal(resolveBundleDirLike('', 'anything'), '');
});

// ---------------------------------------------------------------------------
// resolveBundleDirLike：pnpm 虚拟仓回落（issue #132——WSL/UNC 场景）
//
// WSL 模式下 profile 是 UNC 路径：pnpm 顶层的 node_modules/<pkg> 是 Linux
// 符号链接，Windows 侧 node 读不透（package.json 直查恒 false），但内核运行
// 在 WSL 内、Linux 侧解析正常。以下测试用「空目录占位」模拟不可穿透的符号
// 链接（目录名可枚举、内容不可直读），.pnpm 仓内放实体包本体。
// ---------------------------------------------------------------------------

/** 构造 pnpm 布局：顶层空目录占位（模拟不可穿透符号链接）+ .pnpm 仓实体包。 */
function writePnpmStoreBundle(base, name, version, extra = {}) {
  const segs = name.split('/');
  // 顶层占位：只建目录、不写 package.json（= Windows 侧直查失败的链接形态）。
  fs.mkdirSync(path.join(base, 'node_modules', ...segs), { recursive: true });
  const storeEntry = name.replace('/', '+') + '@' + version;
  const dir = path.join(base, 'node_modules', '.pnpm', storeEntry, 'node_modules', ...segs);
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(Object.assign({
    name,
    version,
    main: 'lib/index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, extra), null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '[]\n');
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'export {};\n');
  return dir;
}

test('resolveBundleDirLike: pnpm 虚拟仓回落（issue #132）——不可穿透符号链接经 .pnpm 实体目录解析', (t) => {
  const profileDir = tmpdir(t);
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: {},
  }, null, 2) + '\n');
  const storeDir = writePnpmStoreBundle(profileDir, 'dsh-vision-router', '1.2.0');
  const {
    resolveBundleDirLike,
  } = require('../../scripts/lib/profile-reconcile');
  const got = resolveBundleDirLike(path.join(profileDir, 'package.json'), 'dsh-vision-router');
  assert.equal(got, storeDir, '应命中 .pnpm 仓内实体目录（而非空串）');
  // 供 validateBundleEntry / inspectBundleDir 消费的完整健康判定
  const v = validateBundleEntry('dsh-vision-router', {
    installAnchorDir: '', profileDir, parsePatch: null,
  });
  assert.equal(v.ok, true, 'pnpm 布局登记不得判 UNRESOLVABLE');
  assert.equal(v.packageDir, storeDir);
});

test('resolveBundleDirLike: pnpm 回落支持 scoped 包（@scope+name 仓条目）', (t) => {
  const profileDir = tmpdir(t);
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
  }, null, 2) + '\n');
  const storeDir = writePnpmStoreBundle(profileDir, '@linxin666/dsh-web-ui-all', '0.3.1');
  const { resolveBundleDirLike } = require('../../scripts/lib/profile-reconcile');
  assert.equal(
    resolveBundleDirLike(path.join(profileDir, 'package.json'), '@linxin666/dsh-web-ui-all'),
    storeDir,
  );
});

test('resolveBundleDirLike: pnpm 回落——依赖声明精确版本优先于最高版', (t) => {
  const profileDir = tmpdir(t);
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dependencies: { 'multi-ver': '1.0.0' },
  }, null, 2) + '\n');
  const low = writePnpmStoreBundle(profileDir, 'multi-ver', '1.0.0');
  writePnpmStoreBundle(profileDir, 'multi-ver', '2.0.0');
  const { resolveBundleDirLike } = require('../../scripts/lib/profile-reconcile');
  assert.equal(
    resolveBundleDirLike(path.join(profileDir, 'package.json'), 'multi-ver'),
    low,
    '顶层链接指向声明版本（1.0.0），不是最高版 2.0.0',
  );
});

test('resolveBundleDirLike: pnpm 回落——range 声明走版本降序兜底', (t) => {
  const profileDir = tmpdir(t);
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: { 'multi-ver': '^1.0.0' },
  }, null, 2) + '\n');
  writePnpmStoreBundle(profileDir, 'multi-ver', '1.0.0');
  const high = writePnpmStoreBundle(profileDir, 'multi-ver', '2.0.0');
  const { resolveBundleDirLike } = require('../../scripts/lib/profile-reconcile');
  assert.equal(
    resolveBundleDirLike(path.join(profileDir, 'package.json'), 'multi-ver'),
    high,
    'range 声明无法精确对齐时取最高版（确定性近似）',
  );
});

test('resolveBundleDirLike: pnpm 回落——仅存于 .pnpm 的传递依赖不误判（顶层无登记）', (t) => {
  const profileDir = tmpdir(t);
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
  }, null, 2) + '\n');
  // 只有仓内实体、顶层 node_modules 无同名目录项（pnpm 传递依赖形态）
  writePnpmStoreBundle(profileDir, 'transitive-only', '1.0.0');
  fs.rmSync(path.join(profileDir, 'node_modules', 'transitive-only'), { recursive: true, force: true });
  const { resolveBundleDirLike } = require('../../scripts/lib/profile-reconcile');
  assert.equal(
    resolveBundleDirLike(path.join(profileDir, 'package.json'), 'transitive-only'),
    '',
    'Linux 侧 createRequire 同样解析不到（非直接依赖），不得误判可解析',
  );
});

test('resolveBundleDirLike: 平铺真实目录优先，.pnpm 仓不干扰既有解析', (t) => {
  const profileDir = tmpdir(t);
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
  }, null, 2) + '\n');
  const flat = writeHealthyBundle(profileDir, 'flat-pkg');
  writePnpmStoreBundle(profileDir, 'flat-pkg', '9.9.9');
  const { resolveBundleDirLike } = require('../../scripts/lib/profile-reconcile');
  assert.equal(
    resolveBundleDirLike(path.join(profileDir, 'package.json'), 'flat-pkg'),
    flat,
    '直查可解析（自研同步的平铺布局）时不得改走 .pnpm 仓',
  );
});

test('reconcile: pnpm 布局登记不被移除（issue #132 端到端——WSL 手装插件保留）', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  const storeDir = writePnpmStoreBundle(profileDir, 'dsh-context', '0.8.0');
  const before = {
    name: 'dsh-profile-web', private: true,
    dependencies: { 'dsh-context': '0.8.0' },
    dsh: { profile: { bundles: [...CORES, 'dsh-context'] } },
  };
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(before, null, 2) + '\n');
  const logs = [];
  const r = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    parsePatch: null,
    log: (m) => logs.push(m),
  });
  assert.equal(r.changed, false, 'pnpm 布局登记健康，manifest 应零写入');
  assert.deepEqual(r.removed, [], '不得判 UNRESOLVABLE 移除');
  assert.deepEqual(readManifest(profileDir), before, '登记必须原样保留');
  assert.equal(fs.existsSync(recordFile(profileDir)), false, '不应写隔离记录');
  assert.ok(storeDir, 'fixture 完整性');
});

// ---------------------------------------------------------------------------
// WSL UNC 防误删保护（issue #132 任务 b/c）
//
// 即便 pnpm 仓回落也解析不到（如 .pnpm 布局不可读 / 包管理器形态变化），
// 锚点是 \\wsl$ / \\wsl.localhost 时 Windows 侧检查不可靠：解析不到 ≠ 缺失。
// 此类登记必须保留 + 告警（unverifiable），绝不判 UNRESOLVABLE 移除 / 隔离。
// ---------------------------------------------------------------------------

test('isWslUncPath: 识别 \\wsl$ / \\wsl.localhost（含正斜杠与大小写），本地路径为 false', () => {
  assert.equal(isWslUncPath('\\\\wsl.localhost\\kali-linux\\root\\.dsh\\profiles\\web'), true);
  assert.equal(isWslUncPath('\\\\wsl$\\Ubuntu-22.04\\home\\u\\.dsh'), true);
  assert.equal(isWslUncPath('//wsl.localhost/kali-linux/root'), true, '正斜杠 UNC 写法同样识别');
  assert.equal(isWslUncPath('\\\\WSL.LOCALHOST\\Kali-Linux\\root'), true, '大小写不敏感');
  assert.equal(isWslUncPath('C:\\Users\\x\\.dsh\\profiles\\web'), false);
  assert.equal(isWslUncPath('/home/x/.dsh/profiles/web'), false);
  assert.equal(isWslUncPath('\\\\server\\share\\.dsh'), false, '普通 SMB UNC 不是 WSL');
  assert.equal(isWslUncPath(''), false);
  assert.equal(isWslUncPath(null), false);
});

test('validateBundleEntry: WSL UNC 锚点解析不到 → UNRESOLVABLE + unverifiable（解析受限 ≠ 缺失）', (t) => {
  const local = tmpdir(t);
  // 对照：本地（可可靠检查的）路径解析不到 → 确证缺失，维持既有移除语义
  const localMiss = validateBundleEntry('dsh-vision-router', {
    installAnchorDir: local, profileDir: local, parsePatch: null,
  });
  assert.equal(localMiss.code, BUNDLE_CHECK_CODES.UNRESOLVABLE);
  assert.equal(localMiss.unverifiable, false, '本地路径检查可靠，不触发保护');
  // WSL UNC 锚点（不存在的发行版——解析必然落空）→ 只能判「无法确认」
  const wslProfile = '\\\\wsl.localhost\\no-such-distro-xyz\\root\\.dsh\\profiles\\web';
  const wslMiss = validateBundleEntry('dsh-vision-router', {
    installAnchorDir: '', profileDir: wslProfile, parsePatch: null,
  });
  assert.equal(wslMiss.code, BUNDLE_CHECK_CODES.UNRESOLVABLE);
  assert.equal(wslMiss.unverifiable, true, 'WSL UNC 解析受限必须带 unverifiable 标记');
  assert.notEqual(wslMiss.reason, localMiss.reason, '提示语必须区分「确证缺失」与「解析受限」');
  assert.ok(wslMiss.reason.includes('WSL'), '提示语应说明 WSL 校验受限的成因');
});

test('reconcile: WSL UNC 锚点解析不到 → 登记保留仅告警，且清除旧版本误判的隔离记录（issue #132）', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const before = {
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [...CORES, 'dsh-vision-router'] } },
  };
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(before, null, 2) + '\n');
  // 旧版本误判留下的隔离记录 → 本轮保留登记时必须自愈清除
  fs.writeFileSync(recordFile(profileDir), JSON.stringify({
    v: 1,
    entries: {
      'dsh-vision-router': {
        code: 'UNRESOLVABLE',
        reason: '包未安装（dsh 安装与 profile node_modules 均解析不到）',
        removedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  }, null, 2) + '\n');
  const logs = [];
  const r = reconcileProfileBundles(profileDir, {
    // WSL UNC 安装锚点（不存在的发行版）：Windows 侧存在性检查不可靠
    installAnchorDir: '\\\\wsl.localhost\\no-such-distro-xyz\\root\\.dsh',
    coreNames: CORES,
    parsePatch: null,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(r.removed, [], '解析受限不得按 UNRESOLVABLE 移除');
  assert.deepEqual(r.quarantined, [], '解析受限不得写入隔离记录');
  assert.ok(r.unverifiable.includes('dsh-vision-router'), '保留的登记应在 unverifiable 中上报');
  assert.equal(r.changed, false, '保留登记不产生 manifest 写入');
  assert.deepEqual(readManifest(profileDir), before, '登记必须原样保留（bundles 不被清空）');
  const rec = readBrokenBundlesRecord(recordFile(profileDir));
  assert.equal(rec && rec.entries['dsh-vision-router'], undefined, '历史误判记录应被清除');
  assert.ok(r.unquarantined.includes('dsh-vision-router'));
  assert.ok(logs.some((m) => m.includes('dsh-vision-router') && m.includes('保留登记')), '必须告警而非静默');

  // 对照：同样的「解析不到」发生在本地（可可靠检查的）路径上 → 既有移除 + 隔离语义不变
  const localHome = tmpdir(t);
  const localProfile = path.join(localHome, 'profiles', 'web');
  fs.mkdirSync(localProfile, { recursive: true });
  const localInstall = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(localInstall, name);
  fs.writeFileSync(path.join(localProfile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [...CORES, 'ghost-pkg'] } },
  }, null, 2) + '\n');
  const r2 = reconcileProfileBundles(localProfile, {
    installAnchorDir: localInstall,
    coreNames: CORES,
    parsePatch: null,
    log: () => {},
  });
  assert.deepEqual(r2.unverifiable, [], '本地路径解析不到不触发保护');
  assert.deepEqual(r2.removed.map((x) => x.name), ['ghost-pkg'], '确证缺失仍按既有语义移除');
  assert.deepEqual(r2.quarantined, ['ghost-pkg']);
  assert.ok(r2.changed);
});

test('reconcile: WSL UNC 锚点下 addNames 校验受限 → 不登记仅告警（不隔离）', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [...CORES] } },
  }, null, 2) + '\n');
  const logs = [];
  const r = reconcileProfileBundles(profileDir, {
    installAnchorDir: '\\\\wsl$\\no-such-distro-xyz\\root\\.dsh',
    coreNames: CORES,
    addNames: new Set(['dsh-context']),
    parsePatch: null,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(r.added, [], '无法确认健康时不登记');
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.quarantined, [], '解析受限绝不隔离');
  assert.ok(logs.some((m) => m.includes('dsh-context') && m.includes('不登记')), '必须告警而非静默');
});

test('resolveBundleDirLike: Windows 原生 junction 形态的 pnpm 布局可解析（realpath 与直查均可达）', (t) => {
  if (process.platform !== 'win32') return t.skip('junction 布局仅 Windows');
  const profileDir = tmpdir(t);
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
  }, null, 2) + '\n');
  const storeDir = writePnpmStoreBundle(profileDir, 'junction-pkg', '1.0.0');
  // 顶层改成指向 .pnpm 仓内实体目录的 junction（Windows pnpm 安装的真实形态）
  const linkPath = path.join(profileDir, 'node_modules', 'junction-pkg');
  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(storeDir, linkPath, 'junction');
  const { resolveBundleDirLike } = require('../../scripts/lib/profile-reconcile');
  const got = resolveBundleDirLike(path.join(profileDir, 'package.json'), 'junction-pkg');
  assert.notEqual(got, '', 'junction 链接必须可解析');
  assert.equal(fs.existsSync(path.join(got, 'package.json')), true);
  assert.equal(fs.realpathSync(got), fs.realpathSync(storeDir), '解析结果与 .pnpm 实体目录同源');
  const v = validateBundleEntry('junction-pkg', { installAnchorDir: '', profileDir, parsePatch: null });
  assert.equal(v.ok, true, 'junction 形态登记不得判 UNRESOLVABLE');
});

// ---------------------------------------------------------------------------
// reconcileProfileBundles：健康零写入
// ---------------------------------------------------------------------------

test('reconcile: 健康 manifest 零写入（幂等）', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  for (const name of ['extra-bundle']) writeHealthyBundle(profileDir, name);
  const before = {
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [...CORES, 'extra-bundle'] } },
  };
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(before, null, 2) + '\n');
  const logs = [];
  const r = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    parsePatch: null,
    log: (m) => logs.push(m),
  });
  assert.equal(r.changed, false);
  assert.equal(r.removed.length, 0);
  assert.deepEqual(logs, []);
  assert.deepEqual(readManifest(profileDir), before, '健康 manifest 应逐字节不变');
  assert.equal(fs.existsSync(recordFile(profileDir)), false, '不应产生隔离记录');
});

// ---------------------------------------------------------------------------
// reconcileProfileBundles：无效登记移除 + 隔离记录
// ---------------------------------------------------------------------------

test('reconcile: 无效非核心登记移除并记入隔离记录；核心异常保留', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  // 用户反馈形状：纯客户端 bundle 被登记进 profile.bundles
  const clientOnly = path.join(profileDir, 'node_modules', '@dsh-external', 'dsh-hub-like');
  fs.mkdirSync(clientOnly, { recursive: true });
  fs.writeFileSync(path.join(clientOnly, 'package.json'), JSON.stringify({
    name: '@dsh-external/dsh-hub-like', version: '1.0.0', main: 'lib/index.js',
    dsh: { client: { platform: 'web' } },
  }, null, 2) + '\n');
  // 未安装的登记（ghost-bundle）
  // 核心之一损坏（补丁层缺失）→ 必须保留
  const brokenCore = path.join(installDir, 'node_modules', ...CORES[0].split('/'));
  fs.rmSync(path.join(brokenCore, 'cordis.patch.yml'));
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: {},
    dsh: { profile: { bundles: [...CORES, '@dsh-external/dsh-hub-like', 'ghost-bundle'] } },
  }, null, 2) + '\n');
  const logs = [];
  const r = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    parsePatch: null,
    log: (m) => logs.push(m),
  });
  assert.equal(r.changed, true);
  const removedNames = r.removed.map((x) => x.name);
  assert.deepEqual(removedNames, ['@dsh-external/dsh-hub-like', 'ghost-bundle']);
  for (const item of r.removed) {
    assert.equal(typeof item.code, 'string', '失败码必须是字符串（防常量缺失静默变 undefined）');
    assert.notEqual(item.code, '', '失败码不得为空串');
  }
  assert.equal(r.removed.find((x) => x.name === '@dsh-external/dsh-hub-like').code, BUNDLE_CHECK_CODES.NO_BUNDLE_DECL);
  assert.equal(r.removed.find((x) => x.name === 'ghost-bundle').code, BUNDLE_CHECK_CODES.UNRESOLVABLE);
  const manifest = readManifest(profileDir);
  assert.deepEqual(manifest.dsh.profile.bundles, CORES, '核心应保留（含损坏的核心），无效登记移除');
  assert.ok(logs.some((m) => m.includes('核心 bundle 登记异常（保留')), '核心异常应有保留告警');
  assert.ok(logs.some((m) => m.includes('已把无效的 profile bundle 登记移除: @dsh-external/dsh-hub-like')), '移除应有诊断日志');
  const record = readBrokenBundlesRecord(recordFile(profileDir));
  assert.ok(record && record.entries['@dsh-external/dsh-hub-like'], '隔离记录应写入');
  assert.equal(record.entries['@dsh-external/dsh-hub-like'].code, BUNDLE_CHECK_CODES.NO_BUNDLE_DECL);
  assert.ok(record.entries['ghost-bundle'], '未安装登记也应记录');
});

test('reconcile: 补丁层 YAML 损坏（parsePatch 提供时）移除；bundle 文件不修改', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  const broken = writeHealthyBundle(profileDir, 'broken-patch');
  const brokenText = '- id: [BAD\n';
  fs.writeFileSync(path.join(broken, 'cordis.patch.yml'), brokenText, 'utf8');
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [...CORES, 'broken-patch'] } },
  }, null, 2) + '\n');
  const r = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    parsePatch: makeParser(),
    log: () => {},
  });
  assert.equal(r.removed[0].code, BUNDLE_CHECK_CODES.PATCH_UNPARSEABLE);
  assert.equal(fs.readFileSync(path.join(broken, 'cordis.patch.yml'), 'utf8'), brokenText, 'bundle 文件绝不修改');
  // 不提供解析器：跳过可解析性检查 → 该登记保留（运行时防护兜底）
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [...CORES, 'broken-patch'] } },
  }, null, 2) + '\n');
  const r2 = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    parsePatch: null,
    log: () => {},
  });
  assert.equal(r2.changed, false, '无解析器时不应移除（保守降级）');
});

// ---------------------------------------------------------------------------
// reconcileProfileBundles：损坏重建 / 核心预写
// ---------------------------------------------------------------------------

test('reconcile: 损坏 manifest 备份重建（核心可解析时），原文保留在 .broken- 备份', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  const corrupt = '{"name": "dsh-profile-web", "dsh": {"profile": {"bundles": [';
  fs.writeFileSync(path.join(profileDir, 'package.json'), corrupt, 'utf8');
  const logs = [];
  const r = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    parsePatch: null,
    log: (m) => logs.push(m),
  });
  assert.equal(r.reset, true);
  assert.ok(r.backup && fs.existsSync(r.backup), '应产生 .broken- 备份');
  assert.equal(fs.readFileSync(r.backup, 'utf8'), corrupt, '备份内容应为原文');
  assert.deepEqual(readManifest(profileDir).dsh.profile.bundles, CORES, '重建后应含核心 bundles');
  assert.ok(logs.some((m) => m.includes('profile manifest 损坏，原文件已备份到')));
  assert.ok(logs.some((m) => m.includes('未发现需要恢复的用户 bundle')));
});

test('reconcile: 损坏 manifest + 核心不可解析：不落盘空骨架（保持磁盘原样）', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t); // 无任何 dsh 包
  const corrupt = '{"name": "dsh-profile-web", BAD';
  const file = path.join(profileDir, 'package.json');
  fs.writeFileSync(file, corrupt, 'utf8');
  const r = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    parsePatch: null,
    log: () => {},
  });
  assert.equal(r.changed, false, '核心不可解析时不得写任何东西');
  assert.equal(r.backup, null, '不落盘则不产生备份');
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt, '磁盘文件应原样保留');
});

test('reconcile: manifest 缺失 + initMissing=true 且核心可解析 → 预写核心', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  const r = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    parsePatch: null,
    log: () => {},
  });
  assert.equal(r.changed, true);
  assert.deepEqual(readManifest(profileDir).dsh.profile.bundles, CORES);
});

test('reconcile: CLI 契约（initMissing=false）——缺失 manifest 不创建', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  const logs = [];
  const r = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    addNames: new Set(['extra-bundle']),
    parsePatch: null,
    initMissing: false,
    log: (m) => logs.push(m),
  });
  assert.equal(r.changed, false);
  assert.equal(fs.existsSync(path.join(profileDir, 'package.json')), false, 'CLI 不得凭空创建 manifest');
  assert.ok(logs.some((m) => m.includes('bundle 插件留待下次运行注册')), '应提示留待下次注册');
});

// ---------------------------------------------------------------------------
// reconcileProfileBundles：配套登记追加 / 源缺失 / 卸载标记 / 恢复
// ---------------------------------------------------------------------------

test('reconcile: 配套追加 / 源缺失移除 / 卸载标记移除各自生效', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  writeHealthyBundle(profileDir, 'companion-a');
  writeHealthyBundle(profileDir, 'companion-b');
  writeHealthyBundle(profileDir, 'companion-c');
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [...CORES, 'companion-a', 'companion-b'] } },
  }, null, 2) + '\n');
  const logs = [];
  const r = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    addNames: new Set(['companion-a', 'companion-c']),
    missingNames: new Set(['companion-b']),
    removedBundles: new Set(['companion-a']),
    parsePatch: null,
    log: (m) => logs.push(m),
  });
  assert.equal(r.changed, true);
  assert.deepEqual(r.added, ['companion-c']);
  assert.deepEqual(r.removedByPolicy, ['companion-b', 'companion-a']);
  assert.deepEqual(readManifest(profileDir).dsh.profile.bundles, [...CORES, 'companion-c']);
  assert.ok(logs.some((m) => m === '已把 bundle 插件加入 web profile bundles: companion-c'));
  assert.ok(logs.some((m) => m === '配套 bundle 源缺失，已从 web profile bundles 移除（视为禁用）: companion-b'));
  assert.ok(logs.some((m) => m === '已卸载 bundle 插件，从 web profile bundles 移除: companion-a'));
});

test('reconcile: addNames 配套 bundle 校验失败（补丁层 YAML 损坏）→ 不登记 + 隔离记录', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  // 配套 bundle 文件齐全（调用方 verifyBundleDir 会通过），但补丁层 YAML 损坏
  const bad = writeHealthyBundle(profileDir, 'companion-bad');
  fs.writeFileSync(path.join(bad, 'cordis.patch.yml'), '- id: [BAD\n', 'utf8');
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [...CORES] } },
  }, null, 2) + '\n');
  const logs = [];
  const r = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    addNames: new Set(['companion-bad']),
    parsePatch: makeParser(),
    log: (m) => logs.push(m),
  });
  assert.equal(r.changed, false, 'manifest 未被改动（该名从未被登记，不得做内容相同的无意义重写）');
  assert.deepEqual(r.quarantined, ['companion-bad']);
  assert.deepEqual(r.added, [], 'YAML 损坏的配套 bundle 不得登记');
  assert.equal(r.removed[0].code, BUNDLE_CHECK_CODES.PATCH_UNPARSEABLE);
  assert.ok(!readManifest(profileDir).dsh.profile.bundles.includes('companion-bad'), 'manifest 不得包含该登记');
  const record = readBrokenBundlesRecord(recordFile(profileDir));
  assert.ok(record && record.entries['companion-bad'], '隔离记录应记下拒绝原因');
  assert.equal(record.entries['companion-bad'].code, BUNDLE_CHECK_CODES.PATCH_UNPARSEABLE);
  assert.ok(logs.some((m) => m.includes('配套 bundle 校验失败，不登记进 web profile bundles: companion-bad')), '应有拒绝登记诊断日志');
  // 不提供解析器：跳过可解析性检查 → 登记成功（保守降级）
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [...CORES] } },
  }, null, 2) + '\n');
  const r2 = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    addNames: new Set(['companion-bad']),
    parsePatch: null,
    log: () => {},
  });
  assert.deepEqual(r2.added, ['companion-bad'], '无解析器时保守降级登记');
});

test('reconcile: 损坏重建后恢复用户 bundle（issue #48），普通依赖不恢复', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  writeHealthyBundle(profileDir, '@dsh-external/user-bundle');
  const plainDir = path.join(profileDir, 'node_modules', '@dsh-external', 'plain-lib');
  fs.mkdirSync(plainDir, { recursive: true });
  fs.writeFileSync(path.join(plainDir, 'package.json'), JSON.stringify({ name: '@dsh-external/plain-lib', version: '1.0.0' }, null, 2) + '\n');
  fs.writeFileSync(path.join(profileDir, 'package.json'), '{"name": "dsh-profile-web", BAD', 'utf8');
  const logs = [];
  const r = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    excludeFromRecover: new Set([...CORES, 'companion-a']),
    parsePatch: null,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(r.recovered, ['@dsh-external/user-bundle']);
  const manifest = readManifest(profileDir);
  assert.ok(manifest.dsh.profile.bundles.includes('@dsh-external/user-bundle'));
  assert.ok(!manifest.dsh.profile.bundles.includes('@dsh-external/plain-lib'), '普通依赖不得恢复登记');
  assert.equal(manifest.dependencies['@dsh-external/user-bundle'], '1.0.0', 'dependencies 应补回');
  assert.ok(logs.some((m) => m.includes('已恢复用户安装的 bundle 插件')));
});

test('reconcile: 恢复的 bundle 复检失败（补丁层 YAML 损坏）→ 移除恢复登记 + 隔离记录', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  // 用户第三方 bundle 文件齐全（scanProfileBundles 的 verifyBundleDir 会通过）
  // 但补丁层 YAML 损坏 → 复检必须拒绝恢复登记
  const bad = writeHealthyBundle(profileDir, '@dsh-external/broken-user-bundle');
  fs.writeFileSync(path.join(bad, 'cordis.patch.yml'), '- id: [BAD\n', 'utf8');
  fs.writeFileSync(path.join(profileDir, 'package.json'), '{"name": "dsh-profile-web", BAD', 'utf8');
  const logs = [];
  const r = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    parsePatch: makeParser(),
    log: (m) => logs.push(m),
  });
  assert.deepEqual(r.recovered, [], 'YAML 损坏的 bundle 不得恢复登记');
  assert.equal(r.removed[0].code, BUNDLE_CHECK_CODES.PATCH_UNPARSEABLE);
  const manifest = readManifest(profileDir);
  assert.ok(!manifest.dsh.profile.bundles.includes('@dsh-external/broken-user-bundle'), 'manifest 不得包含复检失败的恢复登记');
  const record = readBrokenBundlesRecord(recordFile(profileDir));
  assert.ok(record && record.entries['@dsh-external/broken-user-bundle'], '隔离记录应记下复检失败');
  assert.ok(logs.some((m) => m.includes('恢复的 bundle 复检失败')), '应有复检失败诊断日志');
  // 不提供解析器：跳过可解析性检查 → 恢复登记（保守降级）
  fs.writeFileSync(path.join(profileDir, 'package.json'), '{"name": "dsh-profile-web", BAD', 'utf8');
  const r2 = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    parsePatch: null,
    log: () => {},
  });
  assert.deepEqual(r2.recovered, ['@dsh-external/broken-user-bundle'], '无解析器时保守降级恢复');
});

test('reconcile: 策略性移除的名字（源缺失 / 卸载标记）不进隔离记录，由步骤 4/6 按用户意图禁用移除', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  // 已卸载配套：包目录已被插件管理删除（manifest 残留登记）→ 只能判
  // UNRESOLVABLE，但这是用户主动卸载，绝不能写入隔离记录（记录只描述无效
  // 登记，不描述用户意图）
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [...CORES, 'uninstalled-bundle', 'source-missing-bundle'] } },
  }, null, 2) + '\n');
  const logs = [];
  const r = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    missingNames: new Set(['source-missing-bundle']),
    removedBundles: new Set(['uninstalled-bundle']),
    parsePatch: null,
    log: (m) => logs.push(m),
  });
  assert.equal(r.changed, true);
  assert.deepEqual(r.removed, [], '策略性移除不进逐条校验移除列表');
  assert.deepEqual(r.quarantined, [], '策略性移除不得写入隔离记录');
  assert.deepEqual(r.removedByPolicy, ['source-missing-bundle', 'uninstalled-bundle']);
  assert.deepEqual(readManifest(profileDir).dsh.profile.bundles, CORES);
  assert.equal(fs.existsSync(recordFile(profileDir)), false, '不得产生隔离记录文件');
  assert.ok(!logs.some((m) => m.includes('已把无效的 profile bundle 登记移除')), '不得出现无效登记移除诊断');
  assert.ok(logs.some((m) => m.includes('配套 bundle 源缺失，已从 web profile bundles 移除（视为禁用）: source-missing-bundle')));
  assert.ok(logs.some((m) => m === '已卸载 bundle 插件，从 web profile bundles 移除: uninstalled-bundle'));
});

test('reconcile: addNames 失败记录在同轮登记成功时立即清除（不必等下一次启动）', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [...CORES] } },
  }, null, 2) + '\n');
  // run 1：YAML 损坏 → 不登记 + 记录
  const bad = writeHealthyBundle(profileDir, 'fixable-bundle');
  fs.writeFileSync(path.join(bad, 'cordis.patch.yml'), '- id: [BAD\n', 'utf8');
  reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir, coreNames: CORES,
    addNames: new Set(['fixable-bundle']), parsePatch: makeParser(), log: () => {},
  });
  let record = readBrokenBundlesRecord(recordFile(profileDir));
  assert.ok(record && record.entries['fixable-bundle'], '失败应产生记录');
  // run 2：文件修复（重装）→ 登记成功 → 同轮清除记录
  fs.writeFileSync(path.join(bad, 'cordis.patch.yml'), '[]\n', 'utf8');
  const r2 = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir, coreNames: CORES,
    addNames: new Set(['fixable-bundle']), parsePatch: makeParser(), log: () => {},
  });
  assert.deepEqual(r2.added, ['fixable-bundle']);
  assert.deepEqual(r2.unquarantined, ['fixable-bundle'], '登记成功应同轮解除隔离记录');
  record = readBrokenBundlesRecord(recordFile(profileDir));
  assert.ok(record && !record.entries['fixable-bundle'], '同轮记录应已清除');
});

test('reconcile: 重复的同类失败不重写隔离记录（保留首次 removedAt，无写入放大）', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  const bad = writeHealthyBundle(profileDir, 'stuck-bundle');
  fs.writeFileSync(path.join(bad, 'cordis.patch.yml'), '- id: [BAD\n', 'utf8');
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [...CORES] } },
  }, null, 2) + '\n');
  reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir, coreNames: CORES,
    addNames: new Set(['stuck-bundle']), parsePatch: makeParser(), log: () => {},
  });
  const first = fs.readFileSync(recordFile(profileDir), 'utf8');
  const firstRecord = JSON.parse(first);
  // 第二次：同 code + reason → 不得重写记录（removedAt 保持首次值）
  reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir, coreNames: CORES,
    addNames: new Set(['stuck-bundle']), parsePatch: makeParser(), log: () => {},
  });
  const second = fs.readFileSync(recordFile(profileDir), 'utf8');
  assert.equal(second, first, '同类失败重复运行不得重写隔离记录');
  assert.equal(JSON.parse(second).entries['stuck-bundle'].removedAt, firstRecord.entries['stuck-bundle'].removedAt);
});

test('reconcile: 重置恢复成功的 bundle 同轮清除历史隔离记录', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  // 历史场景：bundle 曾损坏被隔离记录；现文件已修复（健康），且 manifest 损坏
  writeHealthyBundle(profileDir, '@dsh-external/fixed-user-bundle');
  // 预置一条历史隔离记录
  fs.writeFileSync(recordFile(profileDir), JSON.stringify({
    v: 1,
    entries: {
      '@dsh-external/fixed-user-bundle': {
        code: BUNDLE_CHECK_CODES.ENTRY_MISSING, reason: '入口文件缺失: lib/index.js',
        removedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(profileDir, 'package.json'), '{"name": "dsh-profile-web", BAD', 'utf8');
  const r = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    excludeFromRecover: new Set(CORES),
    parsePatch: null,
    log: () => {},
  });
  assert.deepEqual(r.recovered, ['@dsh-external/fixed-user-bundle']);
  assert.deepEqual(r.unquarantined, ['@dsh-external/fixed-user-bundle'], '恢复成功应同轮解除隔离记录');
  const record = readBrokenBundlesRecord(recordFile(profileDir));
  assert.ok(record && !record.entries['@dsh-external/fixed-user-bundle'], '历史隔离记录应已清除');
});

test('reconcile: 重复登记的 bundle 去重（保留首次出现，不进隔离记录）', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  writeHealthyBundle(profileDir, 'dup-bundle');
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [...CORES, 'dup-bundle', 'dup-bundle', 'ghost-bundle'] } },
  }, null, 2) + '\n');
  const logs = [];
  const r = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    parsePatch: null,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(r.deduped, ['dup-bundle']);
  assert.deepEqual(readManifest(profileDir).dsh.profile.bundles, [...CORES, 'dup-bundle'], '重复项应移除且只保留首次出现');
  assert.ok(logs.some((m) => m.includes('已移除重复登记的 profile bundle: dup-bundle')), '应有去重诊断日志');
  const record = readBrokenBundlesRecord(recordFile(profileDir));
  assert.ok(!record || !record.entries['dup-bundle'], '重复登记是冗余而非无效登记，不得写入隔离记录');
  assert.ok(record && record.entries['ghost-bundle'], '同轮无效登记照常隔离');
  // 幂等：二次运行零写入
  const afterFirst = fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8');
  const r2 = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir, coreNames: CORES, parsePatch: null, log: () => {},
  });
  assert.equal(r2.changed, false);
  assert.equal(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'), afterFirst);
});

// ---------------------------------------------------------------------------
// reconcileProfileBundles：dry-run / 隔离记录生命周期
// ---------------------------------------------------------------------------

test('reconcile: dry-run 只计算不落盘', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  const before = {
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [...CORES, 'ghost-bundle'] } },
  };
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(before, null, 2) + '\n');
  const r = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    parsePatch: null,
    dryRun: true,
    log: () => {},
  });
  assert.equal(r.changed, true, 'dry-run 仍应报告将发生的修改');
  assert.deepEqual(r.removed.map((x) => x.name), ['ghost-bundle']);
  assert.deepEqual(readManifest(profileDir), before, 'dry-run 不得落盘');
  assert.equal(fs.existsSync(recordFile(profileDir)), false, 'dry-run 不得写隔离记录');
});

test('reconcile: 恢复健康后隔离记录清除；记录文件损坏容错', (t) => {
  const home = tmpdir(t);
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const installDir = tmpdir(t);
  for (const name of CORES) writeHealthyBundle(installDir, name);
  // 先移除一次（产生记录）
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [...CORES, 'fixable-bundle'] } },
  }, null, 2) + '\n');
  reconcileProfileBundles(profileDir, { installAnchorDir: installDir, coreNames: CORES, parsePatch: null, log: () => {} });
  let record = readBrokenBundlesRecord(recordFile(profileDir));
  assert.ok(record && record.entries['fixable-bundle'], '首次移除应产生记录');

  // 模拟重装：包恢复健康 + 重新登记 → 记录清除
  writeHealthyBundle(profileDir, 'fixable-bundle');
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [...CORES, 'fixable-bundle'] } },
  }, null, 2) + '\n');
  const r2 = reconcileProfileBundles(profileDir, {
    installAnchorDir: installDir,
    coreNames: CORES,
    parsePatch: null,
    log: () => {},
  });
  assert.deepEqual(r2.unquarantined, ['fixable-bundle']);
  record = readBrokenBundlesRecord(recordFile(profileDir));
  assert.ok(record && !record.entries['fixable-bundle'], '恢复健康后记录应清除');

  // 记录文件损坏：按无记录处理，移除时重建
  fs.writeFileSync(recordFile(profileDir), '{BAD JSON', 'utf8');
  assert.equal(readBrokenBundlesRecord(recordFile(profileDir)), null, '损坏记录应视为缺失');
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: [...CORES, 'ghost-again'] } },
  }, null, 2) + '\n');
  reconcileProfileBundles(profileDir, { installAnchorDir: installDir, coreNames: CORES, parsePatch: null, log: () => {} });
  record = readBrokenBundlesRecord(recordFile(profileDir));
  assert.ok(record && record.entries['ghost-again'], '损坏记录应被重建');
  assert.equal(record.v, 1);
});

// ---------------------------------------------------------------------------
// 真实 dsh-app-boot 复现（仓库 node_modules 已安装时执行）
// ---------------------------------------------------------------------------

test('真实 dsh-app-boot：无 dsh.bundle 声明登记被逐 bundle 原生跳过，对账后正常装配', async (t) => {
  const appBootIndex = path.join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
  const dshAnchor = path.join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  if (!fs.existsSync(appBootIndex) || !fs.existsSync(dshAnchor)) {
    t.skip('仓库 node_modules 未安装（npm install），跳过真实 dsh-app-boot 验证');
    return;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pbr-real-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profileDir = path.join(home, 'profiles', 'web');
  // 用户反馈形状：dsh-hub 是纯客户端 bundle（只声明 dsh.client），被登记进
  // dsh.profile.bundles → 官方 loadProfile 抛 "declares no dsh.bundle"。
  const clientOnly = path.join(profileDir, 'node_modules', '@dsh-external', 'gold-luxe');
  fs.mkdirSync(path.join(clientOnly, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(clientOnly, 'package.json'), JSON.stringify({
    name: '@dsh-external/gold-luxe', version: '1.0.0', main: 'lib/index.js',
    dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-runtime'] } },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(clientOnly, 'lib', 'index.js'), 'export {};\n');
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: {},
    dsh: { profile: { bundles: [...CORES, '@dsh-external/gold-luxe'] } },
  }, null, 2) + '\n');

  const mod = await import(pathToFileURL(appBootIndex).href);
  // rc.2 起「逐 bundle 容错」由上游原生实装：loadProfileDirectory 内
  // `for (const packageName of bundles) try {…} catch { skippedBundles.push(…) }`
  // + reportSkippedBundles 打 stderr。所以这条形状在打过我们守卫的树与 pristine 上
  // 表现一致，不再按 guard 是否在场分两支断言（旧分支的「官方 fail-loud」是
  // ≤0.1.6-alpha.1 的形状，见下方 pristine 字节正证）。
  const pre = mod.loadProfile('dsh', 'web', dshAnchor, home);
  assert.equal(pre.layers.filter((l) => l.packageName === '@dsh-external/gold-luxe').length, 0,
    '坏登记不得进入装配层');
  const skipped = pre.skippedBundles.filter((s) => s.packageName === '@dsh-external/gold-luxe');
  assert.equal(skipped.length, 1, '应被列进 skippedBundles: ' + JSON.stringify(pre.skippedBundles));
  assert.match(String(skipped[0].reason), /declares no dsh\.bundle/,
    '跳过原因必须保住内核原文（用户据此定位是哪个包缺声明）');
  assert.deepEqual(pre.layers.map((l) => l.packageName), CORES, '一家不合法不得牵连核心 bundles');
  // 2. 对账后：无效登记移除，loadProfile 正常装配核心 bundles。
  reconcileProfileBundles(profileDir, {
    installAnchorDir: path.dirname(dshAnchor),
    coreNames: CORES,
    parsePatch: null,
    log: () => {},
  });
  const profile = mod.loadProfile('dsh', 'web', dshAnchor, home);
  assert.deepEqual(profile.layers.map((l) => l.packageName), CORES, '对账后应只剩核心 bundles 且全部可装配');
  const manifest = readManifest(profileDir);
  assert.ok(!manifest.dsh.profile.bundles.includes('@dsh-external/gold-luxe'), '无效登记应已移除');
  const record = readBrokenBundlesRecord(recordFile(profileDir));
  assert.equal(record.entries['@dsh-external/gold-luxe'].code, BUNDLE_CHECK_CODES.NO_BUNDLE_DECL, '隔离记录应记录移除原因');
});

test('pristine 正证：逐 bundle 容错是 rc.2 上游自带的，我们的守卫只补它没覆盖的两处', (t) => {
  // 「容错来自上游」这件事必须被证明，否则下一条用例的跳过断言可能被误读成
  // 「我们的守卫又兜住了一次」——而那会让守卫在真正该退役时退役不掉。
  const file = findPristineFile(path.join('dsh-app-boot', 'lib', 'index.js'));
  if (!file) { t.skip('无 pristine dsh-app-boot（查过 ' + describePristineRoots() + '）'); return; }
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(!src.includes('dsh-desktop guard'), 'pristine 树不得带我们的守卫，否则这条正证看的是打过补丁的字节');
  assert.match(src, /for \(const packageName of bundles\) try \{/, '逐 bundle 的 try 圈应在 pristine 里在场');
  assert.ok(src.includes('declares no dsh.bundle in its package.json'), '抛出点仍在那圈 try 内（抛即被收容）');
  assert.ok(src.includes('skippedBundles.push('), 'catch 应把坏包登记进 skippedBundles');
  assert.ok(src.includes('reportSkippedBundles('), '跳过要有 stderr 诊断（静默跳过等于没报错）');

  // 守卫的增量面（上游留在 try 之外的两处）也必须真的在场。
  const installed = path.join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
  if (!fs.existsSync(installed)) { t.skip('仓库 node_modules 未安装'); return; }
  const boot = fs.readFileSync(installed, 'utf8');
  assert.ok(boot.includes('function loadProfileManifestSafe'), '增量①：profile package.json 损坏 → 备份后按出厂模板重建');
  assert.ok(boot.includes('function loadProfileBundlesSafe'), '增量②：dsh.profile.bundles 非数组 → 告警空 bundles 而不是 for…of 击穿启动');
});

test('真实 dsh-app-boot：入口文件缺失（guard 覆盖不到的崩溃形状）由对账消除', async (t) => {
  const appBootIndex = path.join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
  const dshAnchor = path.join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  if (!fs.existsSync(appBootIndex) || !fs.existsSync(dshAnchor)) {
    t.skip('仓库 node_modules 未安装（npm install），跳过真实 dsh-app-boot 验证');
    return;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pbr-real2-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profileDir = path.join(home, 'profiles', 'web');
  // 声明 dsh.bundle.patch + main，但入口文件缺失：loadProfile 层面检查不到
  //（它只读补丁层），崩溃发生在 loader 激活期（plugin tree failed to load）。
  const missingEntry = path.join(profileDir, 'node_modules', '@dsh-external', 'ghost-entry');
  fs.mkdirSync(missingEntry, { recursive: true });
  fs.writeFileSync(path.join(missingEntry, 'package.json'), JSON.stringify({
    name: '@dsh-external/ghost-entry', version: '1.0.0', main: 'lib/index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(missingEntry, 'cordis.patch.yml'), '[]\n');
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: {},
    dsh: { profile: { bundles: [...CORES, '@dsh-external/ghost-entry'] } },
  }, null, 2) + '\n');
  const mod = await import(pathToFileURL(appBootIndex).href);
  // loadProfile 本身不报错（该形状在防护之外）；对账能识别并移除。
  reconcileProfileBundles(profileDir, {
    installAnchorDir: path.dirname(dshAnchor),
    coreNames: CORES,
    parsePatch: null,
    log: () => {},
  });
  assert.equal(readBrokenBundlesRecord(recordFile(profileDir)).entries['@dsh-external/ghost-entry'].code, BUNDLE_CHECK_CODES.ENTRY_MISSING);
  const profile = mod.loadProfile('dsh', 'web', dshAnchor, home);
  assert.deepEqual(profile.layers.map((l) => l.packageName), CORES);
});

test('createEntryListYamlParser: 与 dsh 方言同构（!!js 合法、损坏抛错）', () => {
  const parse = createEntryListYamlParser();
  assert.ok(typeof parse === 'function' || parse === null, 'js-yaml 存在时返回解析器，否则 null');
  if (parse) {
    assert.deepEqual(parse('[]\n'), []);
    const withJs = parse('- id: x\n  config: !!js "({a: 1})"\n');
    assert.equal(withJs[0].config.__jsExpr, '({a: 1})');
    assert.throws(() => parse('- id: [BAD\n'), '损坏 YAML 应抛错');
  }
});
