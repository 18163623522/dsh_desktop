'use strict';

// ---------------------------------------------------------------------------
// profile 装配链防护（main.js applyProfileBundleGuard 与
// scripts/sync-companion-plugins.js 共用）：把 dsh 对 profile 数据的
// fail-loud 启动语义收口为「诊断 + 降级该层 + 继续启动」。靶面随内核换代
// 收口到 @deepseek-ai/dsh-app-boot/lib/index.js（0.2.0-rc.2 起补丁层装配集中
// 到 readProfilePatches，profile-boot-*.js 形态消失）。覆盖的崩溃形态：
//   1. profiles/<name>/package.json 读不出 / JSON 损坏 / 顶层非对象；
//   2. manifest 的 dsh.profile.bundles 不是数组；
//   3. profile 自己的 cordis.patch.yml 与家级 $DSH_HOME/cordis.patch.yml 损坏
//      —— 同时覆盖启动与 dsh-hmr 热重载路径。
//   （bundle 层本身缺包 / 无 dsh.bundle / cordis.patch.yml 解析失败这一类，
//    rc.2 已在内核里原生 try/catch + skippedBundles，见 applyAppBootBundleGuard
//    上方注释，故本模块不再重复防护。）
//
// 本模块不持有任何 dsh 安装路径，只提供纯函数：幂等的源码字符串变换（锚点
// 不匹配时原样返回）、bundle 目录只读校验与原子写；具体文件定位与写入时机由
// main.js / 同步脚本决定。dsh 版本更新后锚点失配时，防护会跳过并在日志告警
// （与既有运行时补丁一致），下次启动重试。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

/** dsh-app-boot bundle 防护注入代码的幂等标记。 */
const PROFILE_BUNDLE_GUARD_MARKER = 'dsh-desktop guard: a broken profile bundle must not brick';

// ---------------------------------------------------------------------------
// bundle 包描述解析（纯函数）
// ---------------------------------------------------------------------------

/**
 * 取 package.json 声明的 dsh.bundle.patch 相对路径；未声明 / 空串 / 非字符串
 * 一律返回空串（调用方按「不是可装配 bundle」处理）。
 */
function bundlePatchRel(pkg) {
  const patch = pkg && pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
  return typeof patch === 'string' && patch.trim() !== '' ? patch : '';
}

/**
 * 取 bundle 包的入口文件（exports["."] 优先，其次 main）；解析不出返回空串。
 * dsh 装配 bundle 时会 import 该入口，入口文件缺失即整棵插件树加载失败。
 * 契约（与既有单测一致）：exports["."] 是条件导出对象但没有字符串
 * import/default 时，Node 无法 import 该包，入口判定为空（不回落到 main）；
 * 且条件导出值只允许字符串——直接返回对象会让调用方 path.join 抛 TypeError。
 */
function bundleEntryOf(pkg) {
  const ex = pkg && pkg.exports;
  if (ex && typeof ex === 'object' && !Array.isArray(ex)) {
    const dot = ex['.'];
    if (typeof dot === 'string') return dot;
    if (dot && typeof dot === 'object') {
      if (typeof dot.import === 'string') return dot.import;
      if (typeof dot.default === 'string') return dot.default;
      return '';
    }
  }
  return (pkg && typeof pkg.main === 'string') ? pkg.main : '';
}

// ---------------------------------------------------------------------------
// 落盘 bundle 目录校验（同步写入侧防呆）
// ---------------------------------------------------------------------------

/**
 * 结构化校验失败码（inspectBundleDir 与 scripts/lib/profile-reconcile.js 的
 * validateBundleEntry 共用；中文 reason 保持与 verifyBundleDir 既有文案逐字
 * 一致——含上游新增的 client bundle 入口校验文案，历史调用方与单测断言不受
 * 影响）。
 */
