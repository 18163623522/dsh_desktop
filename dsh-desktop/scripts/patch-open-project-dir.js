'use strict';

// 侧栏「打开项目目录」（issue #85）运行时补丁（幂等、锚点不匹配时跳过且绝不
// 损坏文件）。
//
// 背景：dsh 的侧栏项目行 / 会话行 ⋯ 菜单没有「打开项目目录」入口，也无法用
// 右键直接呼出行菜单。本补丁在官方包 dsh-client-ui-workspace 上做外科手术式
// 扩展：
//
//   1. 项目行菜单（workspaceMenuItems）末尾追加 open-folder 项（文件夹图标），
//      点击调 window.dshDesktop.openPath(row.cwd)；
//   2. 会话行「打开项目目录」—— 0.2.0-rc.2 起重锚为 slot 注册：上游把会话行
//      ⋯ 菜单从内联数组改成 sidebar.workspaces.session.menu.item 列表（pin 100 /
//      rename 200 / fork 300 / archive 400），本补丁注册 order 500 的
//      OpenProjectDirMenuItem，cwd 由注入闭包从 sessions 快照反查，查不到
//      （孤儿 / 未分组会话）或桥缺失时整行不渲染；
//   3. 项目行 / 会话行 div 增加 onContextMenu：preventDefault + stopPropagation
//      后在同一个菜单以光标坐标弹出（getAnchorRect 提供完整四边矩形
//      left/top/right/bottom，right=x+1、bottom=y+1 —— 修复只给左/上两边的
//      初版实现：align=start + side=bottom 时 y 变 NaN，portal 落到静态位置）；
//   4. 菜单锚点矩形统一走 getAnchorRect：⋯ 按钮点击时返回按钮矩形，右键时
//      返回光标矩形。primitives 的 Menu 在本版内核仍支持该形参
//      （@deepseek-ai/dsh-client-ui-primitives/lib/index.js 参数清单可见）。
//
// 桥 openPath 为本项目 Tauri 宿主自己暴露的能力
// （src-tauri/crates/bridge/dist/bridge-shim.js 里 window.dshDesktop.openPath →
// invoke file_open），不是官方全局对象；桥缺失时（纯浏览器）`?.` 可选链静默
// 降级为无操作，且会话行菜单项直接不渲染。
//
// 用法：
//   node scripts/patch-open-project-dir.js [<node_modules 根目录>]
// 同时导出 patchOpenProjectDir(nmRoot, log) 供 main.js 启动补丁与 after-pack.js
// 打包补丁复用（覆盖内置副本 / profile fallback / agent overlay / dev）。

const fs = require('node:fs');
const path = require('node:path');
// 原子写与 main.js / 其它补丁脚本共用同一实现（scripts/lib/patch-io.js）。
const { writeFileAtomic } = require('./lib/patch-io');

const MARKER = 'dsh-desktop patch (open project dir)';

// ---------------------------------------------------------------------------
// 1. dsh-client-ui-workspace：项目行 / 会话行菜单 + 右键菜单
// ---------------------------------------------------------------------------

// 1a. 项目行菜单项数组：delete 项后追加 open-folder 项。
const UI_PROJECT_ITEMS_ANCHOR = "}, {\n\t\t\t\tid: \"delete\",\n\t\t\t\tlabel: t(\"delete.workspace\"),\n\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutlineRegular, {}),\n\t\t\t\tdanger: true\n\t\t\t}];";
const UI_PROJECT_ITEMS_INSERT = "}, {\n\t\t\t\tid: \"delete\",\n\t\t\t\tlabel: t(\"delete.workspace\"),\n\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutlineRegular, {}),\n\t\t\t\tdanger: true\n\t\t\t}, {\n\t\t\t\t// dsh-desktop patch (open project dir): 打开项目目录。\n\t\t\t\tid: \"open-folder\",\n\t\t\t\tlabel: t(\"menu.openProjectDir\"),\n\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenRegular, {})\n\t\t\t}];";

