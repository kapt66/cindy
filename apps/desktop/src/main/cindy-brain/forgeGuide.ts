/** Compatibility view for ghost_forge_guide. Authoring docs live only in the built-in Skill.
 * Raw imports embed the same shipped Markdown in dev, tests and packaged builds.
 */
import overview from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-overview.md?raw';
import sourceVerification from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-source-verification.md?raw';
import routineEvents from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-routine-events.md?raw';
import design from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-design.md?raw';
import structure from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-structure.md?raw';
import manifest from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-manifest.md?raw';
import tools from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-tools.md?raw';
import toolDiscovery from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-tool-discovery.md?raw';
import manual from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-manual.md?raw';
import runtime from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-runtime.md?raw';
import agentModels from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-agent-models.md?raw';
import media from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-media.md?raw';
import hostContext from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-host-context.md?raw';
import agentCallContext from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-agent-call-context.md?raw';
import chatCards from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-chat-cards.md?raw';
import eventSubscriptions from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-event-subscriptions.md?raw';
import messageHooks from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-message-hooks.md?raw';
import controlPoints from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-control-points.md?raw';
import pluginModels from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-models.md?raw';
import network from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-network.md?raw';
import settings from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-settings.md?raw';
import notifications from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-notifications.md?raw';
import filesAndLibrary from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-files-and-library.md?raw';
import agentTasks from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-agent-tasks.md?raw';
import hostTools from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-host-tools.md?raw';
import interactivePages from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-interactive-pages.md?raw';
import hostUi from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-host-ui.md?raw';
import nodeWorker from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-node-worker.md?raw';
import sessionContext from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-session-context.md?raw';
import directoryPicker from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-directory-picker.md?raw';
import panelPreview from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-panel-preview.md?raw';
import browserExtension from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-browser-extension.md?raw';
import bundledSkills from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-bundled-skills.md?raw';
import workspaceSessions from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-workspace-sessions.md?raw';
import confirmDialog from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-confirm-dialog.md?raw';
import mainView from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-main-view.md?raw';
import taskView from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-task-view.md?raw';
import recommendations from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-recommendations.md?raw';
import panels from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-panels.md?raw';
import mobilePages from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-mobile-pages.md?raw';
import sandbox from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-sandbox.md?raw';
import packaging from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-packaging.md?raw';
import publishing from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-publishing.md?raw';
import compatibility from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-compatibility.md?raw';
import pageGeneration from '../../../resources/system-skills/cindy-plugin-creator/references/examples/interactive-pages/PAGE-GENERATION.md?raw';

/**
 * Meka 适配层（2026-11-06 第七轮同步）。
 *
 * 上游把编写手册整体搬进内置 Skill（`resources/system-skills/cindy-plugin-creator/`），
 * `ghost_forge_guide` 只读同一份随包 Markdown。Meka 私有的两个安装权限
 * （`mcpr` / `reveal`）在上游手册里没有对应章节——上游没有这两项能力。为避免
 * 「能力还在、作者文档静默消失」，这里由 Host 追加 Meka 专属章节：共享底层仍是
 * 上游 Skill 正文，差异只在这个范围收敛的适配层表达。章号取新手册未使用的
 * 4.25 / 4.26，保持 `ghost_forge_guide` 按章号取章的唯一性契约。
 */
