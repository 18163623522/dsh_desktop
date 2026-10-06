'use strict';

// unit-session-header-scan-guard.test.js — v0.5.4 求稳补丁（K5）单测。
//
// 根因（用户实测，直接采信）：打开子代理 → dsh-subagent 调 persistence.list()
// → listArtifacts 全量扫描 291 个会话文件、每个都 zstd 解压 header；机器 commit
// 内存吃紧（WebView2 866MB + OpenCode/msedge/marktext），全量扫描把内核 node 顶
// 爆 OOM（堆 150-260MB 就「Committing semi space failed」）→ 崩溃环。
//
// 补丁（patch-adapters.transformSessionHeaderScanGuard）对内核
// dsh-session-persistence-jsonl/lib/index.js 做两件事：
//   1) header 扫描缓存：listArtifacts 读 header 前先 stat，命中 (path,size,
//      mtimeNs) 缓存直接复用（二次 list()/刷新列表零解码），未命中才读首行并
//      写缓存；size/mtimeNs 任一变化即失效重读；
//   2) 读取上限：readFirstZstdLine 累积缓冲超 256KB 仍未找到完整首帧即抛错
//      （被 listArtifacts 既有 corrupt-guard catch 后 warn 跳过，不击穿扫描）。
//
// 测试手法（与 unit-adapter-prepare-call-guard 同款）：
//   1) 锚点命中 pristine 内核源（.tmp-kernel/.consumer-<ver> 离线解包根，经
//      pristine-kernel-roots.findPristineFile 跨根探测），缺省回退最小 fixture；
//   2) transform 产物 node --check 语法合法；
//   3) 幂等（二遍 already）/ 锚点缺失 anchor-missing 不改写；
//   4) 行为（vm/动态 import 执行真实注入产物，非复述实现）：用自包含最小 ESM
//      fixture 装载 transform 产物，实例化类后验证缓存命中零解码、文件变更失效
//      重读、读取上限抛错；
//   5) 回归：session-persistence（corrupt-guard）先应用后再叠加本补丁，损坏
//      跳过 + warn 语义保留；
//   6) registry 装配（layout / pkgRel / transform / marker 同源 / cli:false）。
//
// 运行：node --test scripts/test/unit-session-header-scan-guard.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const {
  transformSessionHeaderScanGuard,
  transformPersistenceAll,
  markers,
} = require('../lib/patch-adapters');
const { PATCH_SPECS, getSpecsByCli } = require('../lib/patch-registry');
const { PERSISTENCE_PKG_REL, resolvePatchTargets } = require('../lib/patch-target-resolver');