// 1b. 项目行菜单 onSelect：放行 open-folder 并调用桥。
const UI_PROJECT_SELECT_ANCHOR = 'if (id !== "rename" && id !== "delete") return;\n\t\t\t\t\t\t\t\tif (id === "rename") actions.rename();\n\t\t\t\t\t\t\t\telse actions.delete();';
const UI_PROJECT_SELECT_INSERT = 'if (id !== "rename" && id !== "delete" && id !== "open-folder") return;\n\t\t\t\t\t\t\t\tif (id === "rename") actions.rename();\n\t\t\t\t\t\t\t\telse if (id === "delete") actions.delete();\n\t\t\t\t\t\t\t\telse if (id === "open-folder") window.dshDesktop?.openPath?.(row.cwd);';

// 1c. 项目行 div：右键弹出同一菜单（光标锚点；无 actions 的未分组桶不弹）。
const UI_PROJECT_DIV_ANCHOR = 'role: "treeitem",\n\t\t\t\t"aria-expanded": row.expanded,\n\t\t\t\tonClick: onToggle,';
const UI_PROJECT_DIV_INSERT = 'role: "treeitem",\n\t\t\t\t"aria-expanded": row.expanded,\n\t\t\t\tonClick: onToggle,\n\t\t\t\tonContextMenu: (e) => {\n\t\t\t\t\te.preventDefault();\n\t\t\t\t\te.stopPropagation();\n\t\t\t\t\tif (actions === void 0) return;\n\t\t\t\t\tsetMenuRect({ left: e.clientX, top: e.clientY, right: e.clientX + 1, bottom: e.clientY + 1 });\n\t\t\t\t\tsetMenuOpen(true);\n\t\t\t\t},';

// 1d. 项目行：右键锚点矩形 state。
const UI_PROJECT_STATE_ANCHOR = "const active = containsCurrentDescendant || group.expanded && group.containsCurrent;\n\t\t\tconst [menuOpen, setMenuOpen] = (0, react.useState)(false);";
const UI_PROJECT_STATE_INSERT = "const active = containsCurrentDescendant || group.expanded && group.containsCurrent;\n\t\t\tconst [menuOpen, setMenuOpen] = (0, react.useState)(false);\n\t\t\tconst [menuRect, setMenuRect] = (0, react.useState)(null);";

// 1e. 项目行 Menu：锚点矩形统一走 getAnchorRect（portal 定位用）。
const UI_PROJECT_ANCHOR_ANCHOR = 'items: workspaceMenuItems,\n\t\t\t\t\t\t\tonSelect: (id) => {';
const UI_PROJECT_ANCHOR_INSERT = 'items: workspaceMenuItems,\n\t\t\t\t\t\t\tgetAnchorRect: () => menuRect,\n\t\t\t\t\t\t\tonSelect: (id) => {';

// 1f. 项目行 ⋯ 按钮：点击时用按钮矩形做锚点。
const UI_PROJECT_BUTTON_ANCHOR = '"aria-label": t("actions.workspace.aria", { name: label }),\n\t\t\t\t\t\t\t\tonClick: (e) => {\n\t\t\t\t\t\t\t\t\te.stopPropagation();\n\t\t\t\t\t\t\t\t\tsetMenuOpen((v) => !v);\n\t\t\t\t\t\t\t\t},';
const UI_PROJECT_BUTTON_INSERT = '"aria-label": t("actions.workspace.aria", { name: label }),\n\t\t\t\t\t\t\t\tonClick: (e) => {\n\t\t\t\t\t\t\t\t\te.stopPropagation();\n\t\t\t\t\t\t\t\t\tsetMenuRect(e.currentTarget.getBoundingClientRect());\n\t\t\t\t\t\t\t\t\tsetMenuOpen((v) => !v);\n\t\t\t\t\t\t\t\t},';

