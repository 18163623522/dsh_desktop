'use strict';
// 插件可移植性守卫：不得把运行期目录硬编码到固定盘符根（node --test）。
//
// 背景（实机）：dsh-super-injector 的自检夹具目录曾写成
//
//   const tmpDir = join('D:/', '杨佳禾', 'dsh', 'selftest-runner');
//
// —— 那是上游作者开发机的路径被带进了发布代码。两个后果：
//   ① 在没有 D 盘、或 D 盘不可写的机器上 mkdirSync 直接抛（且当时那句
//      mkdirSync 还不在 try 里，异常会击穿工具）；
//   ② 往盘符根写目录，越过 DSH 自己的数据目录约定（DSH_HOME / 插件数据目录），
//      用户会莫名多出一个文件夹。
//
// 判据：插件运行期代码里不得出现「以盘符根为目标的 join」——即
// `join('D:/', ...)` / `join("C:\\", ...)` 这类。合法写法是挂在
// DSH_HOME / 插件数据目录下的**固定相对子目录**（固定路径本身是 tsx 解析
// 缓存的要求，这里禁的是"固定盘符根"，不是"固定路径"）。
//
// 扫描范围：assets/plugins/<plugin>/lib/**/*.js（随包分发的运行期代码）。
// 注释里提到该路径（说明历史）不算违规——只匹配代码形态。
//
// 用法：node --test scripts/test/unit-plugin-portability.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGINS = path.join(__dirname, '..', '..', 'assets', 'plugins');

/** 递归收集目录下的 .js（跳过 node_modules / dist 等运行期依赖树）。 */
function collectJs(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'test' || e.name === 'tests') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) collectJs(abs, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(abs);
  }
  return out;
}

/** 命中「盘符根 join」与「写死的盘符根字符串」两种形态（排除注释行）。 */
const DRIVE_ROOT_JOIN = /\bjoin\(\s*['"`][A-Za-z]:[\\/]{1,2}['"`]/;
const DRIVE_ROOT_LITERAL = /['"`][A-Za-z]:[\\/]{1,2}[^'"`\s]*selftest/i;

// 剥行尾注释。必须先去掉行尾 \r：`.` 不匹配 \r，而 CRLF 文件按 \n 切出来的每行都以
// \r 结尾，`.*$` 因此在整个行上失配 —— 结果是「注释剥离」静默退化成「什么都不剥」，
// 一句写着历史反面教材的注释被判成违规（本机 w/crlf、CI 检出 i/lf，故这是一个
// 只在 Windows 上出现的假红）。
function stripLineComment(line) {
  return line.replace(/\r$/, '').replace(/\/\/.*$/, '');
}

test('插件运行期代码不得把目录硬编码到固定盘符根（可移植性）', () => {
  const offenders = [];
  for (const plugin of fs.readdirSync(PLUGINS)) {
    const lib = path.join(PLUGINS, plugin, 'lib');
    if (!fs.existsSync(lib)) continue;
    for (const file of collectJs(lib)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const code = stripLineComment(line);
        if (DRIVE_ROOT_JOIN.test(code) || DRIVE_ROOT_LITERAL.test(code)) {
          offenders.push(`${path.relative(PLUGINS, file)}:${i + 1}  ${line.trim().slice(0, 120)}`);
        }
      });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '以下位置把运行期目录硬编码到了固定盘符根（在没有该盘/不可写的机器上会抛错，并往盘根写东西）。' +
      '应改为挂在 DSH_HOME / 插件数据目录下的固定子目录：\n' + offenders.join('\n'),
  );
});

// 反证：注释剥离必须真的起作用，同时不能把真代码放过去。判据缺一，上面那条守卫
// 就分别在「常红」和「常绿」之间失去捕获力。
test('反证：注释剥离对 LF 与 CRLF 等价，且不放过真代码里的盘符根', () => {
  const commentLf = '  // 旧实现硬编码 `D:/someone/selftest-runner`，';
  assert.strictEqual(stripLineComment(commentLf), '  ', 'LF 行尾：整行注释必须被剥光');
  assert.strictEqual(
    stripLineComment(commentLf + '\r'),
    '  ',
    'CRLF 行尾：必须与 LF 同判（回归 2026-10-05 的 Windows-only 假红）',
  );

  const codeLine = "const dir = join('D:/', 'work'); // 说明";
  assert.strictEqual(
    stripLineComment(codeLine + '\r'),
    "const dir = join('D:/', 'work'); ",
    '行尾注释只剥注释，代码部分必须原样保留',
  );
  assert.ok(DRIVE_ROOT_JOIN.test(stripLineComment(codeLine + '\r')), '真代码里的 join(盘符根) 必须仍被捕获');
  assert.ok(
    DRIVE_ROOT_LITERAL.test(stripLineComment('const p = `D:/dsh/selftest-runner`; // 说明\r')),
    '真代码里写死的 selftest 盘符根字符串必须仍被捕获',
  );
});

test('回归锁：super-injector 自检夹具目录挂在插件数据目录下（不再写死盘符）', () => {
  const file = path.join(PLUGINS, 'dsh-super-injector', 'lib', 'index.js');
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(
    src.includes("const tmpDir = join(dirname(registryFile), TEST_SHORT);"),
    'tmpDir 必须由插件数据目录（dirname(registryFile)，尊重 DSH_HOME 重定向）推导',
  );
  assert.ok(!/join\(\s*['"`]D:\//.test(src), '不得再出现 join(\'D:/...\') 形态的盘符根硬编码');
  assert.ok(
    /check\('测试目录可写', false/.test(src),
    '测试目录创建失败必须走 check + 提前返回（旧实现 mkdirSync 不在 try 里，会直接抛）',
  );
  assert.ok(
    /libRestored = readFileSync\(libPath, 'utf8'\) === backup/.test(src),
    '「预检后 lib 恢复」必须以磁盘内容为准，不得依赖初值为 true 的布尔量',
  );
});