const BUNDLE_CHECK_CODES = {
  /** 登记项不是非空字符串（validateBundleEntry 前置判定）。 */
  INVALID_NAME: 'INVALID_NAME',
  /** 双锚点（dsh 安装 / profile node_modules）均解析不到包（validateBundleEntry）。 */
  UNRESOLVABLE: 'UNRESOLVABLE',
  /** package.json 不可读 / 不是合法 JSON。 */
  PACKAGE_JSON_INVALID: 'PACKAGE_JSON_INVALID',
  /** package.json 未声明 dsh.bundle.patch（普通库或仅客户端 bundle）。 */
  NO_BUNDLE_DECL: 'NO_BUNDLE_DECL',
  /** 补丁层相对路径越出包目录。 */
  PATCH_OUTSIDE: 'PATCH_OUTSIDE',
  /** 补丁层文件不存在。 */
  PATCH_MISSING: 'PATCH_MISSING',
  /** 补丁层存在但无法按 dsh entry-list 方言解析（或顶层非数组）。 */
  PATCH_UNPARSEABLE: 'PATCH_UNPARSEABLE',
  /** 入口文件相对路径越出包目录。 */
  ENTRY_OUTSIDE: 'ENTRY_OUTSIDE',
  /** 入口文件不存在。 */
  ENTRY_MISSING: 'ENTRY_MISSING',
  /** client bundle 入口（exports["./client"]）相对路径越出包目录。 */
  CLIENT_ENTRY_OUTSIDE: 'CLIENT_ENTRY_OUTSIDE',
  /** client bundle 入口（exports["./client"]）文件不存在。 */
  CLIENT_ENTRY_MISSING: 'CLIENT_ENTRY_MISSING',
};

/**
 * 判定一次 entry-list YAML 解析结果是否满足 dsh 的补丁层契约
 * （dsh-app-boot parsePatchList）：顶层必须是数组，且每个条目必须是映射
 * （非 null 对象、非数组）。与官方判定逐字同构——只检查 Array.isArray 会
 * 放过「顶层数组但条目是标量/字符串/嵌套数组/null」的畸形文件，dsh 装配时
 * 仍会 fail-loud（"must be a mapping"）。inspectBundleDir 与 main.js 的
 * healHomePatch 共用本判定。
 * @param {unknown} parsed entry-list YAML 解析结果
 * @returns {boolean} 满足 dsh 补丁层契约时为 true
 */
function isPatchListValid(parsed) {
  if (!Array.isArray(parsed)) return false;
  return parsed.every((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry));
}

/**
 * 结构化校验一个已落盘的 bundle 目录（唯一实现）：package.json 可解析、
 * 声明了 dsh.bundle.patch、补丁层存在且（提供解析器时）可解析、入口文件
 * 存在；声明了 exports["./client"] 时 client bundle 入口也必须存在。任一
 * 不满足返回 { ok:false, code, reason } —— 同步方必须按「源缺失」处理
 * （不注册为 profile bundle），否则 dsh 启动时必然崩溃。verifyBundleDir
 * 与本仓库 scripts/lib/profile-reconcile.js 的 validateBundleEntry 共用本函数，
 * 保证各调用方的判定语义一致。
 * @param {string} dir bundle 包目录（绝对路径）
 * @param {(content: string) => unknown} [parsePatch] dsh entry-list 方言解析器；
 *   提供时补丁层必须可解析且为合法 entry-list（顶层数组 + 每项为映射，与
 *   dsh-app-boot parsePatchList 的契约一致）；null 跳过该检查（调用方无 yaml
 *   依赖时的降级，与 healProfilePatch 的既有降级语义一致）。
 * @returns {{ ok: boolean, code: string, reason: string, patchPath?: string }}
 */
