'use strict';

// validate-pin.js — 兼容层 M1 骨架：kernel-pin 清单与实际内核状态的一致性校验。
//
// 职责（v0.6.0 M1，fail-closed）：
//   1. kernel-pin.json 结构与语义校验（kernel.tag 精确 pin、services 清单唯一且
//      非空、removed 项不得出现在 required）；
//   2. 离线内核分发物（vendor/dsh-kernel/*.tgz）的版本与 pin 的 packageVersion
//      一致（官方 developer preview 破坏性变更随时发生——pin 与实际不符即拒绝，
//      禁止浮动，v0.1.2-alpha.1 升级的教训）；
//   3. （可扩展）boot 接线点：presets/preflight 步骤调用本模块，pin 不符即
//      fail-closed 进恢复页。
//
// 用法：node scripts/compat/validate-pin.js [repo-root=..]
// 供 boot 链与测试复用：module.exports = { validatePin, loadPin }。

const fs = require('node:fs');
const path = require('node:path');

const PIN_REL = path.join('scripts', 'compat', 'kernel-pin.json');

// 收编族 / 版本线独立族（cordis/cosmokit/schemastery/node-addon-system/libreoffice-kit，
// 含平台子包）被内核收编后版本线与 kernel pin 不同（见 install-kernel.mjs 头注释）——
// 按文件名前缀豁免精确版本比对，否则完整 vendor 反被判「版本混装」fail-closed 拒启
// （0.6.5 实测：14 个收编族 tarball 被旧自愈误隔离后 validate 才「假绿」）。
// 0.2.0-rc.2 起新增 @deepseek-ai/libreoffice-kit（dsh-skill-office / dsh-office-to-pdf
// 的 LibreOffice 引擎载体，自有 0.1.x 版本线）。
const REHOMED_PREFIXES = [
  'deepseek-ai-cordis',
  'deepseek-ai-cosmokit',
  'deepseek-ai-schemastery',
  'deepseek-ai-node-addon-system',
  'deepseek-ai-libreoffice-kit',
];

/** 收编族 tarball（版本线独立于 kernel pin，仅需与自身 manifest 自洽）。 */
function isRehomedTarball(file) {
  return REHOMED_PREFIXES.some((p) => file.startsWith(p + '-'));
}

function loadPin(repoRoot) {
  const p = path.join(repoRoot, PIN_REL);
  const raw = fs.readFileSync(p, 'utf8');
  const pin = JSON.parse(raw);
  return { pin, pinPath: p };
}

/** 结构与语义校验（纯函数，供单测）。返回错误串数组，空 = 通过。 */
function validatePin(pin) {
  const errors = [];
  const push = (m) => errors.push(m);

  if (!pin || typeof pin !== 'object') { push('kernel-pin.json 不是对象'); return errors; }
  const k = pin.kernel || {};
  if (typeof k.tag !== 'string' || !/^dsh-v\d+\.\d+\.\d+/.test(k.tag)) {
    push(`kernel.tag 缺失或非官方 tag 形态（期望 dsh-v*）: ${JSON.stringify(k.tag)}`);
  }
  if (typeof k.packageVersion !== 'string' || !/^\d+\.\d+\.\d+/.test(k.packageVersion)) {
    push(`kernel.packageVersion 缺失或非法: ${JSON.stringify(k.packageVersion)}`);
  }
  if (k.acquisition !== 'offline-tarball' && k.acquisition !== 'official-source' && k.acquisition !== 'official-asset') {
    push(`kernel.acquisition 非法: ${JSON.stringify(k.acquisition)}`);
  }
  if (!k.pinPolicy || !/精确|exact/i.test(k.pinPolicy)) {
    push('kernel.pinPolicy 必须显式声明精确 pin（官方 developer preview 禁止浮动）');
  }
  const svc = (pin.services && Array.isArray(pin.services.required)) ? pin.services.required : null;
  if (!svc || svc.length === 0) { push('services.required 缺失或为空'); }
  else {
    const ids = new Set();
    for (const s of svc) {
      if (!s || typeof s.id !== 'string' || !s.id) push(`services.required 条目缺 id: ${JSON.stringify(s)}`);
      else if (ids.has(s.id)) push(`services.required id 重复: ${s.id}`);
      else ids.add(s.id);
      if (!s || typeof s.module !== 'string' || !s.module.startsWith('@deepseek-ai/')) {
        push(`services.required 条目 module 非 @deepseek-ai 包: ${JSON.stringify(s && s.module)}`);
      }
    }
  }
  const removed = (pin.services && Array.isArray(pin.services.removed)) ? pin.services.removed : [];
  const requiredIds = new Set(svc ? svc.map((s) => s.id) : []);
  for (const r of removed) {
    if (r && requiredIds.has(r.id)) push(`removed 条目 ${r.id} 同时出现在 required——自相矛盾`);
  }
  if (!pin.protocols || typeof pin.protocols !== 'object') push('protocols 缺失（TUI 等生态协议桥未声明）');
  return errors;
}

/** 离线 tarball 目录与 pin 的一致性校验。返回错误串数组。 */
function validateVendorDir(repoRoot, pin) {
  const errors = [];
  const dir = path.resolve(repoRoot, pin.kernel.vendorDir || path.join('vendor', 'dsh-kernel'));
  if (!fs.existsSync(dir)) { errors.push(`离线内核目录缺失: ${dir}`); return errors; }
  const want = pin.kernel.packageVersion;
  const tarballs = fs.readdirSync(dir).filter((f) => f.endsWith('.tgz'));
  if (tarballs.length === 0) { errors.push(`离线内核目录无 tarball: ${dir}`); return errors; }
  const bad = tarballs.filter((f) => !f.includes(want) && !isRehomedTarball(f));
  if (bad.length > 0) {
    errors.push(`pin=packageVersion ${want} 与离线 tarball 不符（版本混装防线）：${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ` 等 ${bad.length} 个` : ''}`);
  }
  return errors;
}

function run(repoRoot) {
  const { pin, pinPath } = loadPin(repoRoot);
  const errors = [
    ...validatePin(pin),
    ...validateVendorDir(repoRoot, pin),
  ];
  return { ok: errors.length === 0, errors, pinPath, pin };
}

module.exports = { loadPin, validatePin, validateVendorDir, run, PIN_REL, isRehomedTarball, REHOMED_PREFIXES };

if (require.main === module) {
  const root = path.resolve(__dirname, '..', '..');
  const r = run(root);
  if (r.ok) {
    console.log(`✓ kernel-pin 校验通过: ${r.pin.kernel.tag}（${r.pin.kernel.packageVersion}，${r.pin.kernel.acquisition}）`);
    process.exit(0);
  }
  console.error('✗ kernel-pin 校验失败:');
  for (const e of r.errors) console.error('  -', e);
  process.exit(1);
}
