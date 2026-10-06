'use strict';

/* 中央版工具名 wire 补丁测试（node --test）。
   覆盖：文本面锚点/幂等/半投防护，以及功能面「出站洗名 + 回程还原」双向闭环。
   反向控制：合法名不得被改写、不得登记映射。 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const DSH = path.resolve(__dirname, '..', '..');
const {
  transformPiAiToolNameWire,
  MARKER,
  ANCHORS,
  patchSource,
} = require('../patch-pi-ai-tool-name-wire');
const { DSH_LLM_PIAI_PKG_REL } = require('../lib/patch-target-resolver');
const markers = require('../lib/patch-adapters').markers;

const TARGET = path.join(DSH, 'node_modules', DSH_LLM_PIAI_PKG_REL);

function pristineSource() {
  const root = path.join(DSH, '..', '.tmp-kernel');
  const consumers = fs.existsSync(root)
    ? fs.readdirSync(root).filter((n) => n.startsWith('.consumer-')).sort().reverse() : [];
  for (const c of consumers) {
    const p = path.join(root, c, 'node_modules', DSH_LLM_PIAI_PKG_REL);
    if (fs.existsSync(p)) return { file: p, src: fs.readFileSync(p, 'utf8') };
  }
  return null;
}

test('marker 单一数据源：脚本与 adapters.markers 同一实例', () => {
  assert.equal(markers.PI_AI_TOOL_NAME_WIRE_MARKER, MARKER);
});

test('锚点命中 pristine → changed；三处收口齐备且不删任何成员', () => {
  const p = pristineSource();
  assert.ok(p, '找不到 pristine dsh-llm-pi-ai 源（先跑 scripts/install-pristine-kernel.mjs）');
  assert.ok(!p.src.includes(MARKER), 'pristine 不得已带 marker');
  const r = transformPiAiToolNameWire(p.src, p.file);
  assert.equal(r.status, 'changed');
  const out = r.src;
  assert.ok(out.includes(MARKER), '产物应含 marker（幂等依据）');
  assert.equal(out.split('__dshPiWireToolName(tool.name)').length - 1, 1, '出站清洗点应恰 1 处（toolsOf）');
  assert.equal(out.split('__dshPiRestoreToolName(block.name)').length - 1, 2, '回程还原点应恰 2 处');
  // 只改 name 的传值形态，不得动其它字段或删成员。
  assert.ok(out.includes('parameters: tool.parameters'), 'parameters 透传不得被改动');
  assert.ok(/name: __dshPiRestoreToolName\(block\.name\),\s*\r?\n\s*arguments: parseArguments\(block\.arguments\)/.test(out),
    '回程 toolCall 的 id/arguments 结构必须原样保留');
});

test('幂等 already；任一锚点缺失整份不改（防半投）', () => {
  const p = pristineSource();
  const once = transformPiAiToolNameWire(p.src, p.file);
  assert.equal(transformPiAiToolNameWire(once.src, p.file).status, 'already');
  // 直接破坏一个真实锚点。必须按引用取生产 ANCHORS 的 needle 再改一个字符——
  // 手抄一份「function toolsOf(options) { + return + name:」三行字面串曾在 rc.2
  // 上静默失配（上游在 toolsOf 开头插了 deferLoading 守卫），replace 变 no-op，
  // 于是这条反证根本没破坏任何东西。
  const outbound = ANCHORS.find((a) => a.id === 'toolsOf-outbound');
  const mangled = outbound.needle.replace('name: tool.name,', 'name: tool?.name,');
  assert.notEqual(mangled, outbound.needle, '构造失败：needle 里不含可破坏的 name: tool.name, 片段');
  const broken = p.src.replace(outbound.needle, mangled);
  assert.notEqual(broken, p.src, '构造失败：出站锚点未被破坏');
  const r = transformPiAiToolNameWire(broken, p.file);
  assert.equal(r.status, 'anchor-missing', '锚点失配必须判失配而非半投');
  assert.ok(r.detail.includes('toolsOf-outbound'), 'detail 应点名未命中锚：' + r.detail);
  assert.equal(r.src, undefined, 'anchor-missing 不得返回改写后的源码');
});

test('产物 node --check 通过', () => {
  const p = pristineSource();
  const out = patchSource(p.src).src;
  const tmp = path.join(os.tmpdir(), 'dsh-wire-chk-' + Date.now() + '.js');
  fs.writeFileSync(tmp, out);
  try {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'node --check 失败：' + (r.stderr || '').slice(0, 300));
  } finally { fs.rmSync(tmp, { force: true }); }
});

/* ---- 功能面：跑打过补丁的真实适配层 ---- */
async function patchedMod() {
  assert.ok(fs.existsSync(TARGET), '靶文件缺失：' + TARGET);
  assert.ok(fs.readFileSync(TARGET, 'utf8').includes(MARKER), 'dev 靶未收口（跑 node scripts/patch-deps.js）');
  // 适配层是 ESM；toolsOf 未导出，故经其唯一消费者（请求上下文组装）间接验证：
  // 用真实包内的 stream()/tools 传参路径太重，这里直接取注入的 helper 与 toolsOf 行为。
  const src = fs.readFileSync(TARGET, 'utf8');
  const from = src.indexOf('const __dshPiToolWireMap');
  assert.ok(from >= 0, '靶文件里找不到映射表声明（补丁未落地？）');
  const body = src.slice(from, src.indexOf('function toolsOf'));
  const sandbox = { out: {} };
  const fn = new Function('sandbox', body + '\nsandbox.wire = __dshPiWireToolName;sandbox.restore = __dshPiRestoreToolName;sandbox.map = __dshPiToolWireMap;');
  fn(sandbox);
  return sandbox;
}

test('功能：cardian.backlinks 出站洗成合法 wire 名，回程还原为原名', async () => {
  const { wire, restore, map } = await patchedMod();
  assert.equal(wire('cardian.backlinks'), 'cardian_backlinks');
  assert.match(wire('cardian.backlinks'), /^[a-zA-Z0-9_-]+$/, 'wire 名必须满足 OpenAI/Anthropic 名字规则');
  assert.equal(restore('cardian_backlinks'), 'cardian.backlinks', '回程必须还原成内核注册的原名');
  assert.equal(map.get('cardian_backlinks'), 'cardian.backlinks');
});

test('功能反向控制：合法名不改写、不登记映射', async () => {
  const { wire, restore, map } = await patchedMod();
  for (const legal of ['bash', 'read_file', 'WebSearch', 'dsh-tool-fs']) {
    assert.equal(wire(legal), legal, '合法名不得被改写：' + legal);
  }
  assert.equal(restore('bash'), 'bash');
  assert.ok(!map.has('bash'), '合法名不得登记映射');
});