const MARKER = 'dsh-desktop fix: session header scan cache + bounded read';
const MAX_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// 自包含最小 ESM fixture：包含本补丁四个锚点（isENOENT / readFirstZstdLine JSDoc
// / listArtifacts read expression / readFirstZstdLine concat），可被 transform 命中，
// 又能动态 import 后实例化做行为验证。scanZstdFrames 恒不返回帧，使 readFirstZstdLine
// 累积到 EOF（返回 void 0）或触发读取上限（抛错）——无需真实 zstd 依赖。
// ---------------------------------------------------------------------------
const FIXTURE = [
  'import { open, stat } from "node:fs/promises";',
  // 真实内核从 @deepseek-ai/dsh-session-persistence 导入该类（rc.1 起在 import 列
  // 表里）；fixture 自包含，用同形本地类替代。读上限注入体必须抛**这个类**——
  // listArtifacts 的 corrupt-guard 白名单只收容它与 SessionFormatUnsupportedError，
  // 裸 Error 会击穿启动扫描。
  'class SessionPersistenceCorruptionError extends Error {',
  '\tconstructor(message) {',
  '\t\tsuper(message);',
  '\t\tthis.name = "SessionPersistenceCorruptionError";',
  '\t}',
  '}',
  'function scanZstdFrames(buffer, maxFrames) {',
  '\t// test stub: never finds a frame, so readFirstZstdLine accumulates to EOF or the cap.',
  '\treturn { frames: [] };',
  '}',
  'function isENOENT(error) {',
  '\treturn error?.code === "ENOENT";',
  '}',
  'var JsonlSessionPersistence = class {',
  '\tconstructor(compression) {',
  '\t\tthis.compression = compression;',
  '\t\tthis.zstdReads = 0;',
  '\t\tthis.lineReads = 0;',
  '\t}',
  '\tasync readFirstLine(path, signal) {',
  '\t\tthis.lineReads += 1;',
  '\t\tconst handle = await open(path, "r");',
  '\t\ttry {',
  '\t\t\tconst chunks = [];',
  '\t\t\tconst buf = Buffer.alloc(8192);',
  '\t\t\tfor (;;) {',
  '\t\t\t\tconst { bytesRead } = await handle.read(buf, 0, buf.length, null);',
  '\t\t\t\tif (bytesRead === 0) return void 0;',
  '\t\t\t\tconst slice = buf.subarray(0, bytesRead);',
  '\t\t\t\tconst nl = slice.indexOf(10);',
  '\t\t\t\tif (nl !== -1) {',
  '\t\t\t\t\tchunks.push(slice.subarray(0, nl));',
  '\t\t\t\t\treturn Buffer.concat(chunks).toString("utf8");',
  '\t\t\t\t}',
  '\t\t\t\tchunks.push(Buffer.from(slice));',
  '\t\t\t}',
  '\t\t} finally {',
  '\t\t\tawait handle.close();',
  '\t\t}',
  '\t}',
  '\t/** Read and validate only the independently compressed header frame. */',
  '\tasync readFirstZstdLine(path, signal) {',
  '\t\tthis.zstdReads += 1;',
  '\t\tconst handle = await open(path, "r");',
  '\t\ttry {',
  '\t\t\tlet content = Buffer.alloc(0);',
  '\t\t\tconst chunk = Buffer.alloc(8192);',
  '\t\t\tfor (;;) {',
  '\t\t\t\tconst { bytesRead } = await handle.read(chunk, 0, chunk.length, null);',
  '\t\t\t\tif (bytesRead === 0) return void 0;',
  '\t\t\t\tcontent = Buffer.concat([content, chunk.subarray(0, bytesRead)]);',
  '\t\t\t\tconst first = scanZstdFrames(content, 1).frames[0];',
  '\t\t\t\tif (first === void 0) continue;',
  '\t\t\t\treturn "unused";',
  '\t\t\t}',
  '\t\t} finally {',
  '\t\t\tawait handle.close();',
  '\t\t}',
  '\t}',
  '\tasync listArtifacts(signal) {',
  '\t\tconst selected = { sourcePath: "/unused/session.jsonl.zstd" };',
  '\t\treturn await this.readGenerationHeader(selected, void 0, signal);',
  '\t}',
  // rc.1 形态：listArtifacts 的首行读取下沉进 readGenerationHeader(selected)，
  // 读表达式按 selected.sourcePath 取径（alpha.5 直接在 listArtifacts 里用
  // `path` 形参 —— 补丁锚点已随上游重锚，fixture 必须同形态才能自证）。
  '\tasync readGenerationHeader(selected, expectedId, signal) {',
  '\t\tlet first;',
  '\t\ttry {',
  '\t\t\tfirst = this.compression === "zstd" ? await this.readFirstZstdLine(selected.sourcePath, signal) : await this.readFirstLine(selected.sourcePath, signal);',
  '\t\t} catch (error) {',
  '\t\t\tsignal?.throwIfAborted();',
  '\t\t\tif (isENOENT(error)) return void 0;',
  '\t\t\tthrow error;',
  '\t\t}',
  '\t\treturn first;',
  '\t}',
  '};',
  'export { JsonlSessionPersistence, SessionPersistenceCorruptionError };',
].join('\n');

// pristine 内核源（由 scripts/install-pristine-kernel.mjs 离线解包的
// .tmp-kernel/.consumer-<ver> 消费根，跨根探测走 pristine-kernel-roots 的
// findPristineFile——上一代写死的 .tmp-rc2-stage 一次性暂存目录已随换版消失，
// 当时静默回退 fixture，等于内容契约测试在自造字节上自证），缺省回退 fixture。
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const { findPristineFile } = require('../lib/pristine-kernel-roots');

function pristineSource() {
  const hit = findPristineFile(PERSISTENCE_PKG_REL);
  if (hit && fs.existsSync(hit)) return fs.readFileSync(hit, 'utf8');
  return FIXTURE;
}

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dsh-k5-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 装载 transform 后的 fixture（动态 import，独立模块缓存 → 每次全新 sessionHeaderScanCache）。 */
async function loadPatchedModule(t, src) {
  const dir = tmpdir(t, 'dsh-k5-mod-');
  const file = path.join(dir, 'fixture-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.mjs');
  fs.writeFileSync(file, src);
  const mod = await import(pathToFileURL(file).href);
  return mod;
}

