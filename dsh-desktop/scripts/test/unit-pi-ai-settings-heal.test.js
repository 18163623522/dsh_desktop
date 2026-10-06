'use strict';

// pi-ai-settings-heal 单元测试：settings.yaml 的 llm-pi-ai 非法供应商条目
// 自愈（boot repair 步）。两条判定路径都覆盖：
//   - 真内核路径：appDir 指向本仓 dsh-desktop，用安装根 @deepseek-ai/dsh-llm-pi-ai
//     的真 apply() 判定（rc.1→rc.2 仍 fail-loud 的标量校验形态，如 baseURL 空串；
//     alpha.5 的「目录外路由缺 api/baseURL」形态已被上游 deferred，另有哨兵测试）；
//   - 注桩路径：inject.probeApply 覆盖判定，覆盖防环 / 放弃 / 多轮收敛等
//     内核真码难以稳定构造的分支。桩的入参形状必须与 rc.2 apply(ctx, config)
//     一致（config.providers 是访问器），否则桩会在自造契约上通过。
// 断言红线：绝不带着坏配置覆盖用户文件；零改动路径绝不写盘。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { healPiAiSettings, probeWithKernel, settingsFileOf } = require('../../scripts/lib/pi-ai-settings-heal');

const repoRoot = path.resolve(__dirname, '..', '..');

/** 造临时 home 并写入 settings.yaml。 */
function makeHome(yamlText) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-piai-heal-'));
  if (yamlText !== undefined) fs.writeFileSync(path.join(home, 'settings.yaml'), yamlText, 'utf8');
  return home;
}

/** 非法供应商（rc.1/rc.2 真内核仍 fail-loud 的标量校验形态：baseURL 显式配成空串）。
 *  注：alpha.5 时代的「目录外路由缺 api/baseURL」形态在 rc.1 已被上游改为
 *  deferred 诊断（apply 走 resolveProfiles(providers, "deferred")，PiAiCatalogError
 *  收容进目录条目，不再击穿启动），见下方漂移哨兵测试；只有标量校验类错误
 *  仍让整段 apply 抛错（一家不合法、全体陪葬的崩溃面到 rc.2 仍然存在，
 *  已由探针在 rc.2 字节上实测：空 baseURL 抛 provider "broken-relay" has an empty baseURL）。 */
const BAD_PROVIDER = [
  '    broken-relay:',
  "      baseURL: ''",
  '      models:',
  '        - id: grok-4.5',
  '          name: Grok',
  '          contextWindow: 100000',
  '          maxTokens: 8192',
  '      apiKeyEnv: BROKEN_RELAY_API_KEY',
].join('\n');

/** 合法供应商（完整 api+baseURL——UI 正常添加形态）。 */
const GOOD_PROVIDER = [
  '    good-relay:',
  '      api: openai-completions',
  '      baseURL: https://example.invalid/v1',
  '      models:',
  '        - id: good-model',
  '          name: Good',
  '          contextWindow: 100000',
  '          maxTokens: 8192',
  '      apiKeyEnv: GOOD_RELAY_API_KEY',
].join('\n');

function settingsWith(providersBody) {
  return [
    'ui-theme:',
    '  mode: dark',
    'llm-pi-ai:',
    '  providers:',
    providersBody,
    'agent-default-model:',
    '  model: good-relay/good-model',
    '',
  ].join('\n');
}

const NOOP_LOG = () => {};

/** 取本仓安装根的 dsh-llm-pi-ai 真码（纯 ESM，只能动态 import）。 */
function loadPiAi() {
  const file = path.join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js');
  return import('node:url').then((u) => import(u.pathToFileURL(file).href));
}

/** rc.2 apply 用到的最小 ctx 依赖面（与 lib/probeWithKernel 同一形状）。 */
function kernelShapedCtx() {
  const noop = () => {};
  return {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    inject: noop,
    on: noop,
    get: () => undefined,
    fiber: {},
    llm: new Proxy({}, { get: () => () => ({ replace: noop }) }),
    authorization: { registerFlow: noop },
  };
}

test('settingsFileOf 拼接 home 与 settings.yaml', () => {
  assert.equal(settingsFileOf('C:/x'), path.join('C:/x', 'settings.yaml'));
});