const MEKA_FORGE_GUIDE = `
## 4.25 MCPRouter 能力（mcpr，Cindy Meka 专属）

这不是 Cindy 上游能力，只在 Cindy Meka 上可用。插件需要访问 MCPRouter 时，在
\`ghost.json\` 顶层直接声明 \`mcpr\`（v3 没有 \`slots\`），并给出精确的 route 白名单：

\`\`\`json
{
  "schemaVersion": 3,
  "minCindyVersion": "0.1.122-beta",
  "mcpr": { "routes": ["other-configs.get"] }
}
\`\`\`

- route 只允许小写点分标识，最多 32 条、每条最多 128 字符；只有末尾 \`.*\` 是通配符，
  且只匹配同一 namespace。不能声明 URL、HTTP method、headers、Cookie、
  Authorization、client key 或任何其它 transport 字段；
- \`status\` 与 \`configure-login\` 是 Host 固定操作，不写入白名单；
- 业务 route 由 MCPRouter 服务端 registry 注册，只有已注册 route 才可调用。当前首个
  已接线业务 route 为 \`other-configs.get\`（\`account\` scope，输入只含 \`ownerUsername\`
  与 \`name\`）；
- 运行期可调用 \`cindy.mcpr.status()\` 与
  \`cindy.mcpr.call({ contractVersion: 1, route, input, scope })\`；
- 服务器运行插件还可调用
  \`cindy.mcpr.local({ action, instanceId, taskId, programId })\`。固定 action 为
  configure / probe-project-config / configure-project-config / describe / prepare /
  start / start-all / status / stop / stop-all / logs。\`configure\` 由宿主打开配置表
  目录选择框（绝对路径只留在 Host）；\`probe-project-config\` 与
  \`configure-project-config\` 只能在当前在途 Agent 工具调用里使用，只接受项目规则给出的
  单层安全相对子目录，Host 用 callId 反查任务工作目录后再校验；\`prepare\` 显式下载并
  校验产物，\`start\` 不会隐式下载；
- Cindy Main 负责本地产物、构建身份与进程生命周期，插件不会接触绝对路径、PID、
  命令或凭证。

## 4.26 在系统文件管理器中定位本机文件（reveal，Cindy Meka 专属）

同样不是 Cindy 上游能力。声明 \`"reveal": true\` 后，插件可以请 Host 在系统文件管理器
中**定位**一个已存在的本机普通文件或目录：

\`\`\`js
const r = await cindy.reveal({ path: picked.path });  // {ok:true} 或 {ok:false,errorCode}
\`\`\`

- 只做「定位/选中」，不读内容、不写文件、不回传规范化后的路径；文件夹会打开其父目录
  并选中该文件夹；
- 绝对路径由 Host 重新 realpath / stat 校验后交给 OS；路径不存在、来自远程工作区或
  无法交给 OS 时 fail closed（NOT_FOUND / NOT_FILE / INTERNAL）；
- 这是独立安装权限：不能用 \`fs\`、面板桥或 Agent 在途授权替代；
- 同一声明还会让 \`cindy.pick\` 在 \`mode:"directory"\` 与不带 \`into\` 的 \`mode:"file"\`
  结果里返回 \`path\`（未声明 \`node\` / \`reveal\` 的插件拿不到绝对路径，只能走票据或
  \`into\` 导入）。

### 面板呈现方式（Meka 专属字段）

停靠面板还可用 \`panel.allowUserPresentationOverride: true\` 声明「允许用户在本机把这块
面板改成 Meka 的另一种呈现方式」。它只影响本机用户自己的界面偏好，不授予任何能力、
不改变沙箱与协议；未声明时用户看不到该开关。上游没有这个字段，写进清单在 Cindy
上游按未知字段原样保留、不生效。
`;

export const FORGE_GUIDE = [
  overview,
  sourceVerification,
  routineEvents,
  design,
  structure,
  manifest,
  tools,
  toolDiscovery,
  manual,
  runtime,
  agentModels,
  media,
  hostContext,
  agentCallContext,
  chatCards,
  eventSubscriptions,
  messageHooks,
  controlPoints,
  pluginModels,
  network,
  settings,
  notifications,
  filesAndLibrary,
  agentTasks,
  hostTools,
  nodeWorker,
  sessionContext,
  directoryPicker,
  panelPreview,
  browserExtension,
  bundledSkills,
  workspaceSessions,
  confirmDialog,
  mainView,
  taskView,
  recommendations,
  interactivePages,
  hostUi,
  panels,
  mobilePages,
  sandbox,
  packaging,
  publishing,
  compatibility,
  MEKA_FORGE_GUIDE,
].join('\n');

/** ghost_forge_guide section "pages": the same PAGE-GENERATION.md the MCP Apps manual header hashes. */
export const FORGE_PAGE_MANUAL = pageGeneration;