// 2a. 会话行「打开项目目录」：0.2.0-rc.2 重锚。
// 上游把会话行 ⋯ 菜单从内联数组改成了 sidebar.workspaces.session.menu.item 的
// slot 列表，SessionNodeItem 不再有 sessionMenuItems / onSelect / onRename/onFork/
// onArchive 形参，也不接收 cwd prop。本层随之改为「注册一个 slot 行」：组件
// OpenProjectDirMenuItem + props 闭包 openDirInjected + 一条 slots.register
// （order 500）。cwd 由注入闭包从 sessions 快照反查，因此旧的「组件签名加 cwd
// prop + 两处调用点传 cwd」三项一并退役。
const UI_SESSION_COMP_ANCHOR = "\t\tfunction ArchiveSessionMenuItem({ sessionId, useArchived, useMenuOpenState, useShortcuts, archiveSession, unarchiveSession, t }) {";
const UI_SESSION_COMP_INSERT = "\t\t/**\n\t\t* dsh-desktop patch (open project dir): Menu row (order 500): 打开会话所在项目\n\t\t* 目录。cwd 从 sessions 快照反查（孤儿/未分组会话查不到即整行不渲染）；\n\t\t* 宿主桥 window.dshDesktop.openPath 缺失（纯浏览器）时同样不渲染。\n\t\t* @param props - 菜单开闭态、cwd 反查与打开动作。\n\t\t* @returns the row, or nothing when there is no directory to open.\n\t\t*/\n\t\tfunction OpenProjectDirMenuItem({ sessionId, useMenuOpenState, sessionCwd, canOpenDir, openSessionDir, t }) {\n\t\t\tconst [, setMenuOpen] = useMenuOpenState();\n\t\t\tconst cwd = sessionCwd(sessionId);\n\t\t\tif (cwd === void 0 || !canOpenDir) return null;\n\t\t\treturn (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MenuItemButton, {\n\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenRegular, { size: 14 }),\n\t\t\t\tonSelect: () => {\n\t\t\t\t\tsetMenuOpen(false);\n\t\t\t\t\topenSessionDir(sessionId, cwd);\n\t\t\t\t},\n\t\t\t\tchildren: t(\"menu.openProjectDir\")\n\t\t\t});\n\t\t}\n\t\tfunction ArchiveSessionMenuItem({ sessionId, useArchived, useMenuOpenState, useShortcuts, archiveSession, unarchiveSession, t }) {";
const UI_SESSION_INJECT_ANCHOR = "\t\t\tconst archiveInjected = () => ({";
const UI_SESSION_INJECT_INSERT = "\t\t\t// dsh-desktop patch (open project dir): 「打开项目目录」的 props 注入闭包。\n\t\t\t// 闭包拿不到 sessionId（slot 的 inject 是无参工厂），故把 cwd 反查做成函数\n\t\t\t// 交给组件；桥为 preload 暴露的 window.dshDesktop.openPath（本仓库自己的\n\t\t\t// 宿主桥，非官方同名全局），缺失时组件不渲染该行。\n\t\t\tconst openDirInjected = () => ({\n\t\t\t\tsessionCwd: (sessionId) => sessions.list.getSnapshot().byId[sessionId]?.cwd,\n\t\t\t\tcanOpenDir: typeof window.dshDesktop?.openPath === \"function\",\n\t\t\t\topenSessionDir: (sessionId, cwd) => {\n\t\t\t\t\twindow.dshDesktop?.openPath?.(cwd ?? sessions.list.getSnapshot().byId[sessionId]?.cwd);\n\t\t\t\t}\n\t\t\t});\n\t\t\tconst archiveInjected = () => ({";
const UI_SESSION_REG_ANCHOR = "\t\t\t\t\tid: \"archive\",\n\t\t\t\t\torder: 400,\n\t\t\t\t\tlocale: NS,\n\t\t\t\t\tinject: archiveInjected\n\t\t\t\t}, ArchiveSessionMenuItem);";
const UI_SESSION_REG_INSERT = "\t\t\t\t\tid: \"archive\",\n\t\t\t\t\torder: 400,\n\t\t\t\t\tlocale: NS,\n\t\t\t\t\tinject: archiveInjected\n\t\t\t\t}, ArchiveSessionMenuItem);\n\t\t\t\t// dsh-desktop patch (open project dir): 会话行菜单增加「打开项目目录」（order 500）。\n\t\t\t\tyield ctx.slots.register({\n\t\t\t\t\tname: \"sidebar.workspaces.session.menu.item\",\n\t\t\t\t\tid: \"open-folder\",\n\t\t\t\t\torder: 500,\n\t\t\t\t\tlocale: NS,\n\t\t\t\t\tinject: openDirInjected\n\t\t\t\t}, OpenProjectDirMenuItem);";

