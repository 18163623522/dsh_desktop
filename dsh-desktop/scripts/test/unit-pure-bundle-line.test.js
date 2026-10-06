'use strict';

// v1.0.0 纯净线：内置插件不进安装包后的装配对账语义（node --test）。
//
// 交付形态改为「官方形状」：`assets/{plugins,agent-presets}` 留在仓库但不进 payload
// （切断点在 dsh-tauri/scripts/stage-payload.sh 与 tauri-release.yml 的 staging，
// 静态口径由 dsh-tauri/scripts/ta12-stage-payload-sentinel.test.mjs 守着）。
// 本文件守的是**行为面**那半条：payload 里没有插件源时，老用户升级必须被自愈成
// 干净 profile，而不是留下指向缺失目录的注册行。
//
// 为什么这条必须常驻：一次致命启动会把 profile 的 cordis.patch.yml 改名成
// .bak-<时间戳> 并把 bundle 列表恢复出厂（sanitizeProfile）——所以「撤回」做错了
// 的失效形态不是报错，而是用户整包插件被抹掉 / 启动进恢复页。
//
// 隔离：全部在 %TEMP% 临时目录里跑，DSH_HOME 重定向，绝不触碰真实 ~/.dsh。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { COMPANION_PLUGINS, companionDirName } = require('../lib/companion-plugins');
const { syncCompanionFiles, registerCompanionPatchEntries } = require('../lib/companion-profile');
const { healBuiltinPresets } = require('../lib/preset-heal');
const { listPresetSlots } = require('../lib/preset-files');

const VENDOR_ROOT = path.resolve(__dirname, '..', '..', 'node_modules');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pure-line-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 造一份「历史上已装过配套件」的 profile（bundle 登记 + 两条 insert 行）。 */
function legacyProfile(dir) {
  const profileDir = path.join(dir, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-balance'] } },
      dependencies: { '@deepseek-ai/dsh-base': 'catalog:', '@deepseek-ai/dsh-balance': '^1.0.0' },
    }, null, 2),
  );
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  fs.writeFileSync(
    patchFile,
    '# dsh web profile patch（由 DSH Desktop 维护）\n'
      + "- insert:\n    - id: balance\n      name: '@deepseek-ai/dsh-balance'\n"
      + "- insert:\n    - id: terminal\n      name: '@deepseek-ai/dsh-terminal-tab'\n",
  );
  return { profileDir, patchFile };
}

test('纯净线前提：配套件清单保持完整（它是撤回依据，不是分发清单）', () => {
  // 清空 COMPANION_PLUGINS 会让 missingNames 无从产生 → 历史登记永久留在 profile。
  // 下限取 35 而非精确条数：允许逐条**有意**退役（v1.0.0 已退役 plugin-manager，
  // 其包名撞官方内核包），但要抓住「一次性裁撤一批」这种放弃撤回的做法。
  assert.ok(COMPANION_PLUGINS.length >= 35, '配套件清单不得清空/裁撤：它是源缺失时的撤回依据');
  for (const p of COMPANION_PLUGINS) assert.ok(p.id && p.name, '条目须含 id 与 name');
});

test('纯净线：payload 无 assets/plugins 时同步不抛错，并把全部配套件计入源缺失', (t) => {
  const dir = tmp(t);
  const { profileDir } = legacyProfile(dir);
  const pureAssets = path.join(dir, 'pure-payload', 'assets', 'plugins'); // 整个不存在
  assert.ok(!fs.existsSync(pureAssets));

  const r = syncCompanionFiles({
    assetsRoot: pureAssets,
    profileDir,
    vendorRoot: VENDOR_ROOT,
    log: () => {},
  });
  assert.equal(r.bundleNames.size, 0, '纯净线不得登记任何 bundle');
  assert.deepEqual([...r.missingNames].sort(), COMPANION_PLUGINS.map((p) => p.name).sort(),
    '全部配套件必须按「源缺失」上报——撤回路径的唯一依据');
});