function inspectBundleDir(dir, parsePatch) {
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch (err) {
    return { ok: false, code: BUNDLE_CHECK_CODES.PACKAGE_JSON_INVALID, reason: 'package.json 不可读或不是合法 JSON: ' + ((err && err.message) || err) };
  }
  const patchRel = bundlePatchRel(pkg);
  if (!patchRel) return { ok: false, code: BUNDLE_CHECK_CODES.NO_BUNDLE_DECL, reason: 'package.json 未声明 dsh.bundle.patch' };
  // 路径归一化围栏：补丁层必须仍落在 bundle 目录内（防 `../../x` 越界读取）。
  const patchFile = path.resolve(dir, patchRel);
  const dirRoot = path.resolve(dir) + path.sep;
  if (!patchFile.startsWith(dirRoot)) return { ok: false, code: BUNDLE_CHECK_CODES.PATCH_OUTSIDE, reason: '补丁层路径越界: ' + patchRel };
  if (!fs.existsSync(patchFile)) return { ok: false, code: BUNDLE_CHECK_CODES.PATCH_MISSING, reason: '补丁层缺失: ' + patchRel };
  if (typeof parsePatch === 'function') {
    try {
      const parsed = parsePatch(fs.readFileSync(patchFile, 'utf8'));
      if (!Array.isArray(parsed)) {
        return { ok: false, code: BUNDLE_CHECK_CODES.PATCH_UNPARSEABLE, reason: '补丁层不是顶层 YAML 数组: ' + patchRel };
      }
      if (!parsed.every((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry))) {
        return { ok: false, code: BUNDLE_CHECK_CODES.PATCH_UNPARSEABLE, reason: '补丁层条目不是映射（dsh 要求顶层数组每项为映射）: ' + patchRel };
      }
    } catch (err) {
      return { ok: false, code: BUNDLE_CHECK_CODES.PATCH_UNPARSEABLE, reason: '补丁层无法解析: ' + patchRel + '（' + ((err && err.message) || err) + '）' };
    }
  }
  const entry = bundleEntryOf(pkg);
  if (entry) {
    const entryFile = path.resolve(dir, entry);
    if (!entryFile.startsWith(dirRoot)) return { ok: false, code: BUNDLE_CHECK_CODES.ENTRY_OUTSIDE, reason: '入口文件路径越界: ' + entry };
    if (!fs.existsSync(entryFile)) return { ok: false, code: BUNDLE_CHECK_CODES.ENTRY_MISSING, reason: '入口文件缺失: ' + entry };
    // 入口必须是普通文件（符号链接经 statSync 跟随解析）：dsh Loader 用 ESM
    // import() 激活入口，指向目录的 main/exports 会在激活期抛
    // ERR_UNSUPPORTED_DIR_IMPORT（防护覆盖不到的崩溃形状），存在性检查会放过。
    let entryStat = null;
    try { entryStat = fs.statSync(entryFile); } catch { /* 不可读按缺失处理 */ }
    if (!entryStat || !entryStat.isFile()) {
      return { ok: false, code: BUNDLE_CHECK_CODES.ENTRY_MISSING, reason: '入口文件缺失或不是普通文件: ' + entry };
    }
  }
  // client bundle 入口（exports["./client"] 字符串声明）：client-modules 装配时
  // 按该路径读取客户端 bundle，缺失会让整个 client 模块注册 fail-loud
  // （MissingClientBundleError → dsh web 启动失败）。同步方必须把 client
  // 目录一并落盘（companion-profile.js 的目录同步清单含 client）。
  const clientRel = pkg && pkg.exports && typeof pkg.exports === 'object' && !Array.isArray(pkg.exports)
    && typeof pkg.exports['./client'] === 'string' ? pkg.exports['./client'] : '';
  if (clientRel) {
    const clientFile = path.resolve(dir, clientRel);
    if (!clientFile.startsWith(dirRoot)) return { ok: false, code: BUNDLE_CHECK_CODES.CLIENT_ENTRY_OUTSIDE, reason: 'client 入口路径越界: ' + clientRel };
    if (!fs.existsSync(clientFile)) return { ok: false, code: BUNDLE_CHECK_CODES.CLIENT_ENTRY_MISSING, reason: 'client 入口缺失: ' + clientRel };
  }
  return { ok: true, code: '', reason: '', patchPath: patchFile };
}

