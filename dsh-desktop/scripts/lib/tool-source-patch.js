'use strict';

// tool-source-patch.js — 空 tool-call 持久化导致会话打不开的容错补丁
//（2026-08 事故：session writer 持久化了 id/name 为空的 tool-call，随后生成
// callId/toolCallId 为空字符串的 tool/result；export 能导出该 JSONL，但
// dsh-session restore 的 assertMessageEventShape 严格校验要求 tool/result
// 必须有非空 tool source，整个会话 SessionPersistenceCorruptionError 打不开）。
//
// 双端修复（幂等、锚点失配自动跳过，风格对齐 runtime-patches.js）：
//   · 读端（dsh-session assertMessageEventShape）：空 callId/kind 的 tool/result
//     就地补合成 callId（recovered-seq-<seq>）并拉齐 block.toolCallId，旧会话
//     能重新打开；修复写入失败（对象已冻结等）时保留原严格报错。两侧 callId
//     都非空且不一致仍是真损坏，继续拒绝。
//   · 写端（dsh-agent-loop appendToolCall/appendToolResult）：block.id 为空时
//     合成 recovered-<turn>-<step>-call 并告警，name 空则落 invalid-tool-call，
//     保证 tool/call 与 tool/result 使用同一合成 id，不再写入非法事件。

const path = require('node:path');
const fs = require('node:fs');
const { applyPatchToFiles } = require('./patch-engine');

const SESSION_VALIDATION_REL = path.join('dsh-session', 'lib', 'index.js');
const AGENT_LOOP_REL = path.join('dsh-agent-loop', 'lib', 'index.js');

// ---------------------------------------------------------------------------
// 读端：assertMessageEventShape 空 tool source 容错
// ---------------------------------------------------------------------------
const TOOL_SOURCE_MARKER = 'dsh-desktop compat: tolerate empty tool source';

const TOOL_SOURCE_OLD_1 = [
  '\tif (sourceRecord["kind"] !== "tool" || typeof sourceRecord["callId"] !== "string" || sourceRecord["callId"] === "") throw new Error(`${subject} message must have tool source`);',
].join('\n');

const TOOL_SOURCE_NEW_1 = [
  '\tif (sourceRecord["kind"] !== "tool" || typeof sourceRecord["callId"] !== "string" || sourceRecord["callId"] === "") {',
  '\t\t// ' + TOOL_SOURCE_MARKER + '. Upstream once persisted tool-calls with empty id/name,',
  '\t\t// producing tool/result events whose source.callId is "" — restore validation then',
  '\t\t// bricked the whole session. Synthesize a stable callId so stored sessions reopen;',
  '\t\t// the write side (dsh-agent-loop) is separately guarded against new empty ids.',
  '\t\t// 0.2.0-rc.2：callId 的镜像位从 content[0] 块上移到消息记录自身',
  '\t\t// （messageRecord["toolCallId"]），校验与修复都按新位置走。',
  '\t\ttry {',
  '\t\t\tif (sourceRecord["kind"] !== "tool") sourceRecord["kind"] = "tool";',
  '\t\t\tconst __tMessageId = typeof messageRecord["toolCallId"] === "string" ? messageRecord["toolCallId"] : "";',
  '\t\t\tif (typeof sourceRecord["callId"] !== "string" || sourceRecord["callId"] === "") sourceRecord["callId"] = __tMessageId !== "" ? __tMessageId : "recovered-seq-" + String(event["seq"] ?? "na");',
  '\t\t\tif (messageRecord["toolCallId"] !== sourceRecord["callId"]) messageRecord["toolCallId"] = sourceRecord["callId"];',
  '\t\t\tconsole.warn("[dsh-session] tool source repaired at " + subject + " (empty callId tolerated)");',
  '\t\t} catch {',
  '\t\t\tthrow new Error(`${subject} message must have tool source`);',
  '\t\t}',
  '\t}',
].join('\n');