// 2b. 会话行：右键锚点矩形 state。
const UI_SESSION_STATE_ANCHOR = "\t\t\tconst [menuOpen, setMenuOpen] = (0, react.useState)(false);\n\t\t\tconst menuOpenState = (0, react.useMemo)(() => [menuOpen, setMenuOpen], [menuOpen]);";
const UI_SESSION_STATE_INSERT = "\t\t\tconst [menuOpen, setMenuOpen] = (0, react.useState)(false);\n\t\t\tconst menuOpenState = (0, react.useMemo)(() => [menuOpen, setMenuOpen], [menuOpen]);\n\t\t\tconst [menuRect, setMenuRect] = (0, react.useState)(null);";

// 2e. 会话行 div：右键弹出同一菜单（光标锚点；blank 占位行无菜单不弹）。
const UI_SESSION_DIV_ANCHOR = "\t\t\t\t\t\"aria-selected\": selected,\n\t\t\t\t\t\"aria-description\": row.archived ? t(\"toast.archivedNotOpenable\") : void 0,\n\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\tonOpen(node.id);\n\t\t\t\t\t},";
const UI_SESSION_DIV_INSERT = "\t\t\t\t\t\"aria-selected\": selected,\n\t\t\t\t\t\"aria-description\": row.archived ? t(\"toast.archivedNotOpenable\") : void 0,\n\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\tonOpen(node.id);\n\t\t\t\t\t},\n\t\t\t\t\tonContextMenu: (e) => {\n\t\t\t\t\t\te.preventDefault();\n\t\t\t\t\t\te.stopPropagation();\n\t\t\t\t\t\tif (row.blank) return;\n\t\t\t\t\t\tsetMenuRect({ left: e.clientX, top: e.clientY, right: e.clientX + 1, bottom: e.clientY + 1 });\n\t\t\t\t\t\tsetMenuOpen(true);\n\t\t\t\t\t},";

// 2f. 会话行 Menu：锚点矩形统一走 getAnchorRect。
const UI_SESSION_ANCHOR_ANCHOR = "\t\t\t\t\t\t\t\tportal: true,\n\t\t\t\t\t\t\t\tcloseOnPointerLeave: true,";
const UI_SESSION_ANCHOR_INSERT = "\t\t\t\t\t\t\t\tportal: true,\n\t\t\t\t\t\t\t\tcloseOnPointerLeave: true,\n\t\t\t\t\t\t\t\tgetAnchorRect: () => menuRect,";

// 2g. 会话行 ⋯ 按钮：点击时用按钮矩形做锚点。
const UI_SESSION_BUTTON_ANCHOR = "\t\t\t\t\t\t\t\t\t\"aria-label\": t(\"actions.session.aria\", { name: title }),\n\t\t\t\t\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\t\t\t\t\tsetMenuOpen((v) => !v);\n\t\t\t\t\t\t\t\t\t},";
const UI_SESSION_BUTTON_INSERT = "\t\t\t\t\t\t\t\t\t\"aria-label\": t(\"actions.session.aria\", { name: title }),\n\t\t\t\t\t\t\t\t\tonClick: (e) => {\n\t\t\t\t\t\t\t\t\t\te.stopPropagation();\n\t\t\t\t\t\t\t\t\t\tsetMenuRect(e.currentTarget.getBoundingClientRect());\n\t\t\t\t\t\t\t\t\t\tsetMenuOpen((v) => !v);\n\t\t\t\t\t\t\t\t\t},";

// 4. 翻译：zh / en（锚原生 menu.unarchiveSession 行，不与 session-manage 的
// 注入体 chained——两者顺序无关，任一先跑都能命中）。
const UI_ZH_ANCHOR = "\t\t\t\"menu.unarchiveSession\": \"取消归档\",";
const UI_ZH_INSERT = "\t\t\t\"menu.openProjectDir\": \"打开项目目录\",\n\t\t\t\"menu.unarchiveSession\": \"取消归档\",";
const UI_EN_ANCHOR = "\t\t\t\"menu.unarchiveSession\": \"Unarchive session\",";
const UI_EN_INSERT = "\t\t\t\"menu.openProjectDir\": \"Open project directory\",\n\t\t\t\"menu.unarchiveSession\": \"Unarchive session\",";

