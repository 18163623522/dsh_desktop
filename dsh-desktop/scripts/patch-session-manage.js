'use strict';

// 对话删除 / 归档管理运行时补丁（幂等、锚点不匹配时跳过且绝不损坏文件）。
//
// 背景：dsh 只有归档（workspace 域 archivedSessionIds）没有删除；取消归档
// （unarchive）在注册表层也没有。本补丁在官方包上做外科手术式扩展，打通
// 「删除按钮 + 设置内归档管理面板」所需的完整链路：
//
//   1. @deepseek-ai/dsh-workspace        —— WorkspaceRegistry 增加
//      unarchiveSession(sessionId)（幂等地从归档集合移除并持久化）。
//      【0.2.0-rc.2 退役】上游已原生同名方法，语义逐字相同，见下文第 1 节。
//   2. @deepseek-ai/dsh-session          —— SessionStore 增加 remove(id)
//      （从 live 注册表摘除，优雅 flush 后释放持久化状态并广播
//      session/disposed）。
//   3. @deepseek-ai/dsh-api-workspace-controller（旧 dsh-host-apiproxy 拆分后
//      的 workspace 宿主控制器）—— 新增两个 RPC：
//        · workspace.unarchiveSession    恢复归档（返回完整归档集，域变更
//          自动广播 archived 帧，客户端实时恢复显示）；【0.2.0-rc.2 起原生，
//          本层只保留 deleteSession】
//        · workspace.deleteSession       删除：拒绝运行中会话（实时查询
//          ctx.agents 注册表，宿主权威状态）→ 摘除 live 注册表（session/disposed
//          广播 → 客户端实时移除行）→ 清理归档集合 → 从所属工作区 sessionIds
//          摘除并持久化 → 按 jsonl 布局移除会话目录（日志与附件一并移除）。
//      typert 协议三处同步：lib/index.js（命令实现 + 控制器门面）、
//      lib/typert.host.js（宿主 STRICT 分发描述符，运行时经 typert-loader 加载）、
//      lib/client.js（客户端模型/服务门面）。
//   4. @deepseek-ai/dsh-api-remotes      —— 客户端 remote 注册表 bundle 增加
//      两个方法的 schema + descriptor（客户端 callUnary 据此装配 remote.workspace
//      命名空间；旧版在 dsh-client-connection 里，现已收口到该 bundle）。
//   5. @deepseek-ai/dsh-client-ui-workspace —— 会话行 ⋯ 菜单在「归档会话」
//      下方增加「删除对话」（当前会话行也显示），点击走
//      window.__dshSessionManager（由配套插件 dsh-session-manager 提供：
//      确认框 + RPC + 错误提示）。【0.2.0-rc.2 起该菜单改为
//      sidebar.workspaces.session.menu.item 的 slot 列表，本层改为注册
//      order 450 的 DeleteSessionMenuItem】
//
// 孤儿进程清理（旧 patch-session-orphans.js 的职责）已内联到 deleteSession：
// 删除会话后复用内核自有 owner 清理 API（jobs.disposeOwned / terminals
// .disposeOwned / agent.cancel）终结该 agent 名下全部工作，避免背景进程与
// 持久终端活到内核退出。旧文件已在新内核中失去锚点（deleteSession 已迁入
// workspace-controller），不再单列一个锚点依赖补丁。
//
// 用法：
//   node scripts/patch-session-manage.js [<node_modules 根目录>]
// 同时导出 patchSessionManage(nmRoot, log, stats, options) 供启动补丁与
// 打包补丁复用（覆盖内置副本 / profile fallback / agent overlay / dev）。

const fs = require('node:fs');
const path = require('node:path');
// 原子写与其它补丁脚本共用同一实现（scripts/lib/patch-io.js）。
const { writeFileAtomic } = require('./lib/patch-io');

const MARKER = 'dsh-desktop patch (session manage)';

// 「桥缺失则不渲染」判定式。必须与 scripts/lib/host-capabilities.js 的
// DELETE_SESSION_MENU_GUARD 逐字一致——unit-host-capabilities 的「桥契约一致性」
// 用例按字面量在本文件源码里核对，改这里就得同步改那边，否则测试红。
// 用单引号常量再拼进注入体：字面量留在源码里（契约可核对），落到内核文件的字节
// 又与清单完全一致（不会因双引号转义而漂移）。
const DELETE_SESSION_MENU_GUARD = 'window.__dshSessionManager && typeof window.__dshSessionManager.deleteSession === "function"';