test('rc.2 契约哨兵：apply 仍按 (ctx, config) 取 config.providers.get() 与 ctx.fiber', () => {
  // 自愈的判定完全依赖 mock 的 ctx/config 形状对上内核真码。上游再改一次访问器
  // 形状时，本守卫当场变红；否则真机表现是 heal 静默报 unrecognized-failure
  // （TypeError 里没有供应商名），用户的坏条目永远修不掉且没有任何信号。
  const src = fs.readFileSync(
    path.join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js'), 'utf8');
  assert.ok(src.includes('function apply(ctx, config)'), 'apply 入参形状漂移（第 2 参名 config）');
  assert.ok(src.includes('config.providers.get()'), 'providers 仍是访问器（.get()）');
  assert.ok(src.includes('ctx.fiber.entry?.options.id'), 'apply 首段仍读 ctx.fiber');
  assert.ok(src.includes('ctx.on("internal/config"'), 'apply 仍注册 internal/config 监听（mock 需 ctx.on）');
});

test('反证：旧形状（providers 不是访问器）让真码抛出不含供应商名的 TypeError', async () => {
  // 这正是修复前生产 probeWithKernel 的失败形态：note = unrecognized-failure:
  // Cannot read properties of undefined (reading \'entry\')／config.providers.get is not a function。
  const piAi = await loadPiAi();
  let err;
  try {
    piAi.apply(kernelShapedCtx(), { providers: { 'broken-relay': { baseURL: '' } } });
  } catch (e) { err = e; }
  assert.ok(err, 'section 直喂（无 .get()）必须抛错');
  assert.match(String(err.message), /config\.providers\.get is not a function/);
  assert.equal(/provider "([^"]+)"/.exec(String(err.message)), null,
    '消息里没有 provider "x" 形态 → 自愈无法定位条目，只能放弃');
});

test('真内核: probeWithKernel 对非法条目判 ok:false 并解析出供应商名，合法条目判 ok:true', async () => {
  const piAi = await loadPiAi();
  const bad = probeWithKernel(piAi.apply, {
    providers: { 'broken-relay': { baseURL: '', models: [{ id: 'm', name: 'M', contextWindow: 1000, maxTokens: 100 }] } },
  });
  assert.equal(bad.ok, false, '空 baseURL 必须判为不健康');
  assert.equal(bad.provider, 'broken-relay', '要能从错误消息解析出供应商键名（自愈靠它定位删除目标）');
  assert.match(bad.message, /empty baseURL/);

  const good = probeWithKernel(piAi.apply, {
    providers: { 'good-relay': { api: 'openai-completions', baseURL: 'https://example.invalid/v1',
      models: [{ id: 'm', name: 'M', contextWindow: 1000, maxTokens: 100 }] } },
  });
  assert.equal(good.ok, true, '合法条目应判健康: ' + JSON.stringify(good));
});

test('真内核: 非法供应商被移出，合法供应商与其它 section 原样保留，备份含原文', async () => {
  const home = makeHome(settingsWith(BAD_PROVIDER + '\n' + GOOD_PROVIDER));
  const file = path.join(home, 'settings.yaml');
  const before = fs.readFileSync(file, 'utf8');

  const r = await healPiAiSettings({ appDir: repoRoot, home, log: NOOP_LOG });

  assert.equal(r.changed, true, '应发生修改: ' + JSON.stringify(r));
  assert.deepEqual(r.removed, ['broken-relay']);
  assert.ok(r.backup && fs.existsSync(r.backup), '备份文件应存在');
  assert.ok(r.backup.startsWith(file + '.heal-piai-'), '备份命名 .heal-piai- 前缀');
  const backupText = fs.readFileSync(r.backup, 'utf8');
  assert.ok(backupText.includes('broken-relay'), '备份应含被移出条目原文');

  const healed = fs.readFileSync(file, 'utf8');
  assert.ok(!healed.includes('broken-relay'), '非法条目应被移出');
  assert.ok(healed.includes('good-relay'), '合法条目应保留');
  assert.ok(healed.includes('mode: dark'), '其它 section（ui-theme）应保留');
  assert.ok(healed.includes('model: good-relay/good-model'), 'agent-default-model 应保留');

  // 修复后的 section 必须能过内核 apply（用同一真码复核）。
  const yaml = require(path.join(repoRoot, 'node_modules', 'yaml'));
  const doc = yaml.parseDocument(healed, { uniqueKeys: true });
  assert.equal(doc.errors.length, 0, '修复后应为合法 YAML');
  const piAi = await loadPiAi();
  assert.equal(probeWithKernel(piAi.apply, doc.toJS()['llm-pi-ai']).ok, true, '修复后内核判定应通过');
});

