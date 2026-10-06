'use strict';

// unit-session-load-graceful.test.js — v0.5.4 求稳补丁（K6）单测。
//
// 根因（代码推演 + 用户反馈直接采信）：一轮对话触发自动压缩（auto-compaction）
// 后「本轮运行失败」→ 随后「历史加载失败」→ 崩溃。自动压缩把一个多事件批次
// （compaction/start、compaction/summary、user/message replace、compaction/end）
// 一次性追加落盘（append-only，非重写），帧体比单事件帧更大；中断/崩溃后除
// 「结构撕裂的最后一帧」（已被第 1 行 torn-tail 恢复兜住）外，还可能留下
// 「结构完整但校验失败 / seq 断档」的损坏帧——后者让 readZstdPrefix 抛致命错，
// 而 loadHistory 读路径不像 listArtifacts 有 corrupt-guard，于是「历史加载失败」
// 击穿并随后崩溃。
//
// 补丁（patch-adapters.transformSessionLoadGraceful，v3 = rc.1 世代）对内核
// dsh-session-persistence-jsonl/lib/index.js 的 readZstdPrefix 做：
//   解码/校验失败时降级为「加载到最后一个完整帧」——返回已解码前缀 + 扁平
//   tornTruncateTo / recoveredTail 与 inheritedEventCount（rc.1 契约；v2 时代的
//   嵌套 tornMarker 在 rc.1 上是死代码），由 commitRepair 截断损坏尾部并补
//   closers；console.warn 保留告警（不掩盖真实损坏）；header 帧损坏仍致命
//   （scanner 未建立即重抛）。
//
// 测试手法（与 unit-session-persistence-recovery / unit-session-header-scan-guard 同款）：
//   1) 锚点命中内核源 → changed、含 v3 marker 与扁平返回契约（内容契约）；
//   2) transform 产物 node --check 语法合法；
//   3) 幂等（二遍 already）/ marker-only 短路 / 锚点缺失 anchor-missing 不改写；
//   4) 行为（动态 import 真实内核 transform 产物）：干净日志正常读、seq 断档
//      损坏帧优雅降级（扁平 tornTruncateTo + warn、不抛）、header 损坏仍致命；
//   5) 回归：叠加 torn-tail/corrupt-guard/K5 后本补丁仍命中、三 marker 共存；
//   6) 升级通道：在野 v1/v2 副本就地升级到 v3，产物与 pristine 全新应用逐字节相同；
//   7) registry 装配（layout / pkgRel / transform / marker 同源 / cli:false）。
//
// 运行：node --test scripts/test/unit-session-load-graceful.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { zstdCompressSync, constants } = require('node:zlib');

const {
  transformSessionLoadGraceful,
  transformPersistenceAll,
  transformSessionHeaderScanGuard,
  toPristineSource,
  PRISTINE_INJECTIONS,
  SESSION_LOAD_GRACEFUL_CATCH_LEGACY,
  markers,
} = require('../lib/patch-adapters');
const { PATCH_SPECS, getSpecsByCli } = require('../lib/patch-registry');
const { PERSISTENCE_PKG_REL, resolvePatchTargets } = require('../lib/patch-target-resolver');
// rc.1 起会话格式版本常量化导出（alpha.5 fixture 里写死的 version: 0 已被
// refuseForeignFormatVersion 硬拒），header 夹具随内核走。
const { SESSION_FORMAT_VERSION } = require('@deepseek-ai/dsh-session');