// ---------------------------------------------------------------------------
// 1. dsh-workspace：unarchiveSession —— 0.2.0-rc.2 起原生，本层退役。
//    上游 WorkspaceRegistry.unarchiveSession（lib/index.js:551）与我们的注入体
//    逐语义相同：enqueueOperation + requireState，不在归档集合中即 no-op
//    （不校验 sessionKnown，已删除会话的陈旧归档项仍能清掉），命中则
//    setState 过滤后持久化。故 WS_ANCHOR / WS_INSERT 删除，dsh-workspace 不再
//    是补丁靶。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 2. dsh-session：SessionStore.remove(id) —— 删除前从 live 注册表摘除
// ---------------------------------------------------------------------------
const SESSION_ANCHOR = 'list() {\n\t\treturn [...this.store.values()].map((entry) => entry.session);\n\t}';
const SESSION_INSERT = 'list() {\n\t\treturn [...this.store.values()].map((entry) => entry.session);\n\t}\n\t/**\n\t* dsh-desktop patch (session manage): 从 live 注册表摘除一个会话并广播\n\t* session/disposed（优雅 flush 后释放持久化状态）。删除前调用：摘除后\n\t* 写路径不再拥有该会话，目录可安全移除；正在运行的会话由调用方先行拒绝。\n\t* @param id - 要摘除的会话 id。\n\t* @returns 是否确实摘除了一个 live 会话。\n\t*/\n\tremove(id) {\n\t\tconst entry = this.store.get(id);\n\t\tif (entry === void 0) return false;\n\t\tthis.detachEntered(entry);\n\t\treturn true;\n\t}';

// ---------------------------------------------------------------------------
// 3. dsh-api-workspace-controller/lib/index.js：两个 RPC 的命令实现 + 控制器门面
// ---------------------------------------------------------------------------
// 3a. 顶部追加 node:fs/promises.rm 与 node:path.dirname 导入（ESM 模块）。
const HOST_IMPORT_ANCHOR = 'import { DirectoryPickerError } from "@deepseek-ai/dsh-host-directory-picker";';
const HOST_IMPORT_INSERT = 'import { DirectoryPickerError } from "@deepseek-ai/dsh-host-directory-picker";\nimport { rm } from "node:fs/promises";\nimport { dirname } from "node:path";';

// 3a-2. WorkspaceController 的 cordis inject 声明补全（2026-08-31 隔离实测根因）。
// deleteSession 访问 this.ctx.agents / this.ctx.sessions / this.ctx.sessionPersistence，
// 而控制器只声明了 ["typert", "workspaceRegistry"] —— cordis 对未声明服务做属性
// 访问直接抛 `cannot get property "agents" without inject`，删除在宿主第一行就炸
// （探针实证：fake-delete-REJECT → alert「操作失败: workspace session delete failed」）。
// 三个服务均为内核根作用域服务（agents：dsh-goal/file-reference-local 同名注入；
// sessions：dsh-session:1674；sessionPersistence：dsh-session-persistence:1478），
// 与 workspaceRegistry 同域，inject 可解析。
const HOST_INJECT_ANCHOR = 'static inject = ["typert", "workspaceRegistry"];';
const HOST_INJECT_INSERT = 'static inject = ["typert", "workspaceRegistry", "agents", "sessions", "sessionPersistence"];';