const TOOL_SOURCE_OLD_2 = [
  '\tif (messageRecord["toolCallId"] !== sourceRecord["callId"]) throw new Error(`${subject} message has mismatched tool call ids`);',
].join('\n');

const TOOL_SOURCE_NEW_2 = [
  '\tif (messageRecord["toolCallId"] !== sourceRecord["callId"]) {',
  '\t\t// ' + TOOL_SOURCE_MARKER + '. A mismatch where one side is empty is the empty-callId',
  '\t\t// artifact (frozen content or a path the repair above could not normalize): adopt the',
  '\t\t// non-empty side. Two different NON-empty ids stay a hard corruption.',
  '\t\tif (messageRecord["toolCallId"] === "" || messageRecord["toolCallId"] === void 0) {',
  '\t\t\ttry { messageRecord["toolCallId"] = sourceRecord["callId"]; } catch { throw new Error(`${subject} message has mismatched tool call ids`); }',
  '\t\t} else if (typeof sourceRecord["callId"] !== "string" || sourceRecord["callId"] === "") {',
  '\t\t\ttry { sourceRecord["callId"] = messageRecord["toolCallId"]; } catch { throw new Error(`${subject} message has mismatched tool call ids`); }',
  '\t\t} else {',
  '\t\t\tthrow new Error(`${subject} message has mismatched tool call ids`);',
  '\t\t}',
  '\t}',
].join('\n');

function transformToolSourceTolerance(src, file) {
  if (src.includes(TOOL_SOURCE_MARKER)) return { status: 'already' };
  if (!src.includes(TOOL_SOURCE_OLD_1) || !src.includes(TOOL_SOURCE_OLD_2)) {
    return { status: 'anchor-missing', detail: '未找到 assertMessageEventShape tool source 校验锚点（版本可能已变更），跳过 ' + file };
  }
  const out = src.replace(TOOL_SOURCE_OLD_1, TOOL_SOURCE_NEW_1).replace(TOOL_SOURCE_OLD_2, TOOL_SOURCE_NEW_2);
  return { status: 'changed', src: out };
}

// ---------------------------------------------------------------------------
// 写端：appendToolCall / appendToolResult 空 id 防护
// ---------------------------------------------------------------------------
const EMPTY_TOOLCALL_MARKER = 'dsh-desktop compat: synthesize empty tool-call ids';

const EMPTY_TOOLCALL_OLD_1 = [
  'function appendToolCall(session, turn, step, block) {',
  '\treturn session.append("tool/call", {',
  '\t\tturn,',
  '\t\tstep,',
  '\t\tcallId: block.id,',
  '\t\tname: block.name,',
  '\t\targuments: block.arguments',
  '\t}).seq;',
  '}',
].join('\n');

const EMPTY_TOOLCALL_NEW_1 = [
  'function appendToolCall(session, turn, step, block) {',
  '\t// ' + EMPTY_TOOLCALL_MARKER + '. A model can emit a tool-call block with empty id/name;',
  '\t// persisting that produces a tool/result with empty callId which bricks restore',
  '\t// validation. Synthesize a deterministic non-empty id/name instead.',
  '\tconst callId = typeof block.id === "string" && block.id !== "" ? block.id : `recovered-${turn}-${step}-call`;',
  '\tconst name = typeof block.name === "string" && block.name !== "" ? block.name : "invalid-tool-call";',
  '\tif (callId !== block.id) console.warn(`[dsh-agent-loop] empty tool-call id at turn=${turn} step=${step}; synthesized ${callId}`);',
  '\treturn session.append("tool/call", {',
  '\t\tturn,',
  '\t\tstep,',
  '\t\tcallId,',
  '\t\tname,',
  '\t\targuments: block.arguments',
  '\t}).seq;',
  '}',
].join('\n');

const EMPTY_TOOLCALL_OLD_2 = [
  'function appendToolResult(session, turn, step, block, result, callSeq) {',
  '\tconst message = createToolResultMessage({',
  '\t\tcallId: block.id,',
  '\t\tcontent: result.content,',
  '\t\tisError: result.isError',
  '\t});',
].join('\n');