/** 把 fixture 的 JsonlSessionPersistence 用给定 src 装载并实例化。 */
async function instantiate(t, src, compression = 'none') {
  const mod = await loadPatchedModule(t, src);
  return new mod.JsonlSessionPersistence(compression);
}

// ---------------------------------------------------------------------------
// 1-3：锚点命中 pristine / 语法合法 / 幂等。
// ---------------------------------------------------------------------------

test('锚点命中 pristine 内核源 → changed，含 marker/缓存/helper/读上限（内容契约）', () => {
  const src = pristineSource();
  const r = transformSessionHeaderScanGuard(src, 'index.js');
  assert.equal(r.status, 'changed', 'pristine 源应命中锚点');
  assert.ok(r.src.includes(MARKER), '产物应含 marker');
  assert.ok(r.src.includes('const ZSTD_HEADER_SCAN_MAX_BYTES = 256 * 1024;'), '应含读取上限常量');
  assert.ok(r.src.includes('const sessionHeaderScanCache = new Map();'), '应含模块级缓存 Map');
  assert.ok(r.src.includes('function sessionHeaderScanCacheGet('), '应含缓存 get');
  assert.ok(r.src.includes('function sessionHeaderScanCacheSet('), '应含缓存 set');
  assert.ok(r.src.includes('async readHeaderLineCached(path, signal) {'), '应注入 helper 方法');
  assert.ok(r.src.includes('first = await this.readHeaderLineCached(selected.sourcePath, signal);'), 'rc.1 读行点（readGenerationHeader）应改走 helper');
  assert.ok(r.src.includes('content.length > ZSTD_HEADER_SCAN_MAX_BYTES'), '应注入读上限判定');
  // 幂等：二遍 already。
  assert.equal(transformSessionHeaderScanGuard(r.src, 'index.js').status, 'already');
});

test('transform 产物语法合法（node --check）', (t) => {
  const dir = tmpdir(t, 'dsh-k5-check-');
  const out = transformSessionHeaderScanGuard(pristineSource(), 'index.js');
  assert.equal(out.status, 'changed');
  const checkFile = path.join(dir, 'index.mjs');
  fs.writeFileSync(checkFile, out.src);
  const res = spawnSync(process.execPath, ['--check', checkFile], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, '补丁产物必须语法合法: ' + (res.stderr || ''));
});

test('幂等：第二遍 already / marker-only 短路 / 无锚点 anchor-missing 不改写', () => {
  const changed = transformSessionHeaderScanGuard(pristineSource(), 't.js');
  assert.equal(changed.status, 'changed');
  assert.equal(transformSessionHeaderScanGuard(changed.src, 't.js').status, 'already');
  assert.equal(transformSessionHeaderScanGuard('// ' + MARKER + '\n', 't.js').status, 'already');
  const miss = transformSessionHeaderScanGuard('export const x = 1;', 't.js');
  assert.equal(miss.status, 'anchor-missing');
  assert.ok(miss.detail.includes('版本可能已变更'));
  assert.equal(miss.src, undefined, '失配时不得返回改写源');
});

// ---------------------------------------------------------------------------
// 4：行为（动态 import 执行真实注入产物）。
// ---------------------------------------------------------------------------

test('缓存命中：同一文件二次读零解码（readFirstLine 计数不增）', async (t) => {
  const inst = await instantiate(t, transformSessionHeaderScanGuard(FIXTURE, 'f.mjs').src, 'none');
  const dir = tmpdir(t, 'dsh-k5-cache-');
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, '{"type":"session","id":"s1"}\n');

  const first = await inst.readHeaderLineCached(file, undefined);
  assert.equal(first, '{"type":"session","id":"s1"}');
  assert.equal(inst.lineReads, 1, '首次读应触发一次 readFirstLine');

  const second = await inst.readHeaderLineCached(file, undefined);
  assert.equal(second, '{"type":"session","id":"s1"}');
  assert.equal(inst.lineReads, 1, '缓存命中不得再次解码（readFirstLine 计数不增）');
});