// 3b. WorkspaceCommands：在原生 unarchiveSession 命令之后、pinSession 之前插入
// deleteSession 命令。0.2.0-rc.2 重锚：archiveSession 与 unarchiveSession 之间
// 已不相邻（unarchive 原生、其后还有 pin/unpin），故锚点改取原生 unarchiveSession
// 命令本体四行（全文件唯一），删除原注入里我们自己那份 unarchiveSession 命令
// （上游已提供，语义相同）。
const HOST_CMDS_ANCHOR = '\tasync unarchiveSession(request) {\n\t\tawait this.ctx.workspaceRegistry.unarchiveSession(request.sessionId);\n\t\treturn { archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds] };\n\t}';
const HOST_CMDS_INSERT = HOST_CMDS_ANCHOR + '\n\t/**\n\t* dsh-desktop patch (session manage): 彻底删除一个会话（日志与附件一并移除，\n\t* 不可恢复）。拒绝正在运行的会话（实时查询 ctx.agents 注册表，宿主权威状态，\n\t* 与 sessions.list 的 running 同源）；随后摘除 live 注册表（session/disposed\n\t* 广播 → 客户端实时移除行）、清理归档集合、从所属工作区 sessionIds 摘除并\n\t* 持久化，最后按 jsonl 布局移除会话目录。\n\t* @param request - Session identity to delete.\n\t* @returns deletion confirmation.\n\t*/\n\tasync deleteSession(request) {\n\t\tconst { sessionId } = request;\n\t\t// 拒绝「正在运行」的会话（agent 活跃时写路径会重建目录，删除不安全）。\n\t\tif (this.ctx.agents.get(sessionId)?.status === "running") {\n\t\t\tthrow new RemoteError("session-running", "cannot delete a running session: stop it first", { sessionId });\n\t\t}\n\t\t// 先摘除 live 注册表（detachEntered 优雅 flush 后释放持久化状态并广播\n\t\t// session/disposed）；此后写路径不再拥有该会话，目录移除才安全。\n\t\tthis.ctx.sessions.remove(sessionId);\n\t\t// dsh-desktop patch (session orphans): 上游 agent 只随内核退出卸载，删除\n\t\t// 会话后其名下背景进程与持久终端会一直活到内核退出（孤儿泄漏）。复用内核\n\t\t// 自有 owner 清理 API 终结该 agent 名下全部工作；两者幂等，服务缺失时静默降级。\n\t\ttry {\n\t\t\tconst dshDeletedAgent = this.ctx.agents.get(sessionId);\n\t\t\tif (dshDeletedAgent !== void 0) {\n\t\t\t\ttry { dshDeletedAgent.cancel({ kind: "user" }, { keepInbox: true }); } catch {}\n\t\t\t\tconst dshDeletedJobs = this.ctx.get("jobs");\n\t\t\t\tif (dshDeletedJobs && typeof dshDeletedJobs.disposeOwned === "function") void Promise.resolve(dshDeletedJobs.disposeOwned(dshDeletedAgent)).catch(() => {});\n\t\t\t\tconst dshDeletedTerminals = this.ctx.get("terminals");\n\t\t\t\tif (dshDeletedTerminals && typeof dshDeletedTerminals.disposeOwned === "function") void Promise.resolve(dshDeletedTerminals.disposeOwned(dshDeletedAgent)).catch(() => {});\n\t\t\t}\n\t\t} catch {}\n\t\t// 清理归档集合（含陈旧归档项）；unarchiveSession 系 0.2.0-rc.2 原生。\n\t\tawait this.ctx.workspaceRegistry.unarchiveSession(sessionId);\n\t\t// 从所属工作区的 sessionIds 中摘除并持久化——否则 workspace.json 的\n\t\t// workspaces.<id>.sessionIds 会残留已删除会话引用，磁盘状态与运行时\n\t\t// 状态不一致（issue #82）。用原始 record 判定（sessionIds getter 会按\n\t\t// 已删除会话的 host 路径过滤，看不到残留项）。\n\t\tfor (const ws of this.ctx.workspaceRegistry.list()) {\n\t\t\tif (ws.record && Array.isArray(ws.record.sessionIds) && ws.record.sessionIds.includes(sessionId)) {\n\t\t\t\tawait ws.detachSession(sessionId);\n\t\t\t}\n\t\t}\n\t\t// 移除会话目录（jsonl 布局：listArtifacts 返回 log 文件路径，其父目录即\n\t\t// 会话目录，日志与附件一并移除）。目录移除为 best-effort：失败只告警不\n\t\t// 中断删除主链（已从注册表/归档/工作区摘除）。\n\t\ttry {\n\t\t\tconst artifacts = await this.ctx.sessionPersistence.listArtifacts();\n\t\t\tconst artifact = artifacts.find((entry) => entry && entry.header && entry.header.id === sessionId);\n\t\t\tif (artifact !== void 0) {\n\t\t\t\tawait rm(dirname(artifact.path), { recursive: true, force: true });\n\t\t\t}\n\t\t} catch (error) {\n\t\t\tthis.ctx.logger.warn(`session-manage: session "${sessionId}" directory removal failed: ${String(error)}`);\n\t\t}\n\t\treturn { deleted: true };\n\t}';

// 3c. WorkspaceController 门面：unarchive 已原生（0.1.6），只注入 deleteSession
// 门面。锚定门面类自身的 unarchive（commands 委托风格，双 tab），与 3b 的
// commands 类区域完全解耦。
const HOST_CTRL_ANCHOR = "\t\tunarchiveSession(request) {\n\t\t\treturn this.commands.unarchiveSession(request);\n\t\t}";
const HOST_CTRL_INSERT = "\t\tunarchiveSession(request) {\n\t\t\treturn this.commands.unarchiveSession(request);\n\t\t}\n\t\t/**\n\t\t* dsh-desktop patch (session manage): 彻底删除一个会话（后端见 3b 注入的\n\t\t* commands.deleteSession）。\n\t\t* @param request - Session identity to delete.\n\t\t* @returns deletion confirmation.\n\t\t*/\n\t\tdeleteSession(request) {\n\t\t\treturn this.commands.deleteSession(request);\n\t\t}";