// 漂移哨兵：alpha.5 形态（目录外路由缺 api/baseURL）在 rc.1 已失去「击穿启动」的
// 意义——上游把 apply 的目录校验改为 deferred（resolveProfiles(providers,
// "deferred")：PiAiCatalogError 收容为 catalogError/modelErrors 随目录条目上报，
// 坏路由可见但不 brick 其它供应商）。自愈必须不移植性删除内核已容忍的条目；
// 若未来内核回到该形态 fail-loud，此守卫当场变红，强制重新武装 BAD 判定。
test('真内核: 目录外路由缺 api/baseURL 已被 rc.1 deferred 容忍，不得移出', async () => {
  const catalogMissing = [
    '    old-shape-relay:',
    '      models:',
    '        - id: grok-4.5',
    '          name: Grok',
    '          contextWindow: 100000',
    '          maxTokens: 8192',
    '      apiKeyEnv: OLD_SHAPE_API_KEY',
  ].join('\n');
  const home = makeHome(settingsWith(catalogMissing + '\n' + GOOD_PROVIDER));
  const file = path.join(home, 'settings.yaml');
  const before = fs.readFileSync(file, 'utf8');
  const r = await healPiAiSettings({ appDir: repoRoot, home, log: NOOP_LOG });
  assert.equal(r.changed, false, 'rc.1 内核对该形态不抛错 → 自愈必须零写: ' + JSON.stringify(r));
  assert.deepEqual(r.removed, []);
  assert.equal(r.backup, null);
  assert.equal(fs.readFileSync(file, 'utf8'), before, '文件必须原样保留');
});

test('真内核: 全合法配置零写盘（changed:false 且文件未动）', async () => {
  const home = makeHome(settingsWith(GOOD_PROVIDER));
  const file = path.join(home, 'settings.yaml');
  const before = fs.readFileSync(file, 'utf8');
  const statBefore = fs.statSync(file);

  const r = await healPiAiSettings({ appDir: repoRoot, home, log: NOOP_LOG });

  assert.equal(r.changed, false);
  assert.deepEqual(r.removed, []);
  assert.equal(r.backup, null);
  assert.equal(fs.readFileSync(file, 'utf8'), before, '文件内容不应变化');
  assert.equal(fs.statSync(file).mtimeMs, statBefore.mtimeMs, '不应触碰文件');
});

