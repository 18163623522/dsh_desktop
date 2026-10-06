#!/usr/bin/env node
// ta12-verify-update-sources.test.mjs —— verify-update-sources.mjs 行为级测试（node --test）。
//
// 注入方式：脚本 API URL 硬编码（api.github.com / gitee.com），无 --api-base 之类
// 注入口；但脚本尊重 HTTPS_PROXY（CONNECT 隧道）。因此用 ta12-verify-mock-stack.mjs
// （兄弟子进程，见其文件头说明）起 CONNECT 代理 + TLS MITM 端点（openssl 一次性
// CA，NODE_EXTRA_CA_CERTS 注入被测子进程），把 GitHub/Gitee API 与资产 URL 全部
// 落到本地 mock——重定向/HEAD content-length/边车下载均为真实 HTTP(S) 往返。
//
// 覆盖（退出码 + WARN/FAIL 分类）：
//   · 健康双源 → 0 且零 WARN；tag 漂移 → 1；--expect-version 不符 → 1
//   · 边车格式坏 → 1；边车哈希 != digest → 1
//   · HEAD content-length != API size → 1（GitHub 源与 Gitee 镜像各一）
//   · Gitee API 500 → 1；纯 WARN 场景（缺未超限资产/缺边车/无边车）→ 0
//   · 超限（>100MB）资产分片镜像：完整连续 + Σ==GitHub size → 0；无分片/断号/某片截断 → 1
//   · --test 自检 → 0；--help → 0；未知参数 → 1
// 运行：node --test dsh-tauri/scripts/ta12-verify-update-sources.test.mjs
// 依赖：openssl（仅测试临时目录，不触碰系统信任库）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'verify-update-sources.mjs');
const STACK = path.join(HERE, 'ta12-verify-mock-stack.mjs');
const HASH_A = 'a'.repeat(64); // 健康场景 digest/边车哈希
const HASH_B = 'b'.repeat(64); // 与 digest 不符的边车哈希

// ---------------------------------------------------------------------------
// mock 栈（单例兄弟进程）：stateFile 每用例改写，mock 每请求重读
// ---------------------------------------------------------------------------
let stack = null; // { child, port, ca, stateFile }

async function ensureStack() {
  if (stack) return stack;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ta12-vus-state-'));
  const stateFile = path.join(work, 'state.json');
  fs.writeFileSync(stateFile, '{}');
  const child = spawn(process.execPath, [STACK, stateFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  const info = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('mock 栈启动超时')), 30_000);
    child.stdout.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        try { resolve(JSON.parse(buf.slice(0, nl))); }
        catch (e) { reject(e); }
      }
    });
    child.on('exit', (c) => reject(new Error('mock 栈提前退出: ' + c)));
    child.stderr.on('data', (d) => process.stderr.write('[mock-stack] ' + d));
  });
  stack = { child, port: info.port, ca: info.ca, stateFile };
  return stack;
}

test.after(() => { if (stack) stack.child.kill(); });

function setState(s) {
  assert.ok(stack, 'mock 栈应已启动');
  fs.writeFileSync(stack.stateFile, JSON.stringify(s));
}

// —— 场景构造小工具 ——
const ghRelease = (tag, assets) => ({ tag_name: tag, prerelease: false,
  assets: assets.map((a) => ({ name: a.name, size: a.size, browser_download_url: a.url, digest: a.digest ?? null })) });
const geeRelease = (tag, assets) => ({ tag_name: tag,
  assets: assets.map((a) => ({ name: a.name, browser_download_url: a.url })) });

const MAIN_URL = 'https://objects.githubusercontent.com/gh/DSH-Setup-0.5.2.exe';
const SIDE_URL = 'https://objects.githubusercontent.com/gh/DSH-Setup-0.5.2.exe.sha256';
const GEE_MAIN_URL = 'https://gitee.com/att/DSH-Setup-0.5.2.exe';

/** 标准场景资产表；override(url→asset) 可改写 HEAD/边车行为。 */
function assetsMap(override = {}, geeMainLength = 1000) {
  return {
    [MAIN_URL]: { contentLength: 1000 },
    [SIDE_URL]: { body: `${HASH_A}  DSH-Setup-0.5.2.exe\n` },
    [GEE_MAIN_URL]: { contentLength: geeMainLength },
    'https://gitee.com/att/DSH-Setup-0.5.2.exe.sha256': { contentLength: 70 },
    ...override,
  };
}
const ghAssets = (digest = `sha256:${HASH_A}`) => [
  { name: 'DSH-Setup-0.5.2.exe', size: 1000, url: MAIN_URL, digest },
  { name: 'DSH-Setup-0.5.2.exe.sha256', size: 70, url: SIDE_URL },
];
const geeAssets = () => [
  { name: 'DSH-Setup-0.5.2.exe', url: GEE_MAIN_URL },
  { name: 'DSH-Setup-0.5.2.exe.sha256', url: 'https://gitee.com/att/DSH-Setup-0.5.2.exe.sha256' },
];