// ---------------------------------------------------------------------------
// 4. dsh-api-workspace-controller/lib/typert.host.js：STRICT 分发描述符
// ---------------------------------------------------------------------------
// 4a. schema 常量（原生 unarchiveSession_result 之后、TYPERT 导出之前插入
// deleteSession 的 parameter/result schema；unarchive 系 schema 0.1.6 已原生）。
const TYPERT_HOST_SCHEMA_ANCHOR = "let _deepseek_ai_dsh_api_workspace_controller_workspace_unarchiveSession_result$schema$value\nconst _deepseek_ai_dsh_api_workspace_controller_workspace_unarchiveSession_result$schema = () => (_deepseek_ai_dsh_api_workspace_controller_workspace_unarchiveSession_result$schema$value ??= z.object({\n  'archivedSessionIds': z.array(z.intersection(z.string(), z.unknown())).readonly(),\n}))";
const TYPERT_HOST_SCHEMA_INSERT = "let _deepseek_ai_dsh_api_workspace_controller_workspace_unarchiveSession_result$schema$value\nconst _deepseek_ai_dsh_api_workspace_controller_workspace_unarchiveSession_result$schema = () => (_deepseek_ai_dsh_api_workspace_controller_workspace_unarchiveSession_result$schema$value ??= z.object({\n  'archivedSessionIds': z.array(z.intersection(z.string(), z.unknown())).readonly(),\n}))\nlet _deepseek_ai_dsh_api_workspace_controller_workspace_deleteSession_parameter_0$schema$value\nconst _deepseek_ai_dsh_api_workspace_controller_workspace_deleteSession_parameter_0$schema = () => (_deepseek_ai_dsh_api_workspace_controller_workspace_deleteSession_parameter_0$schema$value ??= z.object({\n  'sessionId': z.intersection(z.string(), z.unknown()).readonly(),\n}))\nlet _deepseek_ai_dsh_api_workspace_controller_workspace_deleteSession_result$schema$value\nconst _deepseek_ai_dsh_api_workspace_controller_workspace_deleteSession_result$schema = () => (_deepseek_ai_dsh_api_workspace_controller_workspace_deleteSession_result$schema$value ??= z.object({\n  'deleted': z.boolean().readonly(),\n}))";

// 4b. invocation 条目（原生 unarchiveSession 描述符之后、数组闭合前插入
// deleteSession 描述符；unarchive 描述符 0.1.6 已原生，sourceLocation line 119）。
const TYPERT_HOST_INVOKE_ANCHOR = "        create: _deepseek_ai_dsh_api_workspace_controller_workspace_unarchiveSession_result$schema,\n      },\n      sourceLocation: {\"file\":\"packages/api/workspace-controller/src/index.ts\",\"line\":165,\"column\":3},\n    },";
const TYPERT_HOST_INVOKE_INSERT = "        create: _deepseek_ai_dsh_api_workspace_controller_workspace_unarchiveSession_result$schema,\n      },\n      sourceLocation: {\"file\":\"packages/api/workspace-controller/src/index.ts\",\"line\":165,\"column\":3},\n    },\n    {\n      id: '@deepseek-ai/dsh-api-workspace-controller#workspace/deleteSession',\n      service: 'workspaceController',\n      namespace: 'workspace',\n      method: 'deleteSession',\n      invocation: { kind: 'direct' },\n      parameters: [\n        {\n          name: 'request',\n          wire: 'request',\n          source: 'json',\n          codec: {\n            mode: 'strict',\n            typeSymbol: '@deepseek-ai/dsh-api-workspace-controller/types#WorkspaceDeleteSessionRequest',\n            create: _deepseek_ai_dsh_api_workspace_controller_workspace_deleteSession_parameter_0$schema,\n          },\n        },\n      ],\n      result: {\n        mode: 'strict',\n        typeSymbol: '@deepseek-ai/dsh-api-workspace-controller/types#WorkspaceDeleteSessionValue',\n        create: _deepseek_ai_dsh_api_workspace_controller_workspace_deleteSession_result$schema,\n      },\n      sourceLocation: {\"file\":\"packages/api/workspace-controller/src/index.ts\",\"line\":999,\"column\":3},\n    },";

// ---------------------------------------------------------------------------
// 5. dsh-api-workspace-controller/lib/client.js：客户端模型/服务门面
// ---------------------------------------------------------------------------
// 5a. ClientWorkspaceModel：原生 unarchiveSession（带 requestSeq 竞态守卫）之后、
// replaceBaseline 之前插入 deleteSession（unarchive 0.1.6 已原生）。
const CLIENT_MODEL_ANCHOR = "\t\t\tasync unarchiveSession(sessionId) {\n\t\t\t\tconst requestSeq = ++this.archiveRequestSeq;\n\t\t\t\tconst result = await this.remote.unarchiveSession({ sessionId });\n\t\t\t\tif (result.ok && requestSeq === this.archiveRequestSeq) this.installArchived(result.value.archivedSessionIds);\n\t\t\t\treturn result;\n\t\t\t}";
const CLIENT_MODEL_INSERT = "\t\t\tasync unarchiveSession(sessionId) {\n\t\t\t\tconst requestSeq = ++this.archiveRequestSeq;\n\t\t\t\tconst result = await this.remote.unarchiveSession({ sessionId });\n\t\t\t\tif (result.ok && requestSeq === this.archiveRequestSeq) this.installArchived(result.value.archivedSessionIds);\n\t\t\t\treturn result;\n\t\t\t}\n\t\t\t/**\n\t\t\t* dsh-desktop patch (session manage): 删除一个会话。\n\t\t\t* @param sessionId - Session to delete.\n\t\t\t* @returns generated Remote result.\n\t\t\t*/\n\t\t\tasync deleteSession(sessionId) {\n\t\t\t\treturn await this.remote.deleteSession({ sessionId });\n\t\t\t}";