const EMPTY_TOOLCALL_NEW_2 = [
  'function appendToolResult(session, turn, step, block, result, callSeq) {',
  '\t// ' + EMPTY_TOOLCALL_MARKER + '. Must match appendToolCall synthesis so tool/result',
  '\t// source.callId stays non-empty and consistent with its tool/call event.',
  '\tconst callId = typeof block.id === "string" && block.id !== "" ? block.id : `recovered-${turn}-${step}-call`;',
  '\tconst message = createToolResultMessage({',
  '\t\tcallId,',
  '\t\tcontent: result.content,',
  '\t\tisError: result.isError',
  '\t});',
].join('\n');

function transformEmptyToolCallGuard(src, file) {
  if (src.includes(EMPTY_TOOLCALL_MARKER)) return { status: 'already' };
  if (!src.includes(EMPTY_TOOLCALL_OLD_1) || !src.includes(EMPTY_TOOLCALL_OLD_2)) {
    return { status: 'anchor-missing', detail: '未找到 appendToolCall/appendToolResult 锚点（版本可能已变更），跳过 ' + file };
  }
  const out = src.replace(EMPTY_TOOLCALL_OLD_1, EMPTY_TOOLCALL_NEW_1).replace(EMPTY_TOOLCALL_OLD_2, EMPTY_TOOLCALL_NEW_2);
  return { status: 'changed', src: out };
}

// ---------------------------------------------------------------------------
// 应用入口（patch-session-persistence.js 同款契约：返回变更文件数）
// ---------------------------------------------------------------------------
function patchToolSourceCompat(nmRoot, log = () => {}, stats, options = {}) {
  let changed = 0;
  // CLI 场景经 applyRoot 透传 options：donePrefix=false 输出无前缀单行、
  // anchorLog=warn 把失配走告警通道、dryRun 只判定不落盘；stats 回流
  // anchorMissing/failed 计数。缺省保持原默认（log / true）。
  const donePrefix = options && options.donePrefix;
  const anchorLog = (options && options.anchorLog) || log;
  const dryRun = options && options.dryRun;
  const sessionFile = path.join(nmRoot, '@deepseek-ai', SESSION_VALIDATION_REL);
  if (fs.existsSync(sessionFile)) {
    changed += applyPatchToFiles({
      prefix: 'tool source 容错补丁',
      files: [sessionFile],
      log,
      transform: transformToolSourceTolerance,
      alreadyLog: (f) => '已应用，跳过 ' + f,
      doneLog: (f) => '已应用空 tool source 容错 ' + f,
      anchorLog,
      failLog: (f, err) => 'tool source 容错补丁失败(' + f + '): ' + err.message,
      donePrefix,
      dryRun,
      dryRunChangedLog: (f) => 'dry-run: 将应用空 tool source 容错 ' + f,
      stats,
    });
  }
  const loopFile = path.join(nmRoot, '@deepseek-ai', AGENT_LOOP_REL);
  if (fs.existsSync(loopFile)) {
    changed += applyPatchToFiles({
      prefix: '空 tool-call 写端防护补丁',
      files: [loopFile],
      log,
      transform: transformEmptyToolCallGuard,
      alreadyLog: (f) => '已应用，跳过 ' + f,
      doneLog: (f) => '已应用空 tool-call 写端防护 ' + f,
      anchorLog,
      failLog: (f, err) => '空 tool-call 写端防护补丁失败(' + f + '): ' + err.message,
      donePrefix,
      dryRun,
      dryRunChangedLog: (f) => 'dry-run: 将应用空 tool-call 写端防护 ' + f,
      stats,
    });
  }
  return changed;
}

module.exports = {
  SESSION_VALIDATION_REL,
  AGENT_LOOP_REL,
  TOOL_SOURCE_MARKER,
  EMPTY_TOOLCALL_MARKER,
  transformToolSourceTolerance,
  transformEmptyToolCallGuard,
  patchToolSourceCompat,
};