/**
 * 校验一个已落盘的 bundle 目录（兼容包装）：package.json 可解析、声明了
 * dsh.bundle.patch、补丁层与入口文件都存在；声明了 exports["./client"] 时
 * client bundle 入口也必须存在。任一不满足返回 { ok:false, reason }。
 * 判定语义与文案委托给 inspectBundleDir（不检查补丁层可解析性，历史契约）。
 */
function verifyBundleDir(dir) {
  const check = inspectBundleDir(dir, null);
  return { ok: check.ok, reason: check.reason };
}

/**
 * 沿 Node 的 node_modules 父目录查找顺序探测包目录（等价于
 * resolveBundleDir 的第一锚点语义，且不依赖包导出 ./package.json）。
 * 找不到返回空串。
 */
function packageDirUpward(anchorDir, packageName) {
  const parts = packageName.split('/');
  let dir = anchorDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...parts);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
}

/**
 * 扫描 profile node_modules 中实际落盘且可装配的第三方 bundle 包（issue #48
 * 数据恢复用：manifest 重置后用户手动安装的插件仍留在磁盘上，据此恢复登记）。
 * 只返回通过 verifyBundleDir 完整校验的包；excludeNames（核心 + 配套插件名）
 * 与未声明 dsh.bundle 的普通依赖一律排除。结果按包名排序保证确定性。
 * @returns [{ name: string, version: string }]
 */
function scanProfileBundles(modulesDir, excludeNames) {
  const found = [];
  let top;
  try { top = fs.readdirSync(modulesDir, { withFileTypes: true }); } catch { return found; }
  const candidates = [];
  for (const entry of top) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('@')) {
      let scoped;
      try { scoped = fs.readdirSync(path.join(modulesDir, entry.name), { withFileTypes: true }); } catch { continue; }
      for (const sub of scoped) {
        if (!sub.isDirectory()) continue;
        candidates.push({ name: entry.name + '/' + sub.name, dir: path.join(modulesDir, entry.name, sub.name) });
      }
    } else {
      candidates.push({ name: entry.name, dir: path.join(modulesDir, entry.name) });
    }
  }
  candidates.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const { name, dir } of candidates) {
    if (excludeNames.has(name)) continue;
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
    if (!pkg || typeof pkg !== 'object' || typeof pkg.name !== 'string' || pkg.name === '') continue;
    if (!bundlePatchRel(pkg)) continue;
    // 入口 / 补丁层缺失的包即使恢复登记也会被启动防护跳过，一律不登记。
    if (!verifyBundleDir(dir).ok) continue;
    found.push({ name: pkg.name, version: typeof pkg.version === 'string' ? pkg.version : '' });
  }
  return found;
}

/**
 * 把扫描到的第三方 bundle 合并回 profile manifest：bundles 追加缺失项（保持
 * 既有顺序），dependencies 补回包名（用包内声明的版本号；git 依赖等非常规
 * 来源无法还原原始 spec，登记版本号可保证后续 pnpm 安装不把它当孤儿包清理）。
 * @returns 本次实际恢复的包名列表。
 */
function recoverManifestBundles(manifest, found) {
  // 防御非法入参：调用方（main.js）虽有多重前置校验，本函数自身不抛错
  // 的契约让其它调用方（单测/同步脚本）不必重复兜底。
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return [];
  if (!manifest.dsh || typeof manifest.dsh !== 'object') manifest.dsh = {};
  if (!manifest.dsh.profile || typeof manifest.dsh.profile !== 'object') manifest.dsh.profile = {};
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
  const dependencies = (manifest.dependencies && typeof manifest.dependencies === 'object' && !Array.isArray(manifest.dependencies))
    ? manifest.dependencies : {};
  const recovered = [];
  for (const item of found) {
    if (bundles.includes(item.name)) continue;
    bundles.push(item.name);
    if (typeof dependencies[item.name] !== 'string' || dependencies[item.name] === '') dependencies[item.name] = item.version;
    recovered.push(item.name);
  }
  manifest.dsh.profile.bundles = bundles;
  if (recovered.length > 0) manifest.dependencies = dependencies;
  return recovered;
}

