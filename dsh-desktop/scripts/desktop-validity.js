'use strict';

/**
 * 安装后防砖体检（参考 dsh-market/src/install.ts 的 validateAddedPlugins 思路）：
 * 逐个检查已装配的社区/配套插件包 —— dsh 清单字段、可加载补丁入口、
 * loader 条目 id 冲突（跨包重复会在下次启动触发 duplicate loader entry id 失败）。
 *
 * 官方核心（@deepseek-ai/* 与 INBOX 内置）由应用自身管理，不参与体检。
 * 纯只读：不写任何文件。
 */

const path = require('node:path');
const { analyzePatch } = require('./desktop-diagnostics');

/** 官方内置 bundle 包名（与 desktop-ordering 一致）。 */
const INBOX_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
]);

/**
 * 从补丁条目数组收集「注册 id」（与 dropBlocksByIds 同一语义）：
 *   · insert 数组内的 id —— 注册；
 *   · 纯注册直条目（除 id/name 外无任何其它键）的顶层 id —— 注册；
 *   · 覆盖条目（含 disabled/config/定向 insert 等任意其它键）不注册任何东西，
 *     算进去会产生「覆盖条目 vs 包注册」的假跨包冲突。
 * @param {Array<object>} entries analyzePatch 的 entries
 * @returns {string[]} 注册 id 列表（含重复）
 */
function collectRegisteredIds(entries) {
  const ids = [];
  for (const entry of entries || []) {
    if (!entry || typeof entry !== 'object') continue;
    if (Array.isArray(entry.insert)) {
      for (const it of entry.insert) {
        if (it && typeof it.id === 'string') ids.push(it.id);
      }
    } else if (typeof entry.id === 'string') {
      const keys = Object.keys(entry).filter((k) => k !== 'id' && k !== 'name');
      if (keys.length === 0) ids.push(entry.id);
    }
  }
  return ids;
}

/**
 * 收集体检候选包。
 * 范围 = ① profile bundle 清单中的社区包（解析到 profile node_modules 或 assets）
 *        + ② assets/plugins 内置配套（即使暂不在 bundle 清单）。
 * 官方核心（@deepseek-ai/* 与 INBOX 内置）与 npm 依赖垫片（不在 bundle 清单的
 * profile node_modules 包，如 cosmo kit/schemastery）不参与体检。
 * @param {string} profileDir
 * @param {string|null} coreDirDshAt
 * @param {string|null} assetsDir
 * @param {object} fs
 * @returns {Array<{name:string, dir:string, source:string}>}
 */