test('纯净线：源缺失后重登记会把历史 insert 行撤成空补丁层（官方形状 []）', (t) => {
  const dir = tmp(t);
  const { profileDir, patchFile } = legacyProfile(dir);
  const r = syncCompanionFiles({
    assetsRoot: path.join(dir, 'nope', 'assets', 'plugins'),
    profileDir,
    vendorRoot: VENDOR_ROOT,
    log: () => {},
  });
  const reg = registerCompanionPatchEntries(fs.readFileSync(patchFile, 'utf8'), {
    plugins: COMPANION_PLUGINS,
    bundleNames: r.bundleNames,
    missingNames: r.missingNames,
  });
  assert.equal(reg.changed, true, '有历史登记时撤回必须落盘');
  fs.writeFileSync(patchFile, reg.patch);
  const after = fs.readFileSync(patchFile, 'utf8');
  for (const id of ['balance', 'terminal']) {
    assert.ok(!new RegExp(`id:\\s*${id}\\b`).test(after), `撤回后仍残留 ${id} 行：\n${after}`);
  }
  assert.equal(after.replace(/^\s*#.*$/gm, '').trim(), '[]',
    '撤回终态应是空补丁层（内核出厂形态；原有注释头保留不算内容）');
  // 幂等：再跑一遍不得再改。
  const again = registerCompanionPatchEntries(after, {
    plugins: COMPANION_PLUGINS,
    bundleNames: r.bundleNames,
    missingNames: r.missingNames,
  });
  assert.equal(again.changed, false, '撤回必须幂等（否则每次启动重写 profile）');
});

test('反证：装上 1 个源后 missing 恰好少 1——判据真在读磁盘，不是恒「全量缺失」', (t) => {
  const dir = tmp(t);
  const { profileDir } = legacyProfile(dir);
  // 只放 balance 一个源（不含 dsh.bundle 声明，故只看源缺失判定这一维）：
  // missing 必须是「其余全部」而不是「全部」——证明判据真的在读磁盘。
  const assets = path.join(dir, 'assets', 'plugins');
  const one = path.join(assets, companionDirName({ name: '@deepseek-ai/dsh-balance' }));
  fs.mkdirSync(one, { recursive: true });
  fs.writeFileSync(path.join(one, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-balance', version: '1.0.0' }));

  const r = syncCompanionFiles({ assetsRoot: assets, profileDir, vendorRoot: VENDOR_ROOT, log: () => {} });
  assert.equal(r.missingNames.has('@deepseek-ai/dsh-balance'), false, '有源的包不得计入源缺失');
  assert.equal(r.missingNames.size, COMPANION_PLUGINS.length - 1, '其余配套件应仍计入源缺失');
});

// ---- 预设半边：payload 无 assets/agent-presets 时的 boot 语义 ----------------

test('纯净线：预设源缺失时枚举为空、heal 记 source-missing 且不抛（presets/repair 步）', (t) => {
  const dir = tmp(t);
  const appDir = path.join(dir, 'pure-payload', 'dsh-desktop'); // 没有 assets/agent-presets
  const home = path.join(dir, 'home');
  assert.deepEqual(listPresetSlots(path.join(appDir, 'assets', 'agent-presets')), [],
    '源根缺失时预设槽枚举必须为空（installBuiltinPresets 据此装 0 个）');

  // 老用户目录里已有历史随包副本：纯净线不得删（稳定性原则③「用户数据不动」，
  // 那可能是用户改过的文件），也不得因源缺失而抛。
  const legacy = path.join(home, '.agent-presets', 'minimal-win');
  fs.mkdirSync(legacy, { recursive: true });
  const probe = path.join(legacy, 'agent.cordis.yml');
  fs.writeFileSync(probe, 'name: 用户可能改过的旧副本\n');

  const logs = [];
  const res = healBuiltinPresets({ appDir, home, log: (m) => logs.push(String(m)) });
  assert.equal(res.note, 'source-missing', '应记下「源不可用」原因码而不是静默');
  assert.equal(res.changed, false, '无源时不得写盘');
  assert.equal(fs.readFileSync(probe, 'utf8'), 'name: 用户可能改过的旧副本\n',
    '用户目录下已存在的预设副本必须原样保留');
  assert.ok(logs.some((m) => m.includes('preset-heal')), '跳过必须留日志（避免静默形态漂移）');
});