/**
 * 原子写（临时文件 + rename），避免与 dsh 的 HMR 观察者撕裂读。
 * 唯一实现在 scripts/lib/patch-io.js；这里转发导出，保证既有引用方
 * （sync-companion-plugins.js 等）与本仓库其它原子写共用同一实现。
 */
const { writeFileAtomic } = require('./scripts/lib/patch-io');

// ---------------------------------------------------------------------------
// @deepseek-ai/dsh-app-boot/lib/index.js 变换
// ---------------------------------------------------------------------------

// profile 自身 manifest 的两个严格读取点（built 文件为制表符缩进）。
// 0.2.0-rc.2 换代判定：逐 bundle 装配的容错已由上游原生实装——
// loadProfileDirectory 改成 `for (const packageName of bundles) try { … } catch {
// skippedBundles.push(...) }`，并以 reportSkippedBundles 打到 stderr。所以本守卫
// 原本替换的整段 layers.map() 已不存在，收缩为只护上游仍留在 try 之外的两处：
//   ① profile 自己的 package.json 损坏（loadProfile 的 normalizeShippedProfile 与
//      loadProfileDirectory 的 bundles 读取都在 try 头之前，抛错即启动失败页）；
//   ② `dsh.profile.bundles` 被写成非数组（for…of 在 try 头，同样击穿启动）。
const APP_BOOT_PROFILE_MANIFEST_ANCHOR = '\tnormalizeShippedProfile(name, dir, readProfileManifest(binName, dir));';
const APP_BOOT_BUNDLES_ANCHOR = '\tconst bundles = readProfileManifest(binName, dir).dsh?.profile?.bundles ?? [];';

// 注入位置：composeEntries 函数声明前（模块作用域内所有被用符号均可见）。
const APP_BOOT_INSERT_ANCHOR = 'function composeEntries(layers, warn = () => {}) {';

const APP_BOOT_GUARD_CODE = [
  '/** dsh-desktop guard: a broken profile bundle must not brick the surface.',
  ' * 0.2.0-rc.2 起逐 bundle 的容错由上游原生实装（loadProfileDirectory 内',
  ' * `for (const packageName of bundles) try {…} catch { skippedBundles.push(…) }` +',
  ' * reportSkippedBundles），本守卫只补它仍留在 try 之外的两处：profile 自己的',
  ' * package.json 损坏（备份后按出厂模板重建，原件留在 `.broken-` 备份里），',
  ' * 以及 `dsh.profile.bundles` 被写成非数组（for…of 会直接击穿启动）。 */',
  'function loadProfileManifestSafe(binName, name, dir) {',
  '\ttry {',
  '\t\treturn readProfileManifest(binName, dir);',
  '\t} catch (error) {',
  '\t\tconst file = join(dir, "package.json");',
  '\t\tlet backup = null;',
  '\t\ttry {',
  '\t\t\tif (existsSync(file)) {',
  '\t\t\t\tbackup = `' + '${file}.broken-${Date.now()}`' + ';',
  '\t\t\t\twriteFileSync(backup, readFileSync(file, "utf8"));',
  '\t\t\t}',
  '\t\t\tconst manifest = {',
  '\t\t\t\tname: `' + 'dsh-profile-${basename(dir)}`' + ',',
  '\t\t\t\tprivate: true,',
  '\t\t\t\tdependencies: {},',
  '\t\t\t\tdsh: { profile: { bundles: [...(PROFILE_TEMPLATES[name] ?? DEFAULT_PROFILE_BUNDLES)] } }',
  '\t\t\t};',
  '\t\t\twriteFileSync(file, JSON.stringify(manifest, void 0, 2) + "\\n");',
  '\t\t} catch (recoveryError) {',
  '\t\t\tthrow new Error(`' + '${binName}: profile manifest ${file} is unusable (${String(error?.message ?? error)}) and recovery failed (${String(recoveryError?.message ?? recoveryError)})`' + ');',
  '\t\t}',
  '\t\tprocess.stderr.write(`' + '${binName}: profile manifest ${file} failed to load (${String(error?.message ?? error)})${backup !== null ? `; the broken file was backed up to ${backup}` : ""}; the profile was re-initialized with its shipped bundle template\\n`' + ');',
  '\t\treturn readProfileManifest(binName, dir);',
  '\t}',
  '}',
  'function loadProfileBundlesSafe(binName, name, dir) {',
  '\tconst bundles = loadProfileManifestSafe(binName, name, dir).dsh?.profile?.bundles ?? [];',
  '\tif (Array.isArray(bundles)) return bundles;',
  '\tprocess.stderr.write(`' + '${binName}: profile ${JSON.stringify(name)}: dsh.profile.bundles must be an array (got ${typeof bundles}); booting without bundle layers — fix the profile manifest or run \'dsh plugin --profile ${name} install\'\\n`' + ');',
  '\treturn [];',
  '}',
].join('\n');