const UI_REPLACEMENTS = [
  { anchor: UI_PROJECT_ITEMS_ANCHOR, insert: UI_PROJECT_ITEMS_INSERT },
  { anchor: UI_PROJECT_SELECT_ANCHOR, insert: UI_PROJECT_SELECT_INSERT },
  { anchor: UI_PROJECT_DIV_ANCHOR, insert: UI_PROJECT_DIV_INSERT },
  { anchor: UI_PROJECT_STATE_ANCHOR, insert: UI_PROJECT_STATE_INSERT },
  { anchor: UI_PROJECT_ANCHOR_ANCHOR, insert: UI_PROJECT_ANCHOR_INSERT },
  { anchor: UI_PROJECT_BUTTON_ANCHOR, insert: UI_PROJECT_BUTTON_INSERT },
  { anchor: UI_SESSION_STATE_ANCHOR, insert: UI_SESSION_STATE_INSERT },
  { anchor: UI_SESSION_COMP_ANCHOR, insert: UI_SESSION_COMP_INSERT },
  { anchor: UI_SESSION_INJECT_ANCHOR, insert: UI_SESSION_INJECT_INSERT },
  { anchor: UI_SESSION_REG_ANCHOR, insert: UI_SESSION_REG_INSERT },
  { anchor: UI_SESSION_DIV_ANCHOR, insert: UI_SESSION_DIV_INSERT },
  { anchor: UI_SESSION_ANCHOR_ANCHOR, insert: UI_SESSION_ANCHOR_INSERT },
  { anchor: UI_SESSION_BUTTON_ANCHOR, insert: UI_SESSION_BUTTON_INSERT },
  { anchor: UI_ZH_ANCHOR, insert: UI_ZH_INSERT },
  { anchor: UI_EN_ANCHOR, insert: UI_EN_INSERT },
];

// ---------------------------------------------------------------------------
// 工具：在文件中做「锚点必须存在 + 标记幂等」的替换
// ---------------------------------------------------------------------------
function applyReplacements(file, replacements, log, stats, options) {
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log('open-project-dir 补丁: 读取失败 ' + file + ': ' + err.message);
    return false;
  }
  if (src.includes(MARKER)) {
    log('open-project-dir 补丁: 已应用，跳过 ' + file);
    return false;
  }
  for (const { anchor, insert } of replacements) {
    if (!src.includes(anchor)) {
      log('open-project-dir 补丁: 锚点未匹配（dsh 版本可能已变化），跳过 ' + file + ' :: ' + anchor.slice(0, 60));
      if (stats) stats.anchorMissing += 1;
      return false;
    }
    src = src.replace(anchor, insert);
  }
  src = '// ' + MARKER + ': 侧栏「打开项目目录」+ 右键菜单（issue #85）\n' + src;
  try {
    if (options && options.dryRun) {
      log('open-project-dir 补丁: dry-run: 将应用 ' + file);
      return false; // dryRun 不落盘，不计为已写
    }
    writeFileAtomic(file, src);
    log('open-project-dir 补丁: 已应用 ' + file);
    return true;
  } catch (err) {
    log('open-project-dir 补丁: 写入失败 ' + file + ': ' + err.message);
    return false;
  }
}

/**
 * 对某个 node_modules 根目录应用「打开项目目录」补丁（幂等）。
 * @param {string} nmRoot node_modules 根目录
 * @param {(msg: string) => void} [log]
 * @returns {number} 实际发生修改的文件数
 */
function patchOpenProjectDir(nmRoot, log = () => {}, stats, options) {
  const targets = [
    {
      file: path.join(nmRoot, '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js'),
      replacements: UI_REPLACEMENTS,
    },
  ];
  let changed = 0;
  for (const t of targets) {
    if (!fs.existsSync(t.file)) continue;
    if (applyReplacements(t.file, t.replacements, log, stats, options)) changed += 1;
  }
  return changed;
}

/** 测试用：构造一份包含全部 UI 锚点的最小夹具（unit-open-project-dir.test.js 使用）。 */
function buildUiFixture() {
  return UI_REPLACEMENTS.map((r) => r.anchor).join('\n// ---- 夹具分隔 ----\n') + '\n';
}

module.exports = { patchOpenProjectDir, MARKER, buildUiFixture, UI_REPLACEMENTS };

if (require.main === module) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', 'node_modules');
  const n = patchOpenProjectDir(root, (m) => console.log(m));
  console.log(n > 0 ? `patched ${n} file(s) — restart DSH Desktop to pick it up` : 'nothing to patch (already up to date)');
}