function collectPluginCandidates(profileDir, coreDirDshAt, assetsDir, fs = require('node:fs')) {
  // bundle 清单中的社区包名（与 desktop-ordering 同一语义）
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')); } catch { manifest = null; }
  const bundleNames = (manifest && manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles))
    ? manifest.dsh.profile.bundles.filter((n) => typeof n === 'string' && !INBOX_BUNDLES.has(n) && !n.startsWith('@deepseek-ai/'))
    : [];
  const found = new Map(); // 包名 → {dir, source}
  const add = (dir, source) => {
    const pkgFile = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgFile)) return;
    let name = null;
    try { name = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).name || null; } catch { /* 保留 dir 名 */ }
    const key = name || path.basename(dir);
    if (name && (name.startsWith('@deepseek-ai/') || INBOX_BUNDLES.has(name))) return;
    if (!found.has(key)) found.set(key, { name: key, dir, source });
  };
  // ① bundle 清单中的社区包（优先 profile node_modules，其次 assets 兜底）
  for (const name of bundleNames) {
    const parts = name.split('/');
    const profilePath = path.join(profileDir, 'node_modules', ...parts);
    const assetsPath = assetsDir ? path.join(assetsDir, ...parts) : null;
    if (fs.existsSync(profilePath)) {
      if (fs.existsSync(path.join(profilePath, 'package.json'))) add(profilePath, 'profile');
      else found.set(name, { name, dir: profilePath, source: 'profile' }); // 目录在但缺/坏 package.json → 必须进体检报错，防砖盲区
    } else if (assetsPath && fs.existsSync(assetsPath)) {
      if (fs.existsSync(path.join(assetsPath, 'package.json'))) add(assetsPath, 'assets');
      else found.set(name, { name, dir: assetsPath, source: 'assets' });
    }
  }
  // ② assets/plugins 内置配套（目录级扫描，覆盖插件已从清单移除仍在磁盘的情况）
  if (assetsDir && fs.existsSync(assetsDir)) {
    for (const entry of fs.readdirSync(assetsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const dir = path.join(assetsDir, entry.name);
        const pkgFile = path.join(dir, 'package.json');
        if (!fs.existsSync(pkgFile)) continue;
        let name = null;
        try { name = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).name || null; } catch { /* 保留 dir 名 */ }
        if (name && (name.startsWith('@deepseek-ai/') || INBOX_BUNDLES.has(name))) continue;
        const key = name || entry.name;
        if (found.has(key)) { found.get(key).source = found.get(key).source === 'profile' ? 'profile' : 'assets'; }
        else found.set(key, { name: key, dir, source: 'assets' });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 检查单个插件包的健康度。
 * @param {string} name 包名
 * @param {string} dir 包目录
 * @param {object} yaml js-yaml 方言加载器（null = 不可用）
 * @param {object} fs
 * @param {boolean} [listed] 是否在 dsh.profile.bundles 启动清单内（0.2.0-rc.2 起
 *   内核 loadProfileDirectory 逐 bundle try/catch：清单内缺 dsh.bundle 或缺
 *   dsh.bundle.patch 都不再击穿启动，而是把该 bundle 整体跳过并往 stderr 打一行
 *   `dsh: skipping profile bundle "X": <原因>`。后果从「整个应用起不来」变成
 *   「这个插件静默不加载」——仍是必须修的装配契约缺陷（我们发出去的插件哑掉），
 *   所以保持 error 等级，但正文按真实行为写，不再声称 fail-loud）
 * @returns {{name:string, issues:Array<{level:string, text:string}>, ids:string[], patchOk:boolean}}
 */
function checkPluginPackage(name, dir, yaml, fs = require('node:fs'), listed = false) {
  const issues = [];
  const ids = [];
  let patchOk = true;
  const pkgFile = path.join(dir, 'package.json');
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  } catch (err) {
    issues.push({ level: 'error', text: `package.json 缺失或无法解析: ${(err && err.message) || err}` });
    return { name, issues, ids, patchOk: false };
  }
  const dsh = pkg && pkg.dsh;
  if (!dsh || (typeof dsh !== 'object')) {
    issues.push(listed
      ? { level: 'error', text: '在启动清单（dsh.profile.bundles）中但未声明 dsh 插件清单（dsh.bundle / dsh.client）——rc.2 起下次启动不再 fail-loud，而是跳过该 bundle 并在 stderr 打 skipping profile bundle "X": … declares no dsh.bundle，插件静默不加载（不牵连其余 bundle），请从清单移除或补声明' }
      : { level: 'warning', text: '未声明 dsh 插件清单（dsh.bundle / dsh.client），可能不是可加载插件' });
  } else {
    if (listed && !(dsh.bundle && typeof dsh.bundle === 'object' && typeof dsh.bundle.patch === 'string')) {
      issues.push({ level: 'error', text: '在启动清单（dsh.profile.bundles）中但未声明 dsh.bundle.patch——rc.2 起下次启动不再 fail-loud，而是跳过该 bundle 并在 stderr 打 skipping profile bundle "X": <原因>（缺 dsh.bundle 报 declares no dsh.bundle；patch 非路径/路径数组报 dsh.bundle.patch must be a file path or a list of file paths），插件静默不加载，请从清单移除或补声明' });
    }
    if (dsh.bundle && typeof dsh.bundle === 'object') {
      if (typeof dsh.bundle.patch === 'string') {
        // 路径越界围栏（与 profile-bundle-heal 的 PATCH_OUTSIDE 同语义）：
        // 声明路径必须仍落在包目录内，防 `../../x` 越界读取任意本机文件。
        const patchRel = dsh.bundle.patch;
        const resolvedPatch = path.resolve(dir, patchRel);
        const dirRoot = path.resolve(dir) + path.sep;
        if (!resolvedPatch.startsWith(dirRoot)) {
          issues.push({ level: 'error', text: `声明的补丁路径越界: ${patchRel}` });
          patchOk = false;
        } else {
          const patchFile = resolvedPatch;
          if (!fs.existsSync(patchFile)) {
            issues.push({ level: 'error', text: `声明的补丁文件不存在: ${patchRel}` });
            patchOk = false;
          } else {
            const parsed = analyzePatch(patchFile, yaml, fs);
            if (!parsed.parseOk) {
              issues.push({ level: 'error', text: `补丁解析失败: ${parsed.parseError || '未知错误'}` });
              patchOk = false;
            } else {
              ids.push(...collectRegisteredIds(parsed.entries));
              for (const dup of parsed.duplicateIds) {
                issues.push({ level: 'error', text: `补丁内重复的 loader 条目 id「${dup.id}」（${dup.count} 次）` });
              }
            }
          }
        }
      }
      if (typeof dsh.bundle.client === 'string' && dsh.bundle.client) {
        const clientFile = path.resolve(dir, dsh.bundle.client);
        if (!clientFile.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(clientFile)) {
          issues.push({ level: 'warning', text: `声明的客户端入口不存在或路径越界: ${dsh.bundle.client}` });
        }
      }
    }
    if (dsh.client && typeof dsh.client === 'object') {
      const clientFile = typeof dsh.client.client === 'string' ? dsh.client.client : null;
      if (clientFile) {
        const resolvedClient = path.resolve(dir, clientFile);
        if (!resolvedClient.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(resolvedClient)) {
          issues.push({ level: 'warning', text: `声明的客户端入口不存在或路径越界: ${clientFile}` });
        }
      }
    }
  }
  // 未声明 patch 时自动探测 cordis.patch.yml / cordis.yml（与 boot 行为一致）
  if (!(dsh && dsh.bundle && typeof dsh.bundle.patch === 'string')) {
    for (const probe of ['cordis.patch.yml', 'cordis.yml']) {
      const probeFile = path.join(dir, probe);
      if (fs.existsSync(probeFile)) {
        const parsed = analyzePatch(probeFile, yaml, fs);
        if (!parsed.parseOk) {
          issues.push({ level: 'error', text: `${probe} 解析失败: ${parsed.parseError || '未知错误'}` });
          patchOk = false;
        } else {
          ids.push(...collectRegisteredIds(parsed.entries));
        }
        break;
      }
    }
  }
  // 声明了 main 但入口文件缺失。对「在启动清单中」的 bundle 这是致命问题：
  // 装配时入口文件缺失会直接导致服务重启失败/Web UI 不可用（issue #65/#76），
  // 必须判为 error 并纳入总结论；未列入清单的包才降级为 warning。
  if (typeof pkg.main === 'string' && pkg.main) {
    const resolvedMain = path.resolve(dir, pkg.main);
    const mainOk = resolvedMain.startsWith(path.resolve(dir) + path.sep) && fs.existsSync(resolvedMain);
    if (!mainOk) {
      issues.push(listed
        ? { level: 'error', text: `在启动清单中但 main 入口不存在或路径越界: ${pkg.main}——装配必然失败，请构建产物或从清单移除该 bundle` }
        : { level: 'warning', text: `main 入口不存在或路径越界: ${pkg.main}` });
    }
  }
  return { name, issues, ids, patchOk };
}

/**
 * 全量防砖体检。
 * @param {string} profileDir
 * @param {string|null} coreDirDshAt
 * @param {string|null} assetsDir
 * @param {object} yaml js-yaml 方言加载器
 * @param {object} fs
 * @returns {object} { ok, checked, conflicts, contractViolations, manifestError, summary:{errors, warnings} }
 *   contractViolations = 在启动清单内但缺 dsh.bundle.patch 声明的包名（可一键移除）
 *   manifestError = profile package.json 损坏/不可读时的描述（正常为 null）
 */
function validatePlugins(profileDir, coreDirDshAt, assetsDir, yaml, fs = require('node:fs')) {
  const manifestFile = path.join(profileDir, 'package.json');
  let listedSet = new Set();
  let manifestError = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const profileMeta = manifest && manifest.dsh && manifest.dsh.profile ? manifest.dsh.profile : null;
    // issue #99 补强（PR #102 增量）：bundles 字段存在但非数组 = 结构损坏，
    // 与 manifest 读取失败同级的假绿变体（静默置空会让清单内缺陷全部降级为
    // warning）；字段缺失则视为合法空清单，避免新装 profile 误报。
    if (profileMeta && !Array.isArray(profileMeta.bundles)) {
      manifestError = 'dsh.profile.bundles 不是数组（实际类型: ' + typeof profileMeta.bundles + '）';
    } else {
      const bundles = profileMeta ? profileMeta.bundles : [];
      listedSet = new Set(bundles.filter((n) => typeof n === 'string'));
    }
  } catch (err) {
    // 区分「无 manifest」（正常，listedSet 为空）与「manifest 损坏/不可读」
    // （体检必须显式失败而不是静默假绿——issue #99）。
    if (fs.existsSync(manifestFile)) {
      manifestError = `profile package.json 无法解析: ${(err && err.message) || err}`;
    }
  }
  const checked = collectPluginCandidates(profileDir, coreDirDshAt, assetsDir, fs).map((c) => {
    const result = checkPluginPackage(c.name, c.dir, yaml, fs, listedSet.has(c.name));
    return {
      name: c.name, dir: c.dir, source: c.source, listed: listedSet.has(c.name),
      issues: result.issues, ids: result.ids, patchOk: result.patchOk,
    };
  });
  // 汇总 loader id 归属：包 + profile 主 patch
  const ownerOf = new Map(); // id → [{owner, count}]
  for (const item of checked) {
    const counted = new Map();
    for (const id of item.ids) counted.set(id, (counted.get(id) || 0) + 1);
    for (const [id, count] of counted) {
      if (!ownerOf.has(id)) ownerOf.set(id, []);
      ownerOf.get(id).push({ owner: item.name, count });
    }
  }
  const profilePatch = path.join(profileDir, 'cordis.patch.yml');
  if (fs.existsSync(profilePatch)) {
    const parsed = analyzePatch(profilePatch, yaml, fs);
    if (parsed.parseOk) {
      // 与包一致：只把「注册 id」（insert 数组内 id + 纯注册直条目）计入跨包
      // 冲突。覆盖条目（disabled/config/定向 insert）不注册任何东西，算进去
      // 会产生「覆盖条目 vs 包注册」的假冲突（如 harness-pet 默认禁用条目）。
      const counted = new Map();
      const bump = (id) => counted.set(id, (counted.get(id) || 0) + 1);
      for (const id of collectRegisteredIds(parsed.entries)) bump(id);
      for (const [id, count] of counted) {
        if (!ownerOf.has(id)) ownerOf.set(id, []);
        ownerOf.get(id).push({ owner: 'profile/cordis.patch.yml', count });
      }
    }
  }
  // 跨包冲突（同一 id 出现在 ≥2 个不同 owner）
  const conflicts = [];
  for (const [id, owners] of ownerOf) {
    if (owners.length > 1) {
      conflicts.push({ id, owners: owners.map((o) => o.owner), total: owners.reduce((s, o) => s + o.count, 0) });
    }
  }
  conflicts.sort((a, b) => a.id.localeCompare(b.id));
  const errors = checked.reduce((s, c) => s + c.issues.filter((i) => i.level === 'error').length, 0) + conflicts.length + (manifestError ? 1 : 0);
  const warnings = checked.reduce((s, c) => s + c.issues.filter((i) => i.level === 'warning').length, 0);
  const contractViolations = checked
    .filter((c) => c.listed && c.issues.some((i) => i.level === 'error' && /启动清单/.test(i.text)))
    .map((c) => c.name);
  return { ok: errors === 0, checked, conflicts, contractViolations, manifestError, summary: { errors, warnings } };
}

module.exports = {
  INBOX_BUNDLES,
  collectPluginCandidates,
  checkPluginPackage,
  validatePlugins,
};
