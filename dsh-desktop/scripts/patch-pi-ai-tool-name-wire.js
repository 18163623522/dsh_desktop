'use strict';

/* dsh-llm-pi-ai 工具名 wire 规范化（中央收口，一处覆盖全部 provider）
 *
 * 为什么打在 dsh-llm-pi-ai 而不是逐个适配器：pi-ai 每个 provider 各自把
 * `name: tool.name` 原样塞进请求（openai-completions / openai-responses-shared /
 * azure-openai-responses / openai-codex-responses / bedrock-converse-stream /
 * google-shared / mistral-conversations），逐个打补丁等于长期追上游的尾巴。
 * 而内核把工具交给 pi-ai 前只有一个收口 `toolsOf()`，回程转成 harness content
 * 也只有两个 `case "tool-call"`，三处一起改即全 provider 生效。
 *
 * 触发场景（在野）：dsh-cardian 注册 cardian.backlinks / cardian.doctor /
 * cardian.export / cardian.import / cardian.recall / cardian.reindex /
 * cardian.related / cardian.feedback 等带点号的名字，OpenAI Responses 直接 400
 * （Invalid 'tools[1].name': ... pattern '^[a-zA-Z0-9_-]+$'）；Gemini / Bedrock /
 * Mistral 的函数名规则同样不放点号，属同一类待爆问题。
 *
 * 用法：node scripts/patch-pi-ai-tool-name-wire.js [<node_modules 根>]
 */

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('./lib/patch-io');

const TARGET_REL = path.join('@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js');
const MARKER = 'dsh-desktop patch (pi-ai tool name wire)';

const HELPER = [
  '// ' + MARKER + ': 工具名 wire 规范化 + 反向映射（单一收口，覆盖全部 provider）。',
  '// OpenAI Responses/Completions、Gemini、Bedrock、Mistral 的函数名规则都不接受',
  '// 点号等字符（OpenAI 明确 ^[a-zA-Z0-9_-]+$），而 dsh-cardian 等插件注册的是',
  '// cardian.backlinks 这类带点号名字 → 400 invalid_value。出站统一洗成 wire 名，',
  '// 回程按映射还原原名供内核分发；名字本就合法时不改写、也不登记映射。',
  'const __dshPiToolWireMap = new Map();',
  'function __dshPiWireToolName(name) {',
  "\tif (typeof name !== 'string') return name;",
  "\tconst wire = name.replace(/[^a-zA-Z0-9_-]/g, '_');",
  '\tif (wire !== name) __dshPiToolWireMap.set(wire, name);',
  '\treturn wire;',
  '}',
  'function __dshPiRestoreToolName(name) {',
  "\tif (typeof name !== 'string' || __dshPiToolWireMap.size === 0) return name;",
  '\treturn __dshPiToolWireMap.get(name) ?? name;',
  '}',
  '',
].join('\n');

// 锚点：出站收口 + 回程两处 + 一个稳定的注入位置（toolsOf 之前）。
const ANCHORS = [
  {
    id: 'toolsOf-outbound',
    // 只锚「return + name:」两行：0.2.0-rc.2 在 toolsOf 开头插了一行 deferLoading
    // 守卫（throw LlmError），带函数签名的三行锚点因此失配；两行形态在 0.1.6 与
    // rc.2 上都恰好命中一次，比追上游的行序更耐漂移。
    needle: '\treturn options.tools?.map((tool) => ({\n\t\tname: tool.name,',
    replace: '\treturn options.tools?.map((tool) => ({\n\t\tname: __dshPiWireToolName(tool.name),',
  },
  {
    id: 'toolcall-inbound',
    needle: '\t\t\tcontent.push({\n\t\t\t\ttype: "toolCall",\n\t\t\t\tid: block.id,\n\t\t\t\tname: block.name,\n\t\t\t\targuments: parseArguments(block.arguments)\n\t\t\t});',
    replace: '\t\t\tcontent.push({\n\t\t\t\ttype: "toolCall",\n\t\t\t\tid: block.id,\n\t\t\t\tname: __dshPiRestoreToolName(block.name),\n\t\t\t\targuments: parseArguments(block.arguments)\n\t\t\t});',
  },
  {
    id: 'toolcall-replay-inbound',
    needle: '\t\t\t\tcase "tool-call": return {\n\t\t\t\t\ttype: "toolCall",\n\t\t\t\t\tid: block.id,\n\t\t\t\t\tname: block.name,',
    replace: '\t\t\t\tcase "tool-call": return {\n\t\t\t\t\ttype: "toolCall",\n\t\t\t\t\tid: block.id,\n\t\t\t\t\tname: __dshPiRestoreToolName(block.name),',
  },
];

function patchSource(src) {
  if (src.includes(MARKER)) return { changed: false, src, already: true };
  const missing = ANCHORS.filter((a) => !src.includes(a.needle)).map((a) => a.id);
  if (missing.length > 0) return { changed: false, src, missing };
  let out = src;
  for (const a of ANCHORS) out = out.split(a.needle).join(a.replace);
  // helper 注入在 toolsOf 定义之前（模块作用域，函数提升不影响使用点）。
  out = out.replace('function toolsOf(options) {', HELPER + 'function toolsOf(options) {');
  return { changed: true, src: out };
}

function patchPiAiToolNameWire(nmRoot = path.join(__dirname, 'node_modules')) {
  const target = path.join(nmRoot, TARGET_REL);
  if (!fs.existsSync(target)) {
    return { changed: false, skipped: true, file: target, reason: '靶文件不存在（pi-ai 适配包未装配）' };
  }
  const src = fs.readFileSync(target, 'utf8');
  const r = patchSource(src);
  if (r.already) return { changed: false, file: target, already: true };
  if (r.missing) {
    return { changed: false, file: target, anchorMismatch: r.missing,
      reason: 'ANCHOR MISMATCH: ' + r.missing.join(' / ') + '（整份不改，防半投）' };
  }
  writeFileAtomic(target, r.src);
  return { changed: true, file: target };
}

/** 注册表用三态变换：把 patchSource 的内部形态翻译成 {status, src, detail}。 */
function transformPiAiToolNameWire(src, file) {
  if (typeof src !== 'string') {
    return { status: 'anchor-missing', detail: '非字符串源，跳过 ' + file };
  }
  const r = patchSource(src);
  if (r.already) return { status: 'already' };
  if (r.missing) {
    return {
      status: 'anchor-missing',
      detail: '未找到 pi-ai 工具名 wire 收口锚点（版本可能已变更），跳过 ' + file
        + '：' + r.missing.join(' / ') + '（整份不改，防半投）',
    };
  }
  return { status: 'changed', src: r.src };
}

module.exports = { patchPiAiToolNameWire, transformPiAiToolNameWire, MARKER, ANCHORS, patchSource, TARGET_REL };

if (require.main === module) {
  const nmRoot = process.argv[2] ? path.resolve(process.argv[2], 'node_modules') : path.join(__dirname, 'node_modules');
  const r = patchPiAiToolNameWire(nmRoot);
  if (r.changed) console.log('[' + MARKER + '] 已应用：' + r.file);
  else if (r.already) console.log('[' + MARKER + '] 已应用，跳过：' + r.file);
  else if (r.skipped) console.log('[' + MARKER + '] 跳过：' + r.reason);
  else {
    console.error('[' + MARKER + '] ' + r.reason);
    process.exitCode = 1;
  }
}