// 5b. WorkspaceController（客户端服务）：原生 unarchiveSession 之后、
// insertSessionBefore 之前插入 deleteSession。
const CLIENT_CTRL_ANCHOR = "\t\t\tasync unarchiveSession(sessionId) {\n\t\t\t\tconst result = await this.model.unarchiveSession(sessionId);\n\t\t\t\tif (!result.ok) throw commandError(\"session unarchive\", result.error);\n\t\t\t}";
const CLIENT_CTRL_INSERT = "\t\t\tasync unarchiveSession(sessionId) {\n\t\t\t\tconst result = await this.model.unarchiveSession(sessionId);\n\t\t\t\tif (!result.ok) throw commandError(\"session unarchive\", result.error);\n\t\t\t}\n\t\t\tasync deleteSession(sessionId) {\n\t\t\t\tconst result = await this.model.deleteSession(sessionId);\n\t\t\t\tif (!result.ok) throw commandError(\"session delete\", result.error);\n\t\t\t}";

// ---------------------------------------------------------------------------
// 6. dsh-api-remotes/lib/client.js：客户端 remote 注册表 bundle
// ---------------------------------------------------------------------------
// 6a. schema 常量（原生 unarchiveSession_result 之后、TYPERT_REMOTE$2 之前插入
// deleteSession 的 parameter/result schema；unarchive 系 schema 0.1.6 已原生）。
const REMOTES_SCHEMA_ANCHOR = "\t\tlet _deepseek_ai_dsh_api_workspace_controller_workspace_unarchiveSession_result$schema$value;\n\t\tconst _deepseek_ai_dsh_api_workspace_controller_workspace_unarchiveSession_result$schema = () => _deepseek_ai_dsh_api_workspace_controller_workspace_unarchiveSession_result$schema$value ??= object({ \"archivedSessionIds\": array(intersection(string(), unknown())).readonly() });";
const REMOTES_SCHEMA_INSERT = "\t\tlet _deepseek_ai_dsh_api_workspace_controller_workspace_unarchiveSession_result$schema$value;\n\t\tconst _deepseek_ai_dsh_api_workspace_controller_workspace_unarchiveSession_result$schema = () => _deepseek_ai_dsh_api_workspace_controller_workspace_unarchiveSession_result$schema$value ??= object({ \"archivedSessionIds\": array(intersection(string(), unknown())).readonly() });\n\t\tlet _deepseek_ai_dsh_api_workspace_controller_workspace_deleteSession_parameter_0$schema$value;\n\t\tconst _deepseek_ai_dsh_api_workspace_controller_workspace_deleteSession_parameter_0$schema = () => _deepseek_ai_dsh_api_workspace_controller_workspace_deleteSession_parameter_0$schema$value ??= object({ \"sessionId\": intersection(string(), unknown()).readonly() });\n\t\tlet _deepseek_ai_dsh_api_workspace_controller_workspace_deleteSession_result$schema$value;\n\t\tconst _deepseek_ai_dsh_api_workspace_controller_workspace_deleteSession_result$schema = () => _deepseek_ai_dsh_api_workspace_controller_workspace_deleteSession_result$schema$value ??= object({ \"deleted\": boolean().readonly() });";

