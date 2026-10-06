'use strict';

// dsh-llm-deepseek 工具 schema+函数名净化补丁（官方 DeepSeek 直连路由）。
//
// 与 patch-pi-ai-tool-schema-sanitize 同根因的姊妹补丁：官方 DeepSeek API
// （provider deepseek-official，走 @deepseek-ai/dsh-llm-deepseek 适配器，
// 不经过 pi-ai）同样严格校验工具定义——函数名必须匹配 ^[a-zA-Z0-9_-]+$、
// schema 属性级布尔 required 非法。实测 400 INVALID_REQUEST
// "Invalid 'tools[N].function.name': string does not match pattern"。
// 该适配器自带独立工具序列化（内联 map），必须单独净化。
//
// 三件套与 pi-ai 补丁同构：出口名字规范化 + schema 净化 + 回call解析回映射。
//
// rc.2 换代：适配器整体改走 Messages 端点，chat/completions 的
// requestWithMessages 已不存在（实测 0 命中），但**工具序列化仍是内联 map 且
// 一样不净化**——定义（name/input_schema）、历史回放（assistant tool-call 的
// block.name）、回程（tool_use 的 native.name）三处字节级同病，故按新世代重锚
// 而非退役。注：rc.2 上 Messages 端点对点号名的 400 是按同一 pattern 推断，未
// 重新实测；净化只改「本就不合法」的名字（合法名零改写、不登记映射），风险面
// 与不改一致，故仍按 warn 档应用。
//
// 用法：node scripts/patch-ds-tool-schema-sanitize.js [<node_modules 根>]

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('./lib/patch-io');

const TARGET_REL = path.join('@deepseek-ai', 'dsh-llm-deepseek', 'lib', 'index.js');
const MARKER = 'dsh-desktop patch (ds tool schema sanitize)';

// 【已退役世代】0.1.6 及更早的 chat/completions 形态（requestWithMessages +
// parameters + acceptIdentity(call.function?.name)）随 pin 换代移除：实测该文件
// 里有两处 `name: tool.name,`（completions 与 Messages 各一处），旧实现用
// String.replace(串) 只替换首现 → Messages 那条一直漏洗。rc.2 只剩 Messages 一条，
// 按唯一命中重锚正好补上这个洞。在野的旧已打补丁副本靠 marker 走 already。

// 0.2.0-rc.2（Messages 形态，现行 pin）：序列化收口是 serialize()。
const FN_ANCHOR = 'function serialize(options, connection, history, images, access, onReplayDegrade, fileIds) {';
const NAME_ANCHOR = '\t\t\tname: tool.name,';
const SCHEMA_ANCHOR = '\t\t\tinput_schema: tool.parameters,';
// 回放点：历史 assistant tool-call 块带的是内核原名（回程已还原），出站必须再洗
// 成 wire 名，否则第二轮起仅定义被净化、消息体里的点号名照样把请求顶回 400。
const REPLAY_ANCHOR = '\t\t\t\tname: block.name,';
// 回程点：tool_use 块的 native.name 是 wire 名，还原成内核原名才能分发到工具。
const PARSE_ANCHOR = '\t\t\t\tname: string(native.name),';