// ---------------------------------------------------------------------------
// 子进程驱动
// ---------------------------------------------------------------------------
// ⚠ 已知偶发（实测 2026-10-06）：FAIL 场景下被测子进程约 1/36 以 3221226505
// （STATUS_STACK_BUFFER_OVERRUN，Windows 的 abort/fastfail）终结，表现成
// 「3221226505 !== 1」这类看不懂的假红。已排除三种解释：
//   · 不是 harness —— pipe+timeout / 纯 pipe / stdio 落文件三种形态都会中，与
//     spawnSync 的 timeout、管道都无关；
//   · 不是场景绑定 —— 命中过的用例在「>100MB 分片」「HEAD 漂移」「digest 不符」
//     之间漂移，健康场景（exit 0）36/36 从不复现，只有含 FAIL 的运行会；
//   · 不是外部杀进程 —— Application 日志近 3h 零条 node.exe 崩溃记录。
// 崩点固定在「最后一条 [OK]/[FAIL] 打印之后、== 汇总 == 之前」，即 main() 末尾
// `process.exit(code)` 拆 CONNECT 隧道 socket 的收尾路径（verify-update-sources.mjs:442）。
// 用例保持严格（不把崩溃当通过）；真修要显式销毁隧道 socket，但那会给这个 dev-only
// 脚本引入挂等风险，暂记为已知项。
async function runVerify(args = []) {
  const s = await ensureStack();
  const env = {
    ...process.env,
    HTTPS_PROXY: `http://127.0.0.1:${s.port}`,
    https_proxy: `http://127.0.0.1:${s.port}`,
    HTTP_PROXY: `http://127.0.0.1:${s.port}`,
    http_proxy: `http://127.0.0.1:${s.port}`,
    NO_PROXY: '',
    no_proxy: '',
    NODE_EXTRA_CA_CERTS: s.ca,
  };
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, timeout: 120_000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const countTag = (out, tag) => (String(out).match(new RegExp(`\\[${tag}\\]`, 'g')) || []).length;

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test('行为级（本地 MITM mock）：健康双源 → exit 0、零 FAIL 零 WARN', async () => {
  await ensureStack();
  setState({ ghLatestCode: 200, geeLatestCode: 200,
    gh: ghRelease('v0.5.2', ghAssets()), gee: geeRelease('v0.5.2', geeAssets()),
    assets: assetsMap() });
  const r = await runVerify();
  assert.equal(r.code, 0, r.out);
  assert.equal(countTag(r.out, 'FAIL'), 0, r.out);
  assert.equal(countTag(r.out, 'WARN'), 0, '健康场景应为「全部通过」: ' + r.out);
  assert.ok(r.out.includes('双源 latest tag 一致'), r.out);
  assert.ok(r.out.includes('与 GitHub digest 一致'), '边车哈希与 digest 交叉核对应 OK: ' + r.out);
  assert.ok(/HEAD\(Gitee\).*content-length=1000 == GitHub size/.test(r.out), r.out);
});

test('行为级：tag 漂移（GitHub v0.5.2 vs Gitee v0.5.1）→ exit 1 + FAIL 镜像漂移', async () => {
  await ensureStack();
  setState({ gh: ghRelease('v0.5.2', ghAssets()), gee: geeRelease('v0.5.1', geeAssets()),
    assets: assetsMap() });
  const r = await runVerify();
  assert.equal(r.code, 1, '镜像漂移必须硬错: ' + r.out);
  assert.ok(r.out.includes('镜像漂移'), r.out);
});

test('行为级：--expect-version 不符 → 1；命中（v 前缀归一）→ 0', async () => {
  await ensureStack();
  setState({ gh: ghRelease('v0.5.2', ghAssets()), gee: geeRelease('v0.5.2', geeAssets()),
    assets: assetsMap() });
  const bad = await runVerify(['--expect-version', '0.9.9']);
  assert.equal(bad.code, 1, bad.out);
  assert.ok(bad.out.includes('!= 期望 0.9.9'), bad.out);
  const ok = await runVerify(['--expect-version', 'v0.5.2']);
  assert.equal(ok.code, 0, ok.out);
});

test('行为级：边车格式坏（首段非 64 hex）→ exit 1', async () => {
  await ensureStack();
  setState({ gh: ghRelease('v0.5.2', ghAssets()), gee: geeRelease('v0.5.2', geeAssets()),
    assets: assetsMap({ [SIDE_URL]: { body: 'NOT-A-HEX-SIDECAR x\n' } }) });
  const r = await runVerify();
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('边车格式坏'), r.out);
});