// 6b. descriptor 条目（原生 unarchiveSession 描述符之后、数组闭合前插入
// deleteSession 描述符；unarchive 描述符 0.1.6 已原生，sourceLocation line 119）。
const REMOTES_INVOKE_ANCHOR = "\t\t\t\t\t\tcreate: _deepseek_ai_dsh_api_workspace_controller_workspace_unarchiveSession_result$schema\n\t\t\t\t\t},\n\t\t\t\t\tsourceLocation: {\n\t\t\t\t\t\t\"file\": \"packages/api/workspace-controller/src/index.ts\",\n\t\t\t\t\t\t\"line\": 165,\n\t\t\t\t\t\t\"column\": 3\n\t\t\t\t\t}\n\t\t\t\t},";
const REMOTES_INVOKE_INSERT = "\t\t\t\t\t\tcreate: _deepseek_ai_dsh_api_workspace_controller_workspace_unarchiveSession_result$schema\n\t\t\t\t\t},\n\t\t\t\t\tsourceLocation: {\n\t\t\t\t\t\t\"file\": \"packages/api/workspace-controller/src/index.ts\",\n\t\t\t\t\t\t\"line\": 165,\n\t\t\t\t\t\t\"column\": 3\n\t\t\t\t\t}\n\t\t\t\t},\n\t\t\t\t{\n\t\t\t\t\tid: \"@deepseek-ai/dsh-api-workspace-controller#workspace/deleteSession\",\n\t\t\t\t\tservice: \"workspaceController\",\n\t\t\t\t\tnamespace: \"workspace\",\n\t\t\t\t\tmethod: \"deleteSession\",\n\t\t\t\t\tinvocation: { kind: \"direct\" },\n\t\t\t\t\tparameters: [{\n\t\t\t\t\t\tname: \"request\",\n\t\t\t\t\t\twire: \"request\",\n\t\t\t\t\t\tsource: \"json\",\n\t\t\t\t\t\tcodec: {\n\t\t\t\t\t\t\tmode: \"strict\",\n\t\t\t\t\t\t\ttypeSymbol: \"@deepseek-ai/dsh-api-workspace-controller/types#WorkspaceDeleteSessionRequest\",\n\t\t\t\t\t\t\tcreate: _deepseek_ai_dsh_api_workspace_controller_workspace_deleteSession_parameter_0$schema\n\t\t\t\t\t\t}\n\t\t\t\t\t}],\n\t\t\t\t\tresult: {\n\t\t\t\t\t\tmode: \"strict\",\n\t\t\t\t\t\ttypeSymbol: \"@deepseek-ai/dsh-api-workspace-controller/types#WorkspaceDeleteSessionValue\",\n\t\t\t\t\t\tcreate: _deepseek_ai_dsh_api_workspace_controller_workspace_deleteSession_result$schema\n\t\t\t\t\t},\n\t\t\t\t\tsourceLocation: {\n\t\t\t\t\t\t\"file\": \"packages/api/workspace-controller/src/index.ts\",\n\t\t\t\t\t\t\"line\": 999,\n\t\t\t\t\t\t\"column\": 3\n\t\t\t\t\t}\n\t\t\t\t},";

// ---------------------------------------------------------------------------
// 7. dsh-client-ui-workspace：会话行菜单「删除对话」+ 翻译
// ---------------------------------------------------------------------------
// 0.2.0-rc.2 重锚：会话行 ⋯ 菜单不再是内联数组（旧 UI_MENU/UI_SELECT 那套
// `if (id === "archive") onArchive(node.id)` 已随上游重构消失），改成了
// `sidebar.workspaces.session.menu.item` 的 slot 列表（pin 100 / rename 200 /
// fork 300 / archive 400）。本层因此改为「注册第 5 行」：注入组件
// DeleteSessionMenuItem + props 闭包 deleteInjected + 一条 slots.register。
const UI_MENU_ANCHOR = "\t\t\t\t\tid: \"archive\",\n\t\t\t\t\torder: 400,\n\t\t\t\t\tlocale: NS,\n\t\t\t\t\tinject: archiveInjected\n\t\t\t\t}, ArchiveSessionMenuItem);";
const UI_MENU_INSERT = "\t\t\t\t\tid: \"archive\",\n\t\t\t\t\torder: 400,\n\t\t\t\t\tlocale: NS,\n\t\t\t\t\tinject: archiveInjected\n\t\t\t\t}, ArchiveSessionMenuItem);\n\t\t\t\t// dsh-desktop patch (session manage): 归档下方增加「删除对话」（order 450）。\n\t\t\t\tyield ctx.slots.register({\n\t\t\t\t\tname: \"sidebar.workspaces.session.menu.item\",\n\t\t\t\t\tid: \"delete\",\n\t\t\t\t\torder: 450,\n\t\t\t\t\tlocale: NS,\n\t\t\t\t\tinject: deleteInjected\n\t\t\t\t}, DeleteSessionMenuItem);";

