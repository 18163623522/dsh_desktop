'use strict';

// 单测：伴随件「不得遮蔽官方内核包」不变量 + 存量遮蔽回收。
//
// 回归来源（本机实测，非推断）：profiles/web/node_modules/@deepseek-ai/dsh-plugin-manager
// 是 Electron 时代伴随件的镜像副本（0.1.2，host 半边 766B 空壳，不 provide 任何服务），
// 而它比安装锚点（D:\app\DSH Desktop\dsh-desktop\node_modules 里的官方
// 0.2.0-rc.2，85KB，super(ctx,'pluginManager')）更靠近 profile 根 → Node 解析命中空壳 →
// pluginManager 服务消失 → 内核插件页判「本部署没有可管理的 profile」：
//   dsh-client-ui-plugin-manager/lib/client.js:1228 要 managementAvailable === true，
//   dsh-host-plugin-inventory/lib/index.js:137 只在 ctx.get('pluginManager') 存在时给该字段。
// 运行：node --test scripts/test/unit-companion-shadow-reclaim.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { COMPANION_PLUGINS, companionDirName, RETIRED_COMPANION_DIRS } = require('../lib/companion-plugins');
const { syncCompanionFiles } = require('../lib/companion-profile');

const SHADOWED_NAME = '@deepseek-ai/dsh-plugin-manager';
const SHADOWED_DIR = 'dsh-plugin-manager';

/** 离线内核闭包的包名集合（npm pack 口径：@scope/name → scope-name-<version>.tgz）。 */
function vendorFlatNames() {
  const dir = path.resolve(__dirname, '..', '..', 'vendor', 'dsh-kernel');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.tgz'))
    .map((f) => f.slice(0, -'.tgz'.length));
}

/** 某个包名是否被离线内核闭包占据（即镜像进 profile 会遮蔽官方实现）。 */
function isOfficialKernelPackage(name, flatNames) {
  const flat = name.replace(/^@/, '').replace('/', '-');
  return flatNames.some((base) => base === flat || base.startsWith(flat + '-'));
}

function writePkg(dir, pkg) {
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), "export const name = 'x';\n");
}

test('清单不变量：任何伴随件包名都不得与离线内核闭包同名（遮蔽防线）', () => {
  const flat = vendorFlatNames();
  assert.ok(flat.length >= 300, `离线内核闭包样本量应达下限，实测 ${flat.length}`);
  const offenders = COMPANION_PLUGINS
    .filter((p) => isOfficialKernelPackage(p.name, flat))
    .map((p) => `${p.id} → ${p.name}`);
  assert.deepStrictEqual(offenders, [],
    '伴随件与官方内核包同名会经 profile node_modules 遮蔽官方实现：' + offenders.join(', '));
  assert.ok(!COMPANION_PLUGINS.some((p) => p.name === SHADOWED_NAME),
    'plugin-manager 伴随件必须保持退役（复活要同时换包名与 loader id）');
  // 回收面由退役名单驱动，不是散落的字面量：摘掉名单就等于放弃回收存量遮蔽。
  assert.ok(RETIRED_COMPANION_DIRS.includes(SHADOWED_DIR),
    '退役伴随件必须登记进 RETIRED_COMPANION_DIRS');
  assert.ok(RETIRED_COMPANION_DIRS.every((d) => !COMPANION_PLUGINS.map(companionDirName).includes(d)),
    '退役目录不得同时出现在清单里');
});

test('判据自证：合成一条与官方内核同名的清单条目，防线必须抓红', () => {
  const flat = vendorFlatNames();
  assert.strictEqual(isOfficialKernelPackage(SHADOWED_NAME, flat), true,
    '判据必须认定 @deepseek-ai/dsh-plugin-manager 是官方内核包');
  assert.strictEqual(isOfficialKernelPackage('dsh-better-sidebar', flat), false,
    '非官方名不得误报（否则防线会长期红）');
  assert.strictEqual(isOfficialKernelPackage('@dsh-external/dsh-vision', flat), false);
  // 同前缀长名不构成命中：dsh-settings 与 dsh-settings-nav-custom 是不同包。
  assert.strictEqual(isOfficialKernelPackage('@deepseek-ai/dsh-settings-x-none', flat), false);
});

test('syncCompanionFiles：回收 profile 里退役伴随件的遮蔽副本', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shadow-reclaim-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const profileDir = path.join(tmp, 'profiles', 'web');
  const scoped = path.join(profileDir, 'node_modules', '@deepseek-ai');

  // 遮蔽副本：带内置装配特征（private + 描述含 "DSH Desktop"）。
  const shim = path.join(scoped, SHADOWED_DIR);
  writePkg(shim, {
    name: SHADOWED_NAME,
    version: '0.1.2',
    private: true,
    description: 'DSH Desktop 配套插件：设置页「插件」栏——列出全部内置插件及其作用',
  });

  // 反例 A：用户自装的同名包（非 private、无内置描述）——绝不清理。
  const userPkg = path.join(scoped, 'dsh-user-kept');
  writePkg(userPkg, { name: 'dsh-user-kept', version: '1.0.0', description: '用户自行安装' });

  // 反例 B：当前清单内的插件目录即便带内置特征也不得被清（删除-重拷抖动防线）。
  const current = path.join(scoped, companionDirName(COMPANION_PLUGINS[0]));
  writePkg(current, {
    name: COMPANION_PLUGINS[0].name,
    version: '0.1.1',
    private: true,
    description: 'DSH Desktop 配套插件',
  });

  const emptyRoot = path.join(tmp, 'assets-empty');
  const messages = [];
  syncCompanionFiles({
    assetsRoot: emptyRoot,
    profileDir,
    vendorRoot: path.join(tmp, 'vendor-empty'),
    log: (m) => messages.push(m),
    fail: (m) => messages.push(m),
  });

  assert.ok(!fs.existsSync(shim), '退役伴随件的遮蔽副本应被回收（插件页判「无可管理 profile」的根因）');
  assert.ok(fs.existsSync(path.join(userPkg, 'package.json')), '用户自装同名包不得被删');
  assert.ok(fs.existsSync(path.join(current, 'package.json')), '当前清单插件目录不得被清');
  assert.ok(messages.some((m) => m.includes(SHADOWED_DIR)), '回收应留痕日志');

  // 幂等：再跑一遍不报错、无新删除。
  const second = [];
  syncCompanionFiles({
    assetsRoot: emptyRoot, profileDir, vendorRoot: path.join(tmp, 'vendor-empty'),
    log: (m) => second.push(m), fail: (m) => second.push(m),
  });
  assert.ok(!second.some((m) => m.includes('已清理过期配套插件')), '二次同步应无重复清理');
  assert.ok(fs.existsSync(path.join(current, 'package.json')));
});