test('行为级：边车哈希与 GitHub digest 不符 → exit 1', async () => {
  await ensureStack();
  setState({ gh: ghRelease('v0.5.2', ghAssets()), gee: geeRelease('v0.5.2', geeAssets()),
    assets: assetsMap({ [SIDE_URL]: { body: `${HASH_B}  DSH-Setup-0.5.2.exe\n` } }) });
  const r = await runVerify();
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('边车哈希与 GitHub digest 不符'), r.out);
});

test('行为级：HEAD(GitHub) content-length != API size → exit 1', async () => {
  await ensureStack();
  setState({ gh: ghRelease('v0.5.2', ghAssets()), gee: geeRelease('v0.5.2', geeAssets()),
    assets: assetsMap({ [MAIN_URL]: { contentLength: 999 } }) });
  const r = await runVerify();
  assert.equal(r.code, 1, r.out);
  assert.ok(/content-length=999 != API size=1000/.test(r.out), r.out);
});

test('行为级：HEAD(Gitee 镜像) content-length 漂移（疑似截断）→ exit 1', async () => {
  await ensureStack();
  setState({ gh: ghRelease('v0.5.2', ghAssets()), gee: geeRelease('v0.5.2', geeAssets()),
    assets: assetsMap({}, 500) });
  const r = await runVerify();
  assert.equal(r.code, 1, '镜像截断必须硬错: ' + r.out);
  assert.ok(/HEAD\(Gitee\).*!= GitHub size=1000/.test(r.out), r.out);
});

test('行为级：Gitee API 500 → exit 1 + FAIL API 不可达', async () => {
  await ensureStack();
  setState({ gh: ghRelease('v0.5.2', ghAssets()), geeLatestCode: 500, gee: geeRelease('v0.5.2', []),
    assets: assetsMap() });
  const r = await runVerify();
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('Gitee API 不可达'), r.out);
});

test('行为级 WARN 分类：缺未超限资产/缺边车/无边车 → exit 0 且 WARN≥3', async () => {
  await ensureStack();
  const smallUrl = 'https://objects.githubusercontent.com/gh/small.deb';
  const nosideUrl = 'https://objects.githubusercontent.com/gh/noside.exe';
  setState({
    gh: ghRelease('v0.5.2', [
      { name: 'small.deb', size: 123, url: smallUrl },                       // Gitee 缺失（未超限）→ WARN
      { name: 'noside.exe', size: 456, url: nosideUrl },                      // 无边车 → WARN
      { name: 'noside.exe.sha256', size: 70, url: nosideUrl + '.sha256' },    // Gitee 缺边车 → WARN
    ]),
    gee: geeRelease('v0.5.2', []),
    assets: {
      [smallUrl]: { contentLength: 123 },
      [nosideUrl]: { contentLength: 456 },
      [nosideUrl + '.sha256']: { body: `${HASH_A}  noside.exe\n` },
    },
  });
  const r = await runVerify();
  assert.equal(r.code, 0, '纯 WARN 不得硬错: ' + r.out);
  assert.ok(countTag(r.out, 'WARN') >= 3, '三类 WARN 都应出现: ' + r.out);
  assert.ok(r.out.includes('结论: 通过（含警告'), r.out);
});

// 超限资产（>GITEE_FILE_LIMIT=100MB）在 Gitee 侧**必须**以完整连续的 `<名>.partN`
// 分片镜像：GitHub 不可达的用户只能靠这套分片更新，所以 verify-update-sources.mjs
// :307 起把「无分片 / 断号 / Σ 与 GitHub size 不符」全判 FAIL（硬错，exit 1）。
// 旧用例停在 v0.5.2 的「缺失属预期不 FAIL」契约上——判据改了而用例没跟着改，
// 于是它对现在的守卫只会假红，且永远证明不了分片链是通的。
// 下面 1 正证 + 3 反证：每条反证各拆掉判据的一项（缺片 / 断号 / 单片截断），
// 结论必须随之翻成 exit 1，否则正证的绿没有意义。
const BIG_SIZE = 122_865_758;          // >100MB → expectedPartCount = ceil(1.17) = 2
const PART1_SIZE = 83_886_080;         // 80MiB（mirror-gitee 的切片上限）
const PART2_SIZE = BIG_SIZE - PART1_SIZE;
const BIG_URL = 'https://objects.githubusercontent.com/gh/big.deb';
const GEE_SIDE = 'https://gitee.com/att/big.deb.sha256';