/**
 * 改写 dsh-app-boot/lib/index.js：profile 自身 manifest 的两处严格读取换成自愈读取
 * （损坏备份 + 按出厂模板重建 + 继续），bundles 非数组时降级为空层。
 * 已注入或任一锚点失配时原样返回。
 * @returns {{ changed: boolean, src: string }}
 */
function applyAppBootBundleGuard(src) {
  if (typeof src !== 'string') return { changed: false, src };
  if (src.includes(PROFILE_BUNDLE_GUARD_MARKER)) return { changed: false, src };
  if (
    !src.includes(APP_BOOT_PROFILE_MANIFEST_ANCHOR)
    || !src.includes(APP_BOOT_BUNDLES_ANCHOR)
    || !src.includes(APP_BOOT_INSERT_ANCHOR)
  ) return { changed: false, src };
  let out = src
    .replace(APP_BOOT_PROFILE_MANIFEST_ANCHOR, '\tnormalizeShippedProfile(name, dir, loadProfileManifestSafe(binName, name, dir));')
    .replace(APP_BOOT_BUNDLES_ANCHOR, '\tconst bundles = loadProfileBundlesSafe(binName, basename(dir), dir);');
  out = out.replace(APP_BOOT_INSERT_ANCHOR, APP_BOOT_GUARD_CODE + '\n\n' + APP_BOOT_INSERT_ANCHOR);
  return { changed: true, src: out };
}

// ---------------------------------------------------------------------------
// dsh-app-boot/lib/index.js 变换（用户补丁层自愈）
// ---------------------------------------------------------------------------

// 0.2.0-rc.2 把补丁层装配收口进 app-boot 的 readProfilePatches：profile 自己的
// cordis.patch.yml 与家级 $DSH_HOME/cordis.patch.yml 都由 loadOptionalPatches 直读，
// 而它对「读得出但 YAML 解析失败 / 顶层不是数组 / 元素不是映射」一律 throw
// （只有 ENOENT 返回 undefined）。这两个文件是**用户数据**：用户手改缩进打错一次，
// 过去就是 dsh web exit 1 进启动失败页，而一次致命启动又会让 sanitizeProfile 把
// profile 的补丁层改名抹掉（我们的包一起没了）。这里换成自愈读取——损坏文件备份为
// <file>.broken-<ts>、重写为注释 + 空列表、告警后继续启动。
// readProfilePatches 同时是 dsh-hmr 的进口（dsh-hmr/lib/index.js:8 import、:369 调用），
// 所以一处收口覆盖「启动 + 热重载」两条路；0.1.6 及更早的 profile-boot-*.js
// （homePatchPath / composeLive 形态）随内核换代删除，本节即其继任者。
// 幂等标记 = function safeLoadUserPatchLayer。名字必须与 patch-adapters 里的
// loadUserPatchLayer（补丁层另一处防护）互不为子串，否则两条补丁会互相吞掉。
const APP_BOOT_PATCH_LAYER_GUARD_MARKER = 'function safeLoadUserPatchLayer';
// 两处严格读取（实测 0.2.0-rc.2 各 hits=1，0.1.6 各 hits=0——该函数是 rc.2 新增）。
const APP_BOOT_PATCH_LAYER_USER_ANCHOR = '\t\t...initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? [],';
const APP_BOOT_PATCH_LAYER_HOME_ANCHOR = '\t\t...loadOptionalPatches(binName, join(context.home, "cordis.patch.yml")) ?? [],';
// 注入点：readProfilePatches 定义行之前（hits=1）。与 bundle 防护的 composeEntries
// 注入点分处不同区段，两条补丁任意顺序叠加都不互相破坏。
const APP_BOOT_PATCH_LAYER_INSERT_ANCHOR = 'function readProfilePatches(binName, context, initialProfile) {';