const MARKER = 'dsh-desktop compat: degrade session load to last complete frame';
// v2（历史）= 末帧守卫 + alpha.5 嵌套 tornMarker 契约（0.6.2~0.6.3 在野副本）；
// v3（本补丁当前产物，也是 registry 的幂等 marker）= rc.1 扁平 tornTruncateTo
// / recoveredTail 契约 + inheritedEventCount。
const MARKER_V2 = markers.SESSION_LOAD_GRACEFUL_MARKER_V2;
const MARKER_V3 = markers.SESSION_LOAD_GRACEFUL_MARKER_V3;
// 三世代注入体（单一数据源：逆运算登记表），供升级通道用例构造在野副本。
const K6_CATCH_BODIES = PRISTINE_INJECTIONS['session-load-graceful'].map(([, to]) => to);
const CATCH_BODY_V3 = K6_CATCH_BODIES.find((to) => to.includes(MARKER_V3));
const CATCH_BODY_V2 = K6_CATCH_BODIES.find((to) => to.includes(MARKER_V2));
const CATCH_BODY_V1 = SESSION_LOAD_GRACEFUL_CATCH_LEGACY;
const TORN_MARKER = 'dsh-desktop compat: recover complete zstd frame torn JSONL tail';
const CORRUPT_MARKER = 'dsh-desktop-corrupt-guard-v1';
const K5_MARKER = 'dsh-desktop fix: session header scan cache + bounded read';