/** 超限资产场景：parts 控制 Gitee 侧分片形态，partSizes 用来注入「某片被截断」。 */
function bigAssetState({ parts = ['part1', 'part2'], partSizes = { part1: PART1_SIZE, part2: PART2_SIZE } } = {}) {
  const geeAssets = [{ name: 'big.deb.sha256', url: GEE_SIDE }];
  const assetMap = {
    [BIG_URL]: { contentLength: BIG_SIZE },
    [BIG_URL + '.sha256']: { body: `${HASH_A}  big.deb\n` },
    [GEE_SIDE]: { body: `${HASH_A}  big.deb\n` },
  };
  for (const p of parts) {
    assert.ok(partSizes[p] != null, `夹具未声明 ${p} 的大小（会静默按 0 计 Σ，用例假绿）`);
    const url = `https://gitee.com/att/big.deb.${p}`;
    geeAssets.push({ name: `big.deb.${p}`, url });
    assetMap[url] = { contentLength: partSizes[p] };
  }
  return {
    gh: ghRelease('v0.5.2', [
      { name: 'big.deb', size: BIG_SIZE, url: BIG_URL, digest: `sha256:${HASH_A}` },
      { name: 'big.deb.sha256', size: 71, url: BIG_URL + '.sha256' },
    ]),
    gee: geeRelease('v0.5.2', geeAssets),
    assets: assetMap,
  };
}

test('行为级正证：超限资产完整连续分片 + Σ==GitHub size → exit 0、零 FAIL 零 WARN', async () => {
  await ensureStack();
  setState(bigAssetState());
  const r = await runVerify();
  assert.equal(r.code, 0, r.out);
  assert.equal(countTag(r.out, 'FAIL'), 0, '分片齐全不得判硬错: ' + r.out);
  assert.equal(countTag(r.out, 'WARN'), 0, '分片齐全不得判 WARN: ' + r.out);
  assert.ok(r.out.includes('分片镜像 x2（≥下限 2 片'), r.out);
  assert.ok(r.out.includes(`Σ=${BIG_SIZE} == GitHub size`), '逐片 HEAD 求和必须核对通过: ' + r.out);
});

test('行为级反证：超限资产无任何 .partN 分片 → exit 1 且点名缺失（旧契约「属预期」已废）', async () => {
  await ensureStack();
  setState(bigAssetState({ parts: [] }));
  const r = await runVerify();
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('Gitee 缺失超限资产且无 .partN 分片: big.deb'), r.out);
});

test('行为级反证：分片断号（part1+part3，缺 part2）→ exit 1 且报不连续', async () => {
  await ensureStack();
  setState(bigAssetState({
    parts: ['part1', 'part3'],
    partSizes: { part1: PART1_SIZE, part3: PART2_SIZE },
  }));
  const r = await runVerify();
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('Gitee 分片不连续: big.deb 片号=[1,3]'), r.out);
});

test('行为级反证：某片被截断（Σ != GitHub size）→ exit 1 且报汇总不符', async () => {
  await ensureStack();
  setState(bigAssetState({ partSizes: { part1: PART1_SIZE, part2: PART2_SIZE - 4096 } }));
  const r = await runVerify();
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes(`Σ=${BIG_SIZE - 4096} != GitHub size=${BIG_SIZE}`), r.out);
});

test('CLI 面：--test 自检 → 0；--help → 0；未知参数 → 1（无需网络）', () => {
  const t1 = spawnSync(process.execPath, [SCRIPT, '--test'], { encoding: 'utf8' });
  assert.equal(t1.status, 0, t1.stdout + t1.stderr);
  assert.ok(t1.stdout.includes('自检全部通过'), t1.stdout);

  const h = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(h.status, 0, h.stdout + h.stderr);
  assert.ok(h.stdout.includes('用法'), h.stdout);

  const bad = spawnSync(process.execPath, [SCRIPT, '--bogus-flag'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.ok((bad.stderr + bad.stdout).includes('未知参数'), bad.stderr + bad.stdout);
});