const HELPER = [
  '// ' + MARKER + ': 官方 DeepSeek API 同样校验函数名 ^[a-zA-Z0-9_-]+$ 与',
  '// schema 属性级布尔 required（实测 400 INVALID_REQUEST pattern）。出口规范化',
  '// + 净化，回call解析回映射还原原名。与 pi-ai 侧补丁同构。',
  'const __dshDsToolWireMap = new Map();',
  'function __dshDsWireName(name) {',
  '    if (typeof name !== "string") return name;',
  '    const wire = name.replace(/[^a-zA-Z0-9_-]/g, "_");',
  '    if (wire !== name) __dshDsToolWireMap.set(wire, name);',
  '    return wire;',
  '}',
  'function __dshDsRestoreToolName(name) {',
  '    if (typeof name !== "string" || __dshDsToolWireMap.size === 0) return name;',
  '    return __dshDsToolWireMap.get(name) ?? name;',
  '}',
  'function __dshDsSanitizeToolSchema(value) {',
  '    const walk = (node) => {',
  '        if (Array.isArray(node)) return node.map(walk);',
  '        if (node && typeof node === "object") {',
  '            const out = {};',
  '            for (const key of Object.keys(node)) out[key] = walk(node[key]);',
  '            if (out.required === true) out.required = out.properties && typeof out.properties === "object" ? Object.keys(out.properties) : undefined;',
  '            if (out.required === false || out.required === undefined) delete out.required;',
  '            if (Array.isArray(out.required) && out.required.length === 0) delete out.required;',
  '            if (out.properties && typeof out.properties === "object") {',
  '                for (const pk of Object.keys(out.properties)) {',
  '                    const p = out.properties[pk];',
  '                    if (p && typeof p === "object" && typeof p.required === "boolean") {',
  '                        const np = {};',
  '                        for (const k of Object.keys(p)) if (k !== "required") np[k] = p[k];',
  '                        out.properties[pk] = np;',
  '                    }',
  '                }',
  '            }',
  '            return out;',
  '        }',
  '        return node;',
  '    };',
  '    try { return walk(value); } catch { return value; }',
  '}',
  ''].join('\n');

// 四处落点（序列化收口 + 定义名/定义 schema + 历史回放 + 回程还原）必须各自
// 唯一命中，任一处漂移即整块不改（绝不部分应用，防半投）。
const DS_TOOL_PAIRS = [
  [NAME_ANCHOR, '\t\t\tname: __dshDsWireName(tool.name),'],
  [SCHEMA_ANCHOR, '\t\t\tinput_schema: __dshDsSanitizeToolSchema(tool.parameters),'],
  [REPLAY_ANCHOR, '\t\t\t\tname: __dshDsWireName(block.name),'],
  [PARSE_ANCHOR, '\t\t\t\tname: __dshDsRestoreToolName(string(native.name)),'],
];

const hits = (src, needle) => src.split(needle).length - 1;

function transformDsToolSchemaSanitize(src, file) {
  if (src.includes(MARKER)) return { status: 'already' };
  const miss = [FN_ANCHOR, ...DS_TOOL_PAIRS.map(([from]) => from)]
    .map((n) => ({ n, hits: hits(src, n) }))
    .filter((r) => r.hits !== 1);
  if (miss.length > 0) {
    return {
      status: 'anchor-missing',
      detail: '工具净化锚点非唯一命中（' + miss.map((r) => JSON.stringify(r.n.trim().slice(0, 40)) + '=' + r.hits).join(' / ') +
        '，版本可能已变化），跳过 ' + (file || '<unknown>'),
    };
  }
  let out = src.replace(FN_ANCHOR, () => HELPER + FN_ANCHOR);
  for (const [from, to] of DS_TOOL_PAIRS) out = out.replace(from, () => to);
  return { status: 'changed', src: out };
}

function patchDsToolSchemaSanitize(nmRoot, log = () => {}, stats) {
  const file = path.join(nmRoot, TARGET_REL);
  if (!fs.existsSync(file)) return 0;
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log('ds 工具净化补丁: 读取失败 ' + file + ': ' + err.message);
    if (stats) stats.failed += 1;
    return 0;
  }
  const result = transformDsToolSchemaSanitize(src, file);
  if (result.status === 'already') {
    log('ds 工具净化补丁: 已应用，跳过 ' + file);
    return 0;
  }
  if (result.status === 'anchor-missing') {
    log('ds 工具净化补丁: ' + result.detail);
    if (stats) stats.anchorMissing += 1;
    return 0;
  }
  try {
    writeFileAtomic(file, result.src);
    log('ds 工具净化补丁: 已注入 schema 净化 + 名字规范化/回映射 ' + file);
    return 1;
  } catch (err) {
    log('ds 工具净化补丁: 写入失败 ' + file + ': ' + err.message);
    if (stats) stats.failed += 1;
  }
  return 0;
}

module.exports = { patchDsToolSchemaSanitize, transformDsToolSchemaSanitize, MARKER, TARGET_REL };

if (require.main === module) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', 'node_modules');
  const n = patchDsToolSchemaSanitize(root, (m) => console.log(m));
  console.log(n > 0 ? 'patched ' + n + ' file(s)' : 'nothing to patch');
}