const DESKTOP_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
// 内核源基准：靶文件本身（dev node_modules 副本）经 PRISTINE_FAMILIES 逆运算剥掉
// 全部四个持久化补丁后的字节。以前这里抓 .tmp-rc2-stage 装配产物，缺省静默回退
// dev node_modules —— 而 dev 副本会被 postinstall/patch-deps/运行时 boot 打过补丁，
// 回退后的“基准”其实是补丁态，于是 8 条 changed 断言集体退化成 already 假红，
// 且真漂移时同样只报 already（哨兵闭嘴）。逆运算对补丁态/pristine 都幂等，
// 不再依赖一次性构建目录。
const NM_TARGET = path.join(DESKTOP_ROOT, 'node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'index.js');

function kernelSourcePath() {
  assert.ok(fs.existsSync(NM_TARGET), '找不到内核靶文件：' + NM_TARGET);
  return NM_TARGET;
}

/** pristine 内核字节（从在野副本逆运算还原）。 */
function kernelSource() {
  return toPristineSource('session-persistence-family', fs.readFileSync(kernelSourcePath(), 'utf8'));
}

/** 在野副本原文（可能是 v1 形态，用作“升级产物 == 全新应用产物”的对账）。 */
function kernelShippedSource() {
  return fs.readFileSync(kernelSourcePath(), 'utf8');
}

/** pristine + 持久化族全链重放（= 真实运行时应得到的字节）。 */
function kernelFullyPatched() {
  const srcFile = kernelSourcePath();
  let src = kernelSource();
  for (const step of [transformPersistenceAll, transformSessionHeaderScanGuard, transformSessionLoadGraceful]) {
    const r = step(src, srcFile);
    assert.equal(r.status, 'changed', '全链重放逐步必须 changed（得 ' + r.status + ' 说基准不 pristine 或上游已漂移）：' + (r.detail || ''));
    src = r.src;
  }
  return src;
}

function frame(value) {
  return zstdCompressSync(Buffer.from(value, 'utf8'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
}

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dsh-k6-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 把内核源 transform 后写到包内 lib 目录（保证裸 specifier 可解析），动态 import 回来。 */
async function loadTransformedKernel(t) {
  const srcFile = kernelSourcePath();
  // pristine 源上先应用 torn-tail + corrupt-guard（与运行时 root 应用器后的形态
  // 一致），再叠加本补丁，保证「结构撕裂最后一帧回归」等行为测试在 pristine 源上
  // 也能复现 torn-tail 恢复语义（load-graceful 锚点特意取「pristine 与 torn-tail
  // 已应用形态共有的稳定行」，可叠加）。
  let src = kernelSource();
  const base = transformPersistenceAll(src, srcFile);
  assert.equal(base.status, 'changed', 'pristine 基准应未被 torn-tail 打过（否则逆运算没剥干净）');
  src = base.src;
  const r = transformSessionLoadGraceful(src, srcFile);
  assert.equal(r.status, 'changed', '内核源应命中本补丁锚点');
  const file = path.join(path.dirname(srcFile), 'index.k6test-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.mjs');
  fs.writeFileSync(file, r.src);
  t.after(() => fs.rmSync(file, { force: true }));
  return import(pathToFileURL(file).href);
}

/**
 * rc.1 的 header 契约：SESSION_FORMAT_VERSION 已从 alpha.5 的 0 升到 3，
 * 且 isSeeded 进入 HEADER_REQUIRED_KEYS（type/version/id/createdAt/isSeeded/
 * delegationDepth）。版本从内核包取，不写死——写死会让下一次版本 bump 只表现为
 * 行为用例的隐式抛错。
 */
function headerLine() {
  return JSON.stringify({
    type: 'session',
    version: SESSION_FORMAT_VERSION,
    id: 'k6-session',
    createdAt: 1,
    isSeeded: false,
    delegationDepth: 0,
    cwd: 'C:/fake',
    agentPreset: 'standard',
  }) + '\n';
}

/**
 * 从动态装载的内核模块解析持久化类。
 * rc.1 起 bundle 尾行是 `export { JsonlCompressionSchema, JsonlSessionPersistence as default }`
 * ——具名导出退役、只剩 default（alpha.5 时代两者都在）。保留对具名形态的兼容，
 * 但两条都拿不到时必须硬失败（不得静默退化成 undefined.prototype 的 TypeError）。
 */
function persistenceClassOf(mod) {
  const Klass = mod.JsonlSessionPersistence ?? mod.default;
  assert.equal(typeof Klass, 'function', '内核模块应导出 JsonlSessionPersistence（rc.1 起为 default 导出）');
  return Klass;
}

// ---------------------------------------------------------------------------
// 1-3：锚点命中 / 语法合法 / 幂等。
// ---------------------------------------------------------------------------

test('锚点命中内核源 → changed，含 marker（内容契约）', () => {
  // pristine 基准上先应用 torn-tail + corrupt-guard（与运行时 root 应用器后的
  // 形态一致），再应用本补丁，使「frameIndex 应改为赋值」等 torn-tail 组合断言
  // 在 pristine 源上同样成立（不依赖 dev 树已被打过补丁）。
  const srcFile = kernelSourcePath();
  let base = kernelSource();
  const prep = transformPersistenceAll(base, srcFile);
  assert.equal(prep.status, 'changed', 'pristine 基准应未被 torn-tail 打过');
  base = prep.src;
  const r = transformSessionLoadGraceful(base, srcFile);
  assert.equal(r.status, 'changed', '内核源应命中三个锚点');
  assert.ok(r.src.includes(MARKER_V3), '产物应含 v3 marker');
  assert.ok(r.src.includes('let scanner;'), '应提升 scanner 声明');
  assert.ok(r.src.includes('scanner = new SessionLogScanner(headerFrame.value);'), '应改为赋值而非 const 声明');
  assert.ok(r.src.includes('frameIndex = 1;'), 'frameIndex 应改为赋值');
  assert.ok(r.src.includes('degraded session load to last complete frame'), '应含降级告警文案');
  // v3 返回契约（rc.1 扁平 state 字段）：消费端只读顶层 tornTruncateTo /
  // recoveredTail / inheritedEventCount，嵌套 tornMarker 形态必须已退役。
  assert.ok(r.src.includes('tornTruncateTo: truncateTo,'), '降级应返回扁平 tornTruncateTo');
  assert.ok(r.src.includes('recoveredTail: []'), '降级应返回 recoveredTail: []');
  assert.ok(r.src.includes('inheritedEventCount: prefix.inheritedEventCount,'),
    '降级应透传 inheritedEventCount（缺失时 seeded 会话在 toHeaderLine 抛错）');
  assert.ok(!r.src.includes('tornMarker: {'), 'v3 产物不得再含 alpha.5 嵌套 tornMarker 返回体');
  assert.ok(r.src.includes('throw error;'), 'header 损坏仍重抛');
  // v2 收窄的末帧守卫在 v3 逐字沿用（本补丁的修复点不回退）。
  assert.ok(r.src.includes('loadFrameIndex >= frames.length - 1'),
    'catch 守卫必须含末帧判定，否则中帧损坏会被降级 + 截盘销毁完好帧');
});

test('升级通道：在野 v1 副本就地升级，产物与「pristine 全新应用」逐字节相同', (t) => {
  // 幂等判定靠 marker 短路，所以单改注入体文本是修不了在野副本的：已带 v1 catch
  // 体的文件里 catch 锚点已被吃掉，再跑一遍只会得到 already —— 包括重新 stage
  // 出来的 payload 与用户 profile 里的副本。本用例钉住 v1→v3 升级分支存在且收敛。
  const shipped = kernelShippedSource();
  const hasV1 = shipped.includes(MARKER) && !shipped.includes(MARKER_V2) && !shipped.includes(MARKER_V3);
  const normalized = hasV1 ? (() => {
    const r = transformSessionLoadGraceful(shipped, NM_TARGET);
    assert.equal(r.status, 'changed', '在野 v1 副本必须走升级通道（不得被 marker 短路拦成 already）');
    assert.equal(r.note, 'v1-repair');
    assert.ok(r.src.includes(MARKER_V3), '升级后应带 v3 marker');
    assert.ok(r.src.includes('loadFrameIndex >= frames.length - 1'), '升级后应带末帧守卫');
    return r.src;
  })() : shipped;
  assert.equal(transformSessionLoadGraceful(normalized, NM_TARGET).status, 'already', '升级后二遍必须幂等');
  if (shipped.includes(K5_MARKER)) {
    // 在野副本带齐全链时，规范化后的字节必须等于「pristine 重放全链」的产物；
    // 不等则说明逆运算推的历史与在野形态有出入（或者升级分支漏改了文本）。
    assert.equal(normalized, kernelFullyPatched(),
      'v1→v3 升级产物必须与「pristine 全新应用」逐字节相同');
  } else {
    t.diagnostic('在野副本未带 K5（环境差异），跳过全链逐字节对账');
  }
  // 确定性构造（不依赖盘上恰好存在 v1 副本）：在全链 v3 产物上把注入体换回
  // v1 历史字节，v1→v3 升级必须逐字节还原成全新应用产物。
  const full = kernelFullyPatched();
  assert.ok(full.includes(CATCH_BODY_V3), '全链重放产物应含 v3 注入体');
  const v1Copy = full.split(CATCH_BODY_V3).join(CATCH_BODY_V1);
  assert.ok(!v1Copy.includes(MARKER_V2) && !v1Copy.includes(MARKER_V3), '构造的在野 v1 副本不得带新世代 marker');
  const r = transformSessionLoadGraceful(v1Copy, NM_TARGET);
  assert.equal(r.status, 'changed', '在野 v1 形态必须走升级通道');
  assert.equal(r.note, 'v1-repair');
  assert.equal(r.src, full, 'v1→v3：升级产物必须与「pristine 全新应用」逐字节相同');
  assert.equal(transformSessionLoadGraceful(r.src, NM_TARGET).status, 'already', 'v1→v3 升级后二遍必须幂等');
});

test('升级通道：在野 v2 副本就地换扁平契约，产物与「pristine 全新应用」逐字节相同', () => {
  // v2 体（alpha.5 嵌套 tornMarker 契约）在 rc.1 上是死代码——降级不截盘也不
  // 回灌。v2→v3 通道必须把在野 v2 副本就地补成 v3，且收敛到与全新应用逐字节
  // 相同（整块历史字面量替换由构造保证，不依赖差异处清单保持同步）。
  const full = kernelFullyPatched();
  const v2Copy = full.split(CATCH_BODY_V3).join(CATCH_BODY_V2);
  assert.ok(v2Copy.includes(CATCH_BODY_V2) && v2Copy.includes('tornMarker: {'),
    '构造的在野 v2 副本应含 alpha.5 嵌套返回体');
  assert.ok(!v2Copy.includes(MARKER_V3), '构造的在野 v2 副本不得带 v3 marker');
  const r = transformSessionLoadGraceful(v2Copy, NM_TARGET);
  assert.equal(r.status, 'changed', '在野 v2 形态必须走升级通道（不得被 marker 短路拦成 already）');
  assert.equal(r.note, 'v2-repair');
  assert.ok(!r.src.includes('tornMarker: {'), '升级产物不得残留嵌套 tornMarker 返回体');
  assert.ok(r.src.includes('inheritedEventCount: prefix.inheritedEventCount,'),
    '升级产物应补上 rc.1 必填的 inheritedEventCount');
  assert.equal(r.src, full, 'v2→v3：升级产物必须与「pristine 全新应用」逐字节相同');
  assert.equal(transformSessionLoadGraceful(r.src, NM_TARGET).status, 'already', 'v2→v3 升级后二遍必须幂等');
});

test('transform 产物语法合法（node --check）', (t) => {
  const r = transformSessionLoadGraceful(kernelSource(), NM_TARGET);
  assert.equal(r.status, 'changed');
  const dir = tmpdir(t, 'dsh-k6-check-');
  const checkFile = path.join(dir, 'index.mjs');
  fs.writeFileSync(checkFile, r.src);
  const res = spawnSync(process.execPath, ['--check', checkFile], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, '补丁产物必须语法合法: ' + (res.stderr || ''));
});

test('幂等：第二遍 already / marker-only 短路 / 锚点缺失 anchor-missing 不改写', () => {
  const changed = transformSessionLoadGraceful(kernelSource(), NM_TARGET);
  assert.equal(changed.status, 'changed');
  assert.equal(transformSessionLoadGraceful(changed.src, NM_TARGET).status, 'already');
  assert.equal(transformSessionLoadGraceful('// ' + MARKER_V3 + '\n', 't.js').status, 'already');
  // 只带 v2 / v1 marker、不带任何世代注入体的文本：既不能当 already（那是旧补丁
  // 的形态），也不能被重注（会双份注入），必须落 anchor-missing 让上层告警退役。
  assert.equal(transformSessionLoadGraceful('// ' + MARKER_V2 + '\n', 't.js').status, 'anchor-missing');
  assert.equal(transformSessionLoadGraceful('// ' + MARKER + '\n', 't.js').status, 'anchor-missing');
  const miss = transformSessionLoadGraceful('export const x = 1;', 't.js');
  assert.equal(miss.status, 'anchor-missing');
  assert.ok(miss.detail.includes('版本可能已变更'));
  assert.equal(miss.src, undefined, '失配时不得返回改写源');
});

// ---------------------------------------------------------------------------
// 4：行为（动态 import 真实内核 transform 产物）。
// ---------------------------------------------------------------------------
//
// 帧体一律用 turn: 1 而非 0：0.2.0-rc.2 的 v3→v4 迁移校验器从 nextTurn = 1 起算
// （@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js:544，判据在 :747
// `data["turn"] !== this.nextTurn` → SessionFormatError）。turn: 0 会让这条格式
// 校验抢在被测分支之前失败：干净日志直接抛错，损坏帧用例则把降级原因换成
// 「turn/start does not open the expected turn」而 seq 断档/撕裂那两腿根本没走到
// ——绿灯是假的。夹具必须先合法，测的才是它声明的那条腿。

test('干净日志：正常读回事件、无 tornMarker', async (t) => {
  const mod = await loadTransformedKernel(t);
  const backend = Object.create(persistenceClassOf(mod).prototype);
  const hf = frame(headerLine());
  const ef = frame(
    JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }) + '\n' +
    JSON.stringify({ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }) + '\n',
  );
  const result = await backend.readZstdPrefix(Buffer.concat([hf, ef]), undefined);
  assert.deepEqual(result.events.map((e) => e.type), ['turn/start', 'turn/end']);
  assert.equal(result.tornMarker, undefined);
  // rc.1 扁平契约：干净路径不得请求截盘（tornTruncateTo 缺席）；上游正常路径
  // 恒带 recoveredTail，干净读时它必须恰为空数组（persistBatch 无回灌）。
  assert.equal(result.tornTruncateTo, undefined, '干净日志不得带 tornTruncateTo');
  assert.deepEqual(result.recoveredTail ?? [], [], '干净日志的 recoveredTail 必须为空');
});

test('seq 断档损坏帧：优雅降级为扁平 tornTruncateTo、不抛致命错、且告警', async (t) => {
  // NOTE(0.6.4 v3 重基线)：本用例钉的是 **本补丁注入体** 的返回形态。rc.1 把
  // 上游契约从嵌套 `tornMarker:{truncateTo,recoveredEvents}` 改名为顶层
  // `tornTruncateTo` + `recoveredTail`（consume 端据此驱动 storage.truncateTornTail
  // 截盘与 storage.persistBatch 回灌），v2 注入体在 rc.1 上是死代码。v3 注入体
  // 返回扁平字段并透传 inheritedEventCount，「按 truncateTo 截盘修复」一腿恢复生效。
  const mod = await loadTransformedKernel(t);
  const backend = Object.create(persistenceClassOf(mod).prototype);
  const hf = frame(headerLine());
  // seq=5 与 scanner 期望的 seq=0 断档 → SessionLogScanner 标记 issue →
  // 帧级 committedBytes !== inputBytes → 原实现抛「complete frame contains a torn JSONL record」。
  const ef = frame(JSON.stringify({ type: 'turn/start', seq: 5, time: 1, data: { turn: 1 } }) + '\n');
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (msg) => { warns.push(String(msg)); };
  t.after(() => { console.warn = originalWarn; });
  try {
    const result = await backend.readZstdPrefix(Buffer.concat([hf, ef]), undefined);
    assert.deepEqual(result.events, [], '断档帧内事件不得进入已解码前缀');
    assert.equal(result.tornMarker, undefined, 'v3 产物不得再带 alpha.5 嵌套 tornMarker 形态');
    assert.ok(Number.isInteger(result.tornTruncateTo), '应返回扁平 tornTruncateTo 而非抛错');
    assert.equal(result.tornTruncateTo, hf.length, 'tornTruncateTo 应指向损坏帧起始（header 帧之后）');
    assert.deepEqual(result.recoveredTail, []);
    assert.equal(warns.length, 1, '降级应 emit 一条 console.warn 告警');
    assert.ok(warns[0].includes('degraded session load to last complete frame'), '告警应含降级文案');
    // 反证（防假绿）：告警必须带上「帧内 JSONL 撕裂」这条真实诱因。夹具一旦退回
    // turn: 0，rc.2 的迁移校验会先抛 SessionFormatError，降级照样发生、断言照样绿，
    // 但被测的 seq 断档那条腿根本没走到——只有钉住诱因才分得清是哪条腿触发的。
    assert.match(warns[0], /complete frame contains a torn JSONL record/,
      '降级诱因应是 seq 断档导致的帧内撕裂，不得被格式校验错误抢先');
  } finally {
    console.warn = originalWarn;
  }
});

test('结构撕裂最后一帧回归：既有 torn-tail 恢复仍生效（无致命错）', async (t) => {
  const mod = await loadTransformedKernel(t);
  const backend = Object.create(persistenceClassOf(mod).prototype);
  const hf = frame(headerLine());
  // 完整 turn/start 帧后接一个被截断的帧（结构撕裂）。
  const ef = frame(JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }) + '\n');
  const torn = ef.subarray(0, ef.length - 10);
  const result = await backend.readZstdPrefix(Buffer.concat([hf, torn]), undefined);
  assert.ok(Array.isArray(result.events), '结构撕裂帧不得导致抛错');
  // rc.1 上游契约改名：alpha.5 的 `tornMarker: { truncateTo, recoveredEvents }`
  // 变为顶层 `tornTruncateTo` + `recoveredTail`（readZstdPrefix 撕裂分支与其
  // consume 端只认新名）。断言语义不变：撕裂落在尾巴上、截断偏移指向撕裂帧起始。
  assert.equal(result.tornTruncateTo, hf.length, 'tornTruncateTo 应指向撕裂帧起始');
  assert.ok(Array.isArray(result.recoveredTail), 'recoveredTail 应为数组（撕裂帧内已恢复的事件）');
});