test('缓存失效：文件 size 变化后重读（不掩盖真实变更）', async (t) => {
  const inst = await instantiate(t, transformSessionHeaderScanGuard(FIXTURE, 'f.mjs').src, 'none');
  const dir = tmpdir(t, 'dsh-k5-inv-');
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, '{"type":"session","id":"v1"}\n');
  assert.equal(await inst.readHeaderLineCached(file, undefined), '{"type":"session","id":"v1"}');
  assert.equal(inst.lineReads, 1);

  // 长度不同的新内容 → size 变化 → 缓存失效重读。
  fs.writeFileSync(file, '{"type":"session","id":"v2-longer"}\n');
  assert.equal(await inst.readHeaderLineCached(file, undefined), '{"type":"session","id":"v2-longer"}');
  assert.equal(inst.lineReads, 2, '文件变更后必须失效重读');
});

test('读取上限：>256KB 无完整首帧 → 抛损坏类错误而非无限累积', async (t) => {
  const mod = await loadPatchedModule(t, transformSessionHeaderScanGuard(FIXTURE, 'f.mjs').src);
  const inst = new mod.JsonlSessionPersistence('zstd');
  const dir = tmpdir(t, 'dsh-k5-cap-');
  const file = path.join(dir, 'session.jsonl.zstd');
  fs.writeFileSync(file, Buffer.alloc(300 * 1024, 0x41)); // 300KB 无 zstd 首帧

  await assert.rejects(
    inst.readFirstZstdLine(file, undefined),
    (err) => err instanceof mod.SessionPersistenceCorruptionError
      && err.message.includes('no complete header frame within')
      && err.message.includes(String(MAX_BYTES)),
    '累积超 256KB 无首帧应抛 SessionPersistenceCorruptionError（corrupt-guard 白名单只收容它，裸 Error 击穿启动扫描）',
  );
  assert.equal(inst.zstdReads, 1, '读上限路径只触发一次读取入口');
});

test('内存代理：多文件二次扫描零解码（首扫 N 次，次扫 0 次）', async (t) => {
  const inst = await instantiate(t, transformSessionHeaderScanGuard(FIXTURE, 'f.mjs').src, 'none');
  const dir = tmpdir(t, 'dsh-k5-mem-');
  const files = [];
  for (let i = 0; i < 16; i += 1) {
    const file = path.join(dir, 'session-' + i + '.jsonl');
    fs.writeFileSync(file, `{"type":"session","id":"s${i}"}\n`);
    files.push(file);
  }

  // 首扫：逐文件读首行（解码）。
  for (const file of files) await inst.readHeaderLineCached(file, undefined);
  assert.equal(inst.lineReads, 16, '首扫应逐个解码');

  // 次扫：全部命中缓存 → 零解码（堆增量从「全量解码」收敛到 stat+Map 查询）。
  for (const file of files) await inst.readHeaderLineCached(file, undefined);
  assert.equal(inst.lineReads, 16, '次扫应零解码（readFirstLine 计数不再增长）');
});

// ---------------------------------------------------------------------------
// 5：回归 —— corrupt-guard 语义保留（与 session-persistence 叠加）。
// ---------------------------------------------------------------------------