const UI_COMP_ANCHOR = "\t\tfunction ArchiveSessionMenuItem({ sessionId, useArchived, useMenuOpenState, useShortcuts, archiveSession, unarchiveSession, t }) {";
const UI_COMP_INSERT = "\t\t/**\n\t\t* dsh-desktop patch (session manage): Menu row (order 450): 删除对话。\n\t\t* 桥缺失（未装 dsh-session-manager）时整行不渲染——显式降级，不是点了没反应。\n\t\t* @param props - 菜单开闭态与删除动作。\n\t\t* @returns the row, or nothing when the desktop bridge is absent.\n\t\t*/\n\t\tfunction DeleteSessionMenuItem({ sessionId, useMenuOpenState, deleteSession, t }) {\n\t\t\tconst [, setMenuOpen] = useMenuOpenState();\n\t\t\tif (!(" + DELETE_SESSION_MENU_GUARD + ")) return null;\n\t\t\treturn (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MenuItemButton, {\n\t\t\t\tdanger: true,\n\t\t\t\tonSelect: () => {\n\t\t\t\t\tsetMenuOpen(false);\n\t\t\t\t\tdeleteSession(sessionId);\n\t\t\t\t},\n\t\t\t\tchildren: t(\"menu.deleteSession\")\n\t\t\t});\n\t\t}\n\t\tfunction ArchiveSessionMenuItem({ sessionId, useArchived, useMenuOpenState, useShortcuts, archiveSession, unarchiveSession, t }) {";
const UI_INJECT_ANCHOR = "\t\t\tconst archiveInjected = () => ({";
const UI_INJECT_INSERT = "\t\t\t// dsh-desktop patch (session manage): 「删除对话」的 props 注入闭包。删除\n\t\t\t// 动作走 window.__dshSessionManager（配套插件 dsh-session-manager 提供：\n\t\t\t// 确认框 + workspace.deleteSession RPC + 错误提示）；桥缺失时组件不渲染该行。\n\t\t\tconst deleteInjected = () => ({\n\t\t\t\tdeleteSession: (sessionId) => {\n\t\t\t\t\twindow.__dshSessionManager?.deleteSession(sessionId);\n\t\t\t\t}\n\t\t\t});\n\t\t\tconst archiveInjected = () => ({";

const UI_ZH_ANCHOR = "\t\t\t\"menu.archiveSession\": \"归档会话\",";
const UI_ZH_INSERT = "\t\t\t\"menu.archiveSession\": \"归档会话\",\n\t\t\t\"menu.deleteSession\": \"删除对话\",";
const UI_EN_ANCHOR = "\t\t\t\"menu.archiveSession\": \"Archive session\",";
const UI_EN_INSERT = "\t\t\t\"menu.archiveSession\": \"Archive session\",\n\t\t\t\"menu.deleteSession\": \"Delete conversation\",";

// ---------------------------------------------------------------------------
// 工具：在文件中做「锚点必须存在 + 增量幂等」的替换
// ---------------------------------------------------------------------------
// 增量幂等（2026-08-31）：幂等判定从「全局 MARKER 存在即整文件跳过」改为
// 「逐替换项以 insert 自身判已完成」。背景：已打补丁的存量文件（旧版补丁
// 产物）带着 MARKER，后加的替换项（如 3a-2 inject 补全）永远到不了它们——
// 启动补丁每次 boot 都跑，全局跳过 = 新修复对存量安装零生效。逐项判定下：
// 旧替换在存量文件里 insert 已在 → 跳过；新替换 insert 不在 → 锚点命中 → 补上。
// 部分应用时任一锚点缺失即整体放弃（不落盘），保持单文件原子性。
function applyReplacements(file, replacements, log, stats, options) {
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log('session-manage 补丁: 读取失败 ' + file + ': ' + err.message);
    if (stats) stats.failed += 1;
    return false;
  }
  const alreadyMarked = src.includes(MARKER);
  let changed = false;
  for (const { anchor, insert, done } of replacements) {
    if (src.includes(done !== undefined ? done : insert)) continue; // 本替换已完成（insert/done 自身即完成标记）
    if (!src.includes(anchor)) {
      log('session-manage 补丁: 锚点未匹配（dsh 版本可能已变化），跳过 ' + file + ' :: ' + anchor.slice(0, 60));
      if (stats) stats.anchorMissing += 1;
      return false;
    }
    src = src.replace(anchor, insert);
    changed = true;
  }
  if (!changed && alreadyMarked) {
    log('session-manage 补丁: 已应用，跳过 ' + file);
    return false;
  }
  if (!alreadyMarked) {
    src = '// ' + MARKER + ': 对话删除/归档管理运行时补丁\n' + src;
  }
  try {
    if (options && options.dryRun) {
      log('session-manage 补丁: dry-run: 将应用 ' + file);
      return false; // dryRun 不落盘，不计为已写
    }
    writeFileAtomic(file, src);
    log('session-manage 补丁: 已应用 ' + file);
    return true;
  } catch (err) {
    log('session-manage 补丁: 写入失败 ' + file + ': ' + err.message);
    if (stats) stats.failed += 1;
    return false;
  }
}

/**
 * 对某个 node_modules 根目录应用对话删除/归档管理补丁（幂等）。
 * @param {string} nmRoot node_modules 根目录
 * @param {(msg: string) => void} [log]
 * @param {{anchorMissing?: number, failed?: number}} [stats] 计数回流
 *   （锚点失配与读写失败均由调用方报告采集）
 * @param {{dryRun?: boolean}} [options]
 * @returns {number} 实际发生修改的文件数
 */
function patchSessionManage(nmRoot, log = () => {}, stats, options) {
  // dsh-workspace/lib/index.js 已退出目标清单：unarchiveSession 在 0.2.0-rc.2
  // 原生（见上方第 1 节退役说明），无需注入。
  const targets = TARGETS.map((t) => ({
    file: path.join(nmRoot, ...t.rel),
    replacements: t.replacements,
  }));
  let changed = 0;
  for (const t of targets) {
    if (!fs.existsSync(t.file)) continue;
    if (applyReplacements(t.file, t.replacements, log, stats, options)) changed += 1;
  }
  return changed;
}