test('header 帧损坏仍致命：scanner 未建立即重抛', async (t) => {
  const mod = await loadTransformedKernel(t);
  const backend = Object.create(persistenceClassOf(mod).prototype);
  // 合法 zstd 帧但内容不是 JSON header → SessionLogScanner 构造失败，scanner 未建立 → 重抛。
  const badHdr = frame('garbage not json\n');
  await assert.rejects(
    backend.readZstdPrefix(badHdr, undefined),
    /corrupt session log: header line is not valid JSON/,
    'header 帧损坏必须保持致命（不能降级为无 header 的会话）',
  );
});

// 中帧损坏（损坏帧不是最后一个帧）：v1 不设位置守卫，中帧损坏也会返回
// tornMarker，而上游 commitRepair 拿到 marker 后是 `repair(meta, truncateTo)`
// —— 按字节截磁盘文件。后果：损坏帧之后的完好帧被连带销毁，而且是在用户
// 下次打开历史时静默发生。torn-tail 自身声明 earlier frame 的撕裂记录仍是硬
// 错误，所以“仅末帧才降级”同时满足两边的契约。
test('中帧损坏（末帧之前）：仍硬抛，不得降级截盘销毁其后完好帧', async (t) => {
  const mod = await loadTransformedKernel(t);
  const backend = Object.create(persistenceClassOf(mod).prototype);
  const hf = frame(headerLine());
  const goodFrame = frame(JSON.stringify({ type: 'turn/end', seq: 9, time: 3, data: { turn: 1, reason: { kind: 'completed' } } }) + '\n');
  const cases = [
    ['结构完整但帧内 JSONL 撕裂', frame(JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }) + '\n{"type":"assistant/message","seq":1')],
    ['结构完整但 seq 断档', frame(JSON.stringify({ type: 'turn/start', seq: 5, time: 1, data: { turn: 1 } }) + '\n')],
  ];
  for (const [name, midBad] of cases) {
    const warns = [];
    const originalWarn = console.warn;
    console.warn = (msg) => { warns.push(String(msg)); };
    try {
      await assert.rejects(
        backend.readZstdPrefix(Buffer.concat([hf, midBad, goodFrame]), undefined),
        /complete frame contains a torn JSONL record/,
        name + '：中帧损坏必须硬抛（上游 torn-tail 明文契约）',
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warns.filter((w) => w.includes('degraded session load')).length, 0,
      name + '：中帧损坏不得 emit 降级告警（那意味着 commitRepair 会截盘销毁完好帧）');
  }
});