test('真内核: 无 llm-pi-ai section / 空 providers / providers 非法形态 均不动', async () => {
  for (const [name, text] of [
    ['无 section', 'ui-theme:\n  mode: dark\n'],
    ['空 providers', 'llm-pi-ai:\n  providers: {}\n'],
    ['providers 非法形态', 'llm-pi-ai:\n  providers: oops\n'],
  ]) {
    const home = makeHome(text);
    const file = path.join(home, 'settings.yaml');
    const before = fs.readFileSync(file, 'utf8');
    const r = await healPiAiSettings({ appDir: repoRoot, home, log: NOOP_LOG });
    assert.equal(r.changed, false, name + ' 应零写');
    assert.ok(r.note, name + ' 应带 note: ' + JSON.stringify(r));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  const emptyHome = makeHome(undefined);
  const r2 = await healPiAiSettings({ appDir: repoRoot, home: emptyHome, log: NOOP_LOG });
  assert.equal(r2.changed, false);
  assert.equal(r2.note, 'settings-missing');
  assert.equal(fs.existsSync(path.join(emptyHome, 'settings.yaml')), false, '绝不应凭空造文件');
});

test('真内核: 内核模块不在位（假 appDir）→ 不修不写', async () => {
  const fakeApp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-piai-fakeapp-'));
  fs.writeFileSync(path.join(fakeApp, 'package.json'), JSON.stringify({ name: 'fake' }), 'utf8');
  const home = makeHome(settingsWith(BAD_PROVIDER));
  const file = path.join(home, 'settings.yaml');
  const before = fs.readFileSync(file, 'utf8');

  const r = await healPiAiSettings({ appDir: fakeApp, home, log: NOOP_LOG });

  assert.equal(r.changed, false);
  assert.ok(String(r.note).startsWith('deps-unavailable'), '应报依赖不在位: ' + JSON.stringify(r));
  assert.equal(fs.readFileSync(file, 'utf8'), before, '文件不应被动');
  assert.equal(fs.readdirSync(home).filter((f) => f.includes('heal-piai')).length, 0, '不应产生备份');
});

test('真内核: 幂等——修完再跑一轮零写', async () => {
  const home = makeHome(settingsWith(BAD_PROVIDER + '\n' + GOOD_PROVIDER));
  const first = await healPiAiSettings({ appDir: repoRoot, home, log: NOOP_LOG });
  assert.equal(first.changed, true);
  const file = path.join(home, 'settings.yaml');
  const after = fs.readFileSync(file, 'utf8');
  const second = await healPiAiSettings({ appDir: repoRoot, home, log: NOOP_LOG });
  assert.equal(second.changed, false);
  assert.deepEqual(second.removed, []);
  assert.equal(fs.readFileSync(file, 'utf8'), after);
});

test('真内核: CRLF 原文修复后保持 CRLF', async () => {
  const home = makeHome(settingsWith(BAD_PROVIDER).replace(/\n/g, '\r\n'));
  const r = await healPiAiSettings({ appDir: repoRoot, home, log: NOOP_LOG });
  assert.equal(r.changed, true);
  const healed = fs.readFileSync(path.join(home, 'settings.yaml'), 'utf8');
  assert.ok(healed.includes('\r\n'), '应保持 CRLF');
  assert.ok(!/(^|[^\r])\n/.test(healed), '不应残留裸 LF');
});

test('注桩: 抛错不含 provider 名 → 放弃且零写', async () => {
  const home = makeHome(settingsWith(BAD_PROVIDER));
  const file = path.join(home, 'settings.yaml');
  const before = fs.readFileSync(file, 'utf8');
  const r = await healPiAiSettings({
    appDir: repoRoot, home, log: NOOP_LOG,
    inject: { probeApply: () => { throw new Error('some other failure'); } },
  });
  assert.equal(r.changed, false);
  assert.ok(String(r.note).startsWith('unrecognized-failure'));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('注桩: 多轮收敛——每轮抛一个非法条目，全部移出后通过', async () => {
  // 两个非法条目（键名即 stub 抛的名字，必须真实存在于 settings 才删得掉）。
  const badA = BAD_PROVIDER.replace('broken-relay:', 'a-first:').replace('BROKEN_RELAY_API_KEY', 'A_API_KEY');
  const badB = BAD_PROVIDER.replace('broken-relay:', 'b-second:').replace('BROKEN_RELAY_API_KEY', 'B_API_KEY');
  const home = makeHome(settingsWith(badA + '\n' + badB + '\n' + GOOD_PROVIDER));
  const throwOrder = ['a-first', 'b-second'];
  const r = await healPiAiSettings({
    appDir: repoRoot, home, log: NOOP_LOG,
    inject: {
      // rc.2 契约：apply 的第二参是已解析配置，providers 是访问器（.get()）。
      probeApply: (ctx, config) => {
        const keys = Object.keys(config.providers.get());
        const hit = throwOrder.find((n) => keys.includes(n));
        if (hit) throw new Error('provider "' + hit + '" model "x" needs an api');
      },
    },
  });
  assert.equal(r.changed, true);
  assert.deepEqual(r.removed, ['a-first', 'b-second']);
  const healed = fs.readFileSync(path.join(home, 'settings.yaml'), 'utf8');
  assert.ok(!healed.includes('a-first') && !healed.includes('b-second'));
  assert.ok(healed.includes('good-relay'), '合法条目保留');
});

test('注桩: 重复抛同名 → 防环放弃', async () => {
  const home = makeHome(settingsWith(BAD_PROVIDER));
  const file = path.join(home, 'settings.yaml');
  const before = fs.readFileSync(file, 'utf8');
  const r = await healPiAiSettings({
    appDir: repoRoot, home, log: NOOP_LOG,
    inject: { probeApply: () => { throw new Error('provider "broken-relay" still bad'); } },
  });
  assert.equal(r.changed, false);
  assert.ok(String(r.note).startsWith('repeat-failure'));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('注桩: 抛错指向不存在的键 → 放弃', async () => {
  const home = makeHome(settingsWith(BAD_PROVIDER));
  const r = await healPiAiSettings({
    appDir: repoRoot, home, log: NOOP_LOG,
    inject: { probeApply: () => { throw new Error('provider "ghost" bad'); } },
  });
  assert.equal(r.changed, false);
  assert.ok(String(r.note).startsWith('provider-not-found'));
});

test('注桩: 轮次耗尽仍不健康 → 终态复核放弃（绝不带坏配置写盘）', async () => {
  const home = makeHome(settingsWith(BAD_PROVIDER));
  const file = path.join(home, 'settings.yaml');
  const before = fs.readFileSync(file, 'utf8');
  const r = await healPiAiSettings({
    appDir: repoRoot, home, log: NOOP_LOG,
    inject: {
      maxRounds: 1, // 轮 1 删 broken-relay 后即耗尽，终态复核 stub 仍炸 → 放弃
      probeApply: (ctx, config) => {
        const keys = Object.keys(config.providers.get());
        if (keys.length > 0) throw new Error('provider "' + keys[0] + '" bad');
        throw new Error('section-level boom');
      },
    },
  });
  assert.equal(r.changed, false);
  assert.ok(String(r.note).startsWith('still-unhealthy'), '应终态放弃: ' + JSON.stringify(r));
  assert.equal(fs.readFileSync(file, 'utf8'), before, '原文件必须原样保留');
  assert.equal(fs.readdirSync(home).filter((f) => f.includes('heal-piai')).length, 0, '不应产生备份');
});

test('注桩: settings.yaml 解析失败 → 不动', async () => {
  const home = makeHome('llm-pi-ai: [unclosed\n  bad');
  const file = path.join(home, 'settings.yaml');
  const before = fs.readFileSync(file, 'utf8');
  const r = await healPiAiSettings({ appDir: repoRoot, home, log: NOOP_LOG });
  assert.equal(r.changed, false);
  assert.equal(r.note, 'yaml-parse-error');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