/**
 * 测试用：目标清单（相对 node_modules 的路径分段 + 各自的替换项）。
 * unit-session-manage.test.js 据此逐包拼夹具、逐锚点做反证。
 */
const TARGETS = [
  {
    rel: ['@deepseek-ai', 'dsh-session', 'lib', 'index.js'],
    replacements: [{ anchor: SESSION_ANCHOR, insert: SESSION_INSERT }],
  },
  {
    rel: ['@deepseek-ai', 'dsh-api-workspace-controller', 'lib', 'index.js'],
    replacements: [
      { anchor: HOST_IMPORT_ANCHOR, insert: HOST_IMPORT_INSERT },
      { anchor: HOST_INJECT_ANCHOR, insert: HOST_INJECT_INSERT },
      { anchor: HOST_CMDS_ANCHOR, insert: HOST_CMDS_INSERT },
      { anchor: HOST_CTRL_ANCHOR, insert: HOST_CTRL_INSERT },
    ],
  },
  {
    rel: ['@deepseek-ai', 'dsh-api-workspace-controller', 'lib', 'typert.host.js'],
    replacements: [
      { anchor: TYPERT_HOST_SCHEMA_ANCHOR, insert: TYPERT_HOST_SCHEMA_INSERT },
      { anchor: TYPERT_HOST_INVOKE_ANCHOR, insert: TYPERT_HOST_INVOKE_INSERT },
    ],
  },
  {
    rel: ['@deepseek-ai', 'dsh-api-workspace-controller', 'lib', 'client.js'],
    replacements: [
      { anchor: CLIENT_MODEL_ANCHOR, insert: CLIENT_MODEL_INSERT },
      { anchor: CLIENT_CTRL_ANCHOR, insert: CLIENT_CTRL_INSERT },
    ],
  },
  {
    rel: ['@deepseek-ai', 'dsh-api-remotes', 'lib', 'client.js'],
    replacements: [
      { anchor: REMOTES_SCHEMA_ANCHOR, insert: REMOTES_SCHEMA_INSERT },
      { anchor: REMOTES_INVOKE_ANCHOR, insert: REMOTES_INVOKE_INSERT },
    ],
  },
  {
    rel: ['@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js'],
    replacements: [
      // done 判据一律取「本注入体内部的独有文案」，绝不用 insert 全字节。原因（实测）：
      // 后跑的 open-project-dir（order 200）拿同一行 `function ArchiveSessionMenuItem(…)`
      // 与 `const archiveInjected = () => ({` 当锚点，把自身注入体插在锚点行之前 —— 那段
      // 位置正落在本补丁 UI_COMP / UI_INJECT 的 insert 字节区间内部，于是 insert 串被从
      // 中间劈开、判据变 false，二遍 boot 重插一次 → `function DeleteSessionMenuItem` 与
      // `const deleteInjected` 各声明两遍 → 该 bundle 直接 SyntaxError（Identifier
      // 'deleteInjected' has already been declared），工作区侧栏整块坏掉。注入体内的
      // 注释行不会被别的补丁触碰，故一律用它。
      { anchor: UI_MENU_ANCHOR, insert: UI_MENU_INSERT, done: 'dsh-desktop patch (session manage): 归档下方增加「删除对话」' },
      { anchor: UI_COMP_ANCHOR, insert: UI_COMP_INSERT, done: 'dsh-desktop patch (session manage): Menu row (order 450)' },
      { anchor: UI_INJECT_ANCHOR, insert: UI_INJECT_INSERT, done: 'dsh-desktop patch (session manage): 「删除对话」的 props 注入闭包' },
      { anchor: UI_ZH_ANCHOR, insert: UI_ZH_INSERT, done: '"menu.deleteSession": "删除对话"' },
      { anchor: UI_EN_ANCHOR, insert: UI_EN_INSERT, done: '"menu.deleteSession": "Delete conversation"' },
    ],
  },
];

/** 测试用：为每个目标包拼一份「只含本包全部锚点」的最小夹具文本。 */
function buildFixtures() {
  return TARGETS.map((t) => ({
    rel: t.rel,
    text: t.replacements.map((r) => r.anchor).join('\n// ---- 夹具分隔 ----\n') + '\n',
  }));
}

module.exports = { patchSessionManage, MARKER, TARGETS, buildFixtures };

if (require.main === module) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', 'node_modules');
  const n = patchSessionManage(root, (m) => console.log(m));
  console.log(n > 0 ? `patched ${n} file(s) — restart DSH Desktop to pick it up` : 'nothing to patch (already up to date)');
}