const APP_BOOT_PATCH_LAYER_GUARD_CODE = [
  '/** dsh-desktop guard: the profile patch layer and the home-level patch layer',
  ' * (`$DSH_HOME/cordis.patch.yml`) are user-owned data; a broken file must not',
  ' * brick the boot or a hot-reload. Back the broken file up, reset the layer to',
  ' * an empty list, warn, and continue without it. */',
  'function safeLoadUserPatchLayer(binName, file) {',
  '\ttry {',
  '\t\treturn loadOptionalPatches(binName, file) ?? [];',
  '\t} catch (error) {',
  '\t\ttry {',
  '\t\t\tconst backup = `' + '${file}.broken-${Date.now()}`' + ';',
  '\t\t\twriteFileSync(backup, readFileSync(file, "utf8"));',
  '\t\t\twriteFileSync(file, "# recovered by dsh: the previous content failed to parse and was moved to\\n# " + backup + "\\n[]\\n");',
  '\t\t} catch {}',
  '\t\tprocess.stderr.write(`' + '${binName}: ${file} failed to parse (${String(error?.message ?? error)}); the broken file was moved aside and the profile booted without this patch layer\\n`' + ');',
  '\t\treturn [];',
  '\t}',
  '}',
].join('\n');

/**
 * 改写 dsh-app-boot/lib/index.js：用户拥有的两个补丁层文件（profile 自己的
 * cordis.patch.yml 与家级 cordis.patch.yml）换成自愈读取（损坏备份 + 重置为空层 +
 * 继续）。已注入或任一锚点失配时原样返回。
 * @returns {{ changed: boolean, src: string }}
 */
function applyAppBootPatchLayerGuard(src) {
  if (typeof src !== 'string') return { changed: false, src };
  if (src.includes(APP_BOOT_PATCH_LAYER_GUARD_MARKER)) return { changed: false, src };
  if (
    !src.includes(APP_BOOT_PATCH_LAYER_USER_ANCHOR)
    || !src.includes(APP_BOOT_PATCH_LAYER_HOME_ANCHOR)
    || !src.includes(APP_BOOT_PATCH_LAYER_INSERT_ANCHOR)
  ) return { changed: false, src };
  let out = src
    .replace(APP_BOOT_PATCH_LAYER_USER_ANCHOR, '\t\t...initialProfile?.patches ?? safeLoadUserPatchLayer(binName, context.patchPath),')
    .replace(APP_BOOT_PATCH_LAYER_HOME_ANCHOR, '\t\t...safeLoadUserPatchLayer(binName, join(context.home, "cordis.patch.yml")),');
  out = out.replace(APP_BOOT_PATCH_LAYER_INSERT_ANCHOR, APP_BOOT_PATCH_LAYER_GUARD_CODE + '\n\n' + APP_BOOT_PATCH_LAYER_INSERT_ANCHOR);
  return { changed: true, src: out };
}

module.exports = {
  PROFILE_BUNDLE_GUARD_MARKER,
  APP_BOOT_PATCH_LAYER_GUARD_MARKER,
  BUNDLE_CHECK_CODES,
  bundlePatchRel,
  bundleEntryOf,
  inspectBundleDir,
  isPatchListValid,
  verifyBundleDir,
  packageDirUpward,
  scanProfileBundles,
  recoverManifestBundles,
  writeFileAtomic,
  applyAppBootBundleGuard,
  applyAppBootPatchLayerGuard,
};