test('回归：corrupt-guard 损坏跳过 + warn 语义保留（叠加应用后 read 仍被 try/catch 包裹）', () => {
  const src = pristineSource();
  // 先应用既有 session-persistence（torn-tail + corrupt-guard），再叠加本补丁。
  const guarded = transformPersistenceAll(src, 'index.js');
  let base;
  if (guarded.status === 'changed') base = guarded.src;
  else base = src;
  const r = transformSessionHeaderScanGuard(base, 'index.js');
  assert.equal(r.status, 'changed', 'corrupt-guard 形态上本补丁应命中');
  const out = r.src;
  assert.ok(out.includes('dsh-desktop-corrupt-guard-v1'), 'corrupt-guard marker 应保留');
  assert.ok(out.includes('skipping corrupt session log'), 'warn 跳过文案应保留');
  // rc.1→rc.2 形态：corrupt-guard 不再另起 `catch (corruptError)`（alpha.5 形态），而是
  // 就地改写 listArtifacts 包住 readGenerationHeader 调用的那个 catch(error)：
  // 上游原生白名单的两类（格式版本不兼容 + 持久化损坏）先行 continue，其余告警 +
  // continue 跳过该会话——第二类正是我们注入的读上限错误所依赖的收容路径。
  assert.match(out,
    /try \{\n\t+header = await this\.readGenerationHeader\(selected, void 0, signal\);\n\t+\} catch \(error\) \{\n\t+if \(error instanceof SessionFormatUnsupportedError(?: \|\| error instanceof SessionPersistenceCorruptionError)?\) continue;\n\t+\/\/ dsh-desktop-corrupt-guard-v1[^\n]*\n\t+console\.warn\(`\[dsh-session-persistence\] skipping corrupt session log: \$\{selected\.sourcePath\}[^\n]*\n\t+continue;\n\t+\}/,
    'corrupt-guard 应包住 readGenerationHeader 调用并保留 版本continue/告警/continue 三要素');
  assert.ok(out.includes('error instanceof SessionPersistenceCorruptionError) continue;'),
    'rc.2 上游白名单第二类的 continue 必须原样保留（我们只补不进白名单的那一类）');
  // 读行走 helper 且仍在 try 内（helper 的 stat/读上限抛错经 readGenerationHeader
  // 保留的重抛上抛，最终被 corrupt-guard 吸收，不击穿扫描）。
  const READ_CALL = 'first = await this.readHeaderLineCached(selected.sourcePath, signal);';
  const readIdx = out.indexOf(READ_CALL);
  assert.ok(readIdx !== -1, 'corrupt-guard 形态读行应改走 helper');
  const tryIdx = out.lastIndexOf('try {', readIdx);
  const innerCatchIdx = out.indexOf('} catch (error) {', readIdx);
  assert.ok(tryIdx !== -1 && innerCatchIdx > readIdx, 'helper 读行应位于 try/catch 内');
  assert.ok(out.slice(innerCatchIdx, innerCatchIdx + 220).includes('throw error;'),
    'readGenerationHeader 的 catch 应保留非 ENOENT 重抛（把损坏交给 corrupt-guard）');
});

// ---------------------------------------------------------------------------
// 6：registry 装配。
// ---------------------------------------------------------------------------

test('registry：session-header-scan-guard 规格装配与布局正确', () => {
  const spec = PATCH_SPECS.find((s) => s.id === 'session-header-scan-guard');
  assert.ok(spec, '注册表应含 session-header-scan-guard');
  assert.equal(spec.kind, 'file');
  assert.equal(spec.layout, 'runtime-local');
  assert.equal(spec.wslLayout, 'wsl');
  assert.equal(spec.failPolicy, 'warn');
  assert.equal(spec.cli, false, 'cli:false（对齐 agent-preset-fallback 先例，不动 CLI 清单）');
  assert.equal(spec.transform, transformSessionHeaderScanGuard, 'transform 与 patch-adapters 导出同源');
  assert.equal(spec.marker, MARKER);
  assert.equal(markers.SESSION_HEADER_SCAN_MARKER, MARKER, 'marker 单一数据源导出');
  assert.equal(PERSISTENCE_PKG_REL.split(path.sep).join('/'), 'dsh-session-persistence-jsonl/lib/index.js', '目标文件为会话持久化运行时入口');
  assert.ok(!getSpecsByCli().some((s) => s.id === 'session-header-scan-guard'), 'cli:false 不进 CLI 清单');
});

test('registry：runtime-local / wsl 布局落点覆盖内核可加载副本', () => {
  const spec = PATCH_SPECS.find((s) => s.id === 'session-header-scan-guard');
  const ctx = { home: 'C:\\h', appDir: 'C:\\app', userDataDir: 'C:\\ud', wslMode: false };
  const local = resolvePatchTargets(ctx, { ...spec, pkgRel: PERSISTENCE_PKG_REL });
  const norm = (f) => f.split(path.sep).join('/');
  assert.ok(local.some((f) => norm(f) === 'C:/app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'), '本地三副本须含 appDir 内核副本');
  assert.ok(local.some((f) => norm(f).startsWith('C:/h/profiles/node_modules/')), '含 profile fallback 副本');
  assert.ok(local.some((f) => norm(f).startsWith('C:/ud/agent/node_modules/')), '含 agent overlay 副本');
  const wsl = resolvePatchTargets({ ...ctx, wslMode: true }, { ...spec, pkgRel: PERSISTENCE_PKG_REL });
  assert.ok(wsl.some((f) => norm(f) === 'C:/h/agent/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'), 'WSL 布局须含 UNC agent 副本');
});