// ---------------------------------------------------------------------------
// 5：回归 —— torn-tail / corrupt-guard / K5 语义共存。
// ---------------------------------------------------------------------------

test('回归：叠加 torn-tail/corrupt-guard/K5 后本补丁仍命中、三 marker 共存', () => {
  let base = kernelSource();
  const all = transformPersistenceAll(base, NM_TARGET);
  if (all.status === 'changed') base = all.src;
  const k5 = transformSessionHeaderScanGuard(base, NM_TARGET);
  if (k5.status === 'changed') base = k5.src;
  const k6 = transformSessionLoadGraceful(base, NM_TARGET);
  assert.equal(k6.status, 'changed', '叠加既有补丁后本补丁仍应命中');
  const out = k6.src;
  assert.ok(out.includes(TORN_MARKER), 'torn-tail marker 应保留');
  assert.ok(out.includes(CORRUPT_MARKER), 'corrupt-guard marker 应保留');
  assert.ok(out.includes(K5_MARKER), 'K5 header 扫描缓存 marker 应保留');
  assert.ok(out.includes(MARKER), '本补丁 marker 应存在');
  // rc.2 形态：corrupt-guard 不注入独立的 `catch (corruptError)` 块（alpha.5 形
  // 态），而是改写 listGenerations 既有的 `catch (error)`——保留内核自己的「白名单
  // 类先行 continue」那行，再补告警 + continue。rc.2 把白名单从单类
  // （SessionFormatUnsupportedError）扩成两类（|| SessionPersistenceCorruptionError，
  // 后者是 rc.1 起 header 扫描越界/撕裂抛的损坏类），断言按可选两类别形态匹配，
  // 并单独钉住第二类必须在内——漏了它，header 撕裂的会话会把启动扫描整个击穿。
  assert.ok(
    /try \{\n\t+header = await this\.readGenerationHeader\(selected, void 0, signal\);\n\t+\} catch \(error\) \{\n\t+if \(error instanceof SessionFormatUnsupportedError(?: \|\| error instanceof SessionPersistenceCorruptionError)?\) continue;\n\t+\/\/ dsh-desktop-corrupt-guard-v1/.test(out),
    'corrupt-guard 应改写在既有 catch(error) 且保留格式版本先行 continue',
  );
  assert.ok(
    out.includes('error instanceof SessionPersistenceCorruptionError) continue;'),
    'rc.2 白名单必须含 SessionPersistenceCorruptionError（单类别 continue 是 rc.1 前的旧形态）',
  );
  assert.ok(out.includes('skipping corrupt session log'), 'corrupt-guard warn 跳过文案应保留');
  assert.match(out, /skipping corrupt session log[^\n]*\n\t+continue;/, 'corrupt-guard 告警后应 continue 跳过该会话');
});

// ---------------------------------------------------------------------------
// 6：registry 装配。
// ---------------------------------------------------------------------------

test('registry：session-load-graceful 规格装配与布局正确', () => {
  const spec = PATCH_SPECS.find((s) => s.id === 'session-load-graceful');
  assert.ok(spec, '注册表应含 session-load-graceful');
  assert.equal(spec.kind, 'file');
  assert.equal(spec.layout, 'runtime-local');
  assert.equal(spec.wslLayout, 'wsl');
  assert.equal(spec.failPolicy, 'warn');
  assert.equal(spec.cli, false, 'cli:false（对齐 session-header-scan-guard 先例，不动 CLI 清单）');
  assert.equal(spec.transform, transformSessionLoadGraceful, 'transform 与 patch-adapters 导出同源');
  assert.equal(spec.marker, MARKER_V3, '幂等 marker 必须是 v3（用 v1/v2 会把在野副本拦在升级通道外）');
  assert.equal(markers.SESSION_LOAD_GRACEFUL_MARKER_V3, MARKER_V3, 'marker 单一数据源导出');
  assert.equal(PERSISTENCE_PKG_REL.split(path.sep).join('/'), 'dsh-session-persistence-jsonl/lib/index.js', '目标文件为会话持久化运行时入口');
  assert.ok(!getSpecsByCli().some((s) => s.id === 'session-load-graceful'), 'cli:false 不进 CLI 清单');
});

test('registry：runtime-local / wsl 布局落点覆盖内核可加载副本', () => {
  const spec = PATCH_SPECS.find((s) => s.id === 'session-load-graceful');
  const ctx = { home: 'C:\\h', appDir: 'C:\\app', userDataDir: 'C:\\ud', wslMode: false };
  const local = resolvePatchTargets(ctx, { ...spec, pkgRel: PERSISTENCE_PKG_REL });
  const norm = (f) => f.split(path.sep).join('/');
  assert.ok(local.some((f) => norm(f) === 'C:/app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'), '本地副本须含 appDir 内核副本');
  assert.ok(local.some((f) => norm(f).startsWith('C:/h/profiles/node_modules/')), '含 profile fallback 副本');
  assert.ok(local.some((f) => norm(f).startsWith('C:/ud/agent/node_modules/')), '含 agent overlay 副本');
  const wsl = resolvePatchTargets({ ...ctx, wslMode: true }, { ...spec, pkgRel: PERSISTENCE_PKG_REL });
  assert.ok(wsl.some((f) => norm(f) === 'C:/h/agent/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'), 'WSL 布局须含 UNC agent 副本');
});
