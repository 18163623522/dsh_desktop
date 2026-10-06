'use strict';
// tool-name-mojibake-patch —— dsh-tools 工具名「怪字符噪音」归一化兜底（cardian 系）。
//
// 现象（用户实机）：模型偶发把插件工具名写成 `cardian¬_¬wiki¬_¬upsert` 形态
// （¬_¬ 分隔噪音），注册名实为 `cardian_wiki_upsert`——resolveExecution 直接
// miss → ToolNotFoundError → 工具调用失败。
//
// 修复（B 方案：host 解析层一次性兜底，所有插件受益、不改任何插件源码）：
// resolveExecution 的首查 miss 且名字含 ¬ 时，按「去 ¬ / _→- / -→_」三形态
// 各重试一次查找。仅首查 miss 才触发，正常路径零开销；不改变任何报错语义。
//
// 幂等（marker）、锚缺失跳过且不损坏文件（applyPatchToFiles 同契约）。

const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'dsh-desktop patch (tool-name mojibake fallback)';
// v2（2026-09-08 千问实机）：模型按说明文档的点号形态调用工具
// （cardian.memory_get），注册名实为下划线（cardian_memory_get）——
// v1 只覆盖 ¬ 噪音，不含点号。v2 独立注入块，与 v1 共存、可升级补装。
const MARKER_V2 = 'dsh-desktop patch (tool-name dot-variant fallback)';

const FN_HEAD = 'resolveExecution(name, scope, nested) {';
const GET_LINE = 'const tool = this.get(name, scope);';
const GET_LINE_LET = 'let tool = this.get(name, scope);';

function transformToolNameMojibake(src, file, options = {}) {
  const hasV1 = src.includes(MARKER);
  const hasV2 = src.includes(MARKER_V2);
  if (hasV1 && hasV2) return { status: 'already' };
  const headIdx = src.indexOf(FN_HEAD);
  if (headIdx < 0) {
    return { status: 'anchor-missing', detail: '未找到 resolveExecution 签名（dsh-tools 版本可能已变更），跳过 ' + file };
  }
  // 锚定兼容 const/let 双形态（v1-only 已分发源在升级时已是 let）。
  let getIdx = src.indexOf(GET_LINE, headIdx);
  let alreadyLet = false;
  if (getIdx < 0) {
    getIdx = src.indexOf(GET_LINE_LET, headIdx);
    alreadyLet = true;
  }
  if (getIdx < 0) {
    return { status: 'anchor-missing', detail: '未找到首查 get 行，跳过 ' + file };
  }
  const getLineStart = src.lastIndexOf('\n', getIdx) + 1;
  const indent = src.slice(getLineStart, getIdx); // 实际前导缩进（tab/空格原样保留）
  // const → let（关键前置替换）：注入块需对 tool 赋值——v1 曾因对 const 赋值
  // 必炸（Assignment to constant variable，2026-09-08 单测运行行为实测），
  // 降级为不可用；let 化后 v1 原意图原样成立（赋值 → collapses → return）。
  const LET_LINE = indent + GET_LINE_LET;
  const body = alreadyLet
    ? src
    : src.slice(0, getLineStart) + LET_LINE + src.slice(getIdx + GET_LINE.length);
  const getEnd = getLineStart + LET_LINE.length;
  let injection = '';
  let changed = false;
  if (!hasV1) {
    changed = true;
    injection += [
      '\n' + indent + '// ' + MARKER + ': 首查 miss 且名字含 ¬ 噪音时，按「去¬ / _→- / -→_」',
      indent + '// 三形态各重试一次（模型偶发输出 cardian¬_¬wiki 形态的分隔噪音）。',
      indent + 'if (tool === void 0 && typeof name === "string" && name.includes("\\u00AC")) {',
      indent + '\tconst mojibakeBase = name.split("\\u00AC").join("").replace(/_{2,}/g, "_");',
      indent + '\tfor (const candidate of [mojibakeBase, mojibakeBase.split("_").join("-"), mojibakeBase.split("-").join("_")]) {',
      indent + '\t\tif (candidate === name) continue;',
      indent + '\t\tconst retry = this.get(candidate, scope);',
      indent + '\t\tif (retry !== void 0) { tool = retry; break; }',
      indent + '\t}',
      indent + '}',
    ].join('\n');
  }
  if (!hasV2 && !(options && options.onlyV1)) {
    changed = true;
    injection += [
      '\n' + indent + '// ' + MARKER_V2 + ': 首查 miss 且名字含点号时（模型按说明文档形态调用，',
      indent + '// 如 cardian.memory_get vs 注册名 cardian_memory_get），按「.→_ / _→-」',
      indent + '// 形态重试（2026-09-08 千问实机 unknown tool 实测）。',
      indent + 'if (tool === void 0 && typeof name === "string" && name.includes(".")) {',
      indent + '\tconst dotBase = name.split(".").join("_");',
      indent + '\tfor (const candidate of [dotBase, dotBase.split("_").join("-")]) {',
      indent + '\t\tif (candidate === name) continue;',
      indent + '\t\tconst retry = this.get(candidate, scope);',
      indent + '\t\tif (retry !== void 0) { tool = retry; break; }',
      indent + '\t}',
      indent + '}',
    ].join('\n');
  }
  if (!changed) return { status: 'already' };
  return {
    status: 'changed',
    src: body.slice(0, getEnd) + injection + body.slice(getEnd),
    hadV1: hasV1,
  };
}

/**
 * 对某个 node_modules 根目录应用「工具名怪字符归一化」补丁（幂等）。
 * @param {string} nmRoot node_modules 根目录
 * @param {(msg: string) => void} [log]
 * @param {{mojibakeFailed?: number}} [stats]
 * @param {{dryRun?: boolean}} [options]
 * @returns {number} 实际发生修改的文件数
 */
function patchToolNameMojibake(nmRoot, log = () => {}, stats, options = {}) {
  const file = path.join(nmRoot, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
  if (!fs.existsSync(file)) return 0;
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log('tool-name 补丁: 读取失败 ' + file + ': ' + err.message);
    return 0;
  }
  if (src.includes(MARKER) && src.includes(MARKER_V2)) {
    log('tool-name 补丁: v1+v2 已应用，跳过 ' + file);
    return 0;
  }
  let result;
  try {
    result = transformToolNameMojibake(src, file);
  } catch (err) {
    log('tool-name 补丁: 失败(' + file + '): ' + err.message);
    if (stats) stats.mojibakeFailed = (stats.mojibakeFailed || 0) + 1;
    return 0;
  }
  if (result.status === 'already') return 0;
  if (result.status === 'anchor-missing') {
    log('tool-name 补丁: ' + result.detail);
    if (stats) stats.mojibakeFailed = (stats.mojibakeFailed || 0) + 1;
    return 0;
  }
  try {
    if (options && options.dryRun) {
      log('tool-name 补丁: dry-run: 将应用 ' + file);
      return 0;
    }
    fs.writeFileSync(file, result.src, 'utf8');
    log('tool-name 补丁: 已应用' + (result.hadV1 ? '（v2 点号形态升级）' : '（¬ 噪音 + 点号形态归一化重试）') + ' ' + file);
    return 1;
  } catch (err) {
    log('tool-name 补丁: 写入失败 ' + file + ': ' + err.message);
    return 0;
  }
}

module.exports = { patchToolNameMojibake, transformToolNameMojibake, MARKER, MARKER_V2 };
