# 插件分发来源与版本兼容（Cindy Meka 提案）

> **状态**：**提议中（proposed）**。本文件是 RFC，不是现行规则正本；获批前不构成约束，
> 也不得据它改写既有规则正文。获批后的登记动作见 §8。
> **实现现状**：P1 的代码已落在**未提交**工作区（工件、身份收口、门禁、dev 上报版本覆盖
> `XDT_PLUGIN_CLIENT_VERSION`），逐项状态与相对本文的三处偏差见 §5.1.1；P2 的**客户端就绪件**
> （协议常量 + 运行期开关，**默认不发**）也已落在同一工作区，见 §5.5.1。落地不改变本节状态，
> §8 的索引／登记动作尚未执行。
> **读取时机**：改动插件分发来源边界、插件版本兼容判定、插件 manifest 版本字段、
> 客户端版本上报（`x-cindy-version`）、或 Cindy／Meka 两条插件市场渠道的接线之前。
> **事实基线**：`meka/main` @ `1b4f6a7c91`（2026-09-23）。本文所有 `文件:行` 均按该
> 基线核对；工作区另有未提交的在途改动，见 §5.4。
> **定位**：本文件回答「**插件该从哪个源分发、兼容性下限在谁的空间里比较**」。插件
> 沙箱、权限、能力 slot、作者契约等正本仍在
> [`plugin-security-and-authoring.md`](plugin-security-and-authoring.md)；跨端协议修改准入
> 在 [`protocol-and-submodules.md`](protocol-and-submodules.md)。本文不复制其内容。

---

## 0. 结论摘要（先给权威结论）

1. **缺陷成立**：Cindy Meka 的发布版本线是 `0.0.x`，而上游插件的兼容下限写在
   `0.1.x`；同一个 `minCindyVersion` 字段同时承载了两条互不可比的版本线，导致
   「站点」这类由 `mainView` 提供的能力在发布版被服务端投影挡掉，在 dev 上却放行。
   证据见 §1。
2. **根因不是"字段写错了"，而是"版本空间没有被声明"**：没有任何地方说明一次比较
   发生在哪条线上。因此修法不是调数值，而是把 **edition →（来源、版本空间、
   客户端身份）** 变成显式声明的工件（§3.2）。
3. **选定方案 B**（客户端显式声明空间 + 服务端空间化投影）为主，**方案 A**
   （manifest 加 per-edition 下限字段）只在「同一 release 必须跨空间发布」时作为
   最小补充，且**不得**引入 `schemaVersion: 4`。对比见 §3.3。
4. **`minCindyVersion` 最终口径**：它是**发布 edition 所属版本空间内的下限**——同一个
   字段名，空间由 release 的发布 edition 决定，不由客户端决定（§3.4）。Meka 生态里它
   指 `0.0.x` 这条线；上游 edition 里仍指上游线。**禁止**把 Meka 版本翻译成上游版本去凑
   比较。
5. **两条红线不因本设计放宽**：客户端永不按 `minCindyVersion` 二次筛选；正式包永不
   伪装成 versionless（`0.0.0`）。见 §3.6。
6. **能力被门挡下必须可观测**：今天「插件没下发」与「插件不存在」在客户端不可区分，
   也没有任何解释入口。目标契约要求机器可读 reason + 本地结构化诊断（§3.5、§6）。

---

## 1. 问题陈述

### 1.1 三件已确证的事实，合起来构成本缺陷

| # | 事实 | 证据（`文件:行`） |
|---|---|---|
| F1 | Meka 发布版本线是 `0.0.x`（实测发布版 `app.getVersion()` = `0.0.25`；dev = `0.0.0`） | `apps/desktop/scripts/ci/package-lib.mjs:190-205`（`--version` 解析与 versionless 占位）；`scripts/__tests__/meka-release-identity.test.mjs:15-40`（`cindy-meka-<x.y.z>` / `cindy-meka-unversioned`） |
| F2 | 上游插件的下限写在 `0.1.x`：`xd-sites ≥ 1.0.11` 的 manifest 声明 `minCindyVersion: "0.1.61"`，且 `schemaVersion: 3` **强制**必须声明该字段 | `packages/plugin-protocol/src/manifest.ts:1264-1266`；`manifest.ts:1146-1189`（字段在已知顶层字段白名单内） |
| F3 | 唯一的兼容闸门是**服务端按客户端版本投影**；客户端不二次筛选 | `manifest.ts:1124-1134`（`supportsCindyVersion`）；`packages/plugin-protocol/src/delivery.ts:125-127`（只下发单个 `currentRelease`，无候选列表）；[`plugin-security-and-authoring.md:153-160`](plugin-security-and-authoring.md)；`apps/desktop/src/main/cindy-brain/forge.ts:1758-1763`；`apps/desktop/help-knowledge/plugins.md:31-33` |
| F4 | 客户端把 `app.getVersion()` 原样上报给市场 | `apps/desktop/src/main/plugin-market/service.ts:646`；`apps/desktop/src/main/plugin-market/api.ts:11,85-91`；头名常量在 `delivery.ts:25` |
| F5 | Meka 包仍然直接读**上游**市场地址；发布流程只置空 `cdnBaseUrl`，`pluginApiBaseUrl` 等原样转发 | `config/endpoint.json:15-17`、`config/endpoint.global.json:15-17`、`config/endpoint.local.json:16-17`；`apps/desktop/scripts/ci/release-lib.mjs:224-248` |

合成结果：`0.0.25 < 0.1.61` ⇒ 服务端为发布版客户端找不到兼容 release ⇒ **不展示**
`xd-sites` ⇒ 侧栏「站点」入口（由该插件 `mainView` 提供）整体缺席。dev 的 `0.0.0`
命中 `isVersionlessCindyVersion`（`manifest.ts:1082-1089`）被**无条件放行**，于是同一台
机器上「本地有、发布版没有」。这条放行有测试锁定（`packages/plugin-protocol/src/__tests__/manifest.test.ts:196-203`），
不是意外行为，而是**为 dev 设计**的语义被 Meka 的正式版本线撞上了。

### 1.2 同一个字段在两端语义相反（缺陷的机制，而非现象）

- **上游→Meka**：作者写 `0.1.61` 意为「需要上游 0.1.61 起的能力」。对 Meka 发布版
  `0.0.25` 这个下限**永远不可达**（数值上不可比，语义上也没承诺）。
- **Meka→上游**：Forge 生成脚手架时把 `minCindyVersion` 默认写成**当前 App 版本**
  （`apps/desktop/src/main/mcp-integrations/ghost.ts:2453-2460`；`:2439-2451` 拒绝
  `0.0.0` 与非稳定版本）。Meka 作者写出的 `0.0.x` 对**上游客户端永远满足**，等于把
  下限低估成"无限制"。
- 字段只有一个，值里不含空间信息，**任何一侧都无法判断对方的数值属于哪条线**。因此
  这不是数据错误，而是**契约缺失**：比较操作缺少前置条件（同空间）。

### 1.3 本 RFC 新增的取证（基线仓上可复现）

- **E1（Meka 渠道恒发 `0.0.0`）**：`MekaPluginMarketApi` 构造时只传 fetcher，
  没传版本读取器（`api.ts:167-176` @ HEAD），于是落到基类默认值 `() => '0.0.0'`
  （`api.ts:67-79`）。即：Meka 渠道**无论什么构建**都上报 versionless，服务端在 Meka
  渠道上的版本兼容门是整体失效的；现有测试只断言了两渠道的 endpoint／凭证隔离，**没有
  断言任何一条渠道的版本头**（`apps/desktop/src/main/plugin-market/__tests__/api.test.ts:191-214`）。
- **E2（同一比较器被跨空间复用）**：`supportsCindyVersion` 被用来比较**插件自身版本**
  （`apps/desktop/src/main/cindy-brain/index.ts:3792-3798`：`supportsCindyVersion(ghost.manifest.version, '1.12.5')`）。
  这在数值上"能用"，但恰好证明：仓内没有"哪个比较发生在哪个空间"的概念，只有一把
  全局 SemVer 尺子。
- **E3（`0.0.0` 一个字面量三种含义）**：①`cindy-meka` 正式版本线的邻域（`0.0.x`）；
  ②「版本无关 / 社区源码打包」哨兵（`package-lib.mjs:14`、`apps/desktop/src/main/updateService.ts:1435`）；
  ③协议层「未定版 ⇒ 无条件放行」（`manifest.ts:1087-1089`）。三者共用一个数值域，是本
  缺陷能长期静默的结构原因。

### 1.4 为什么"没被发现"

被门挡下的结果是**插件压根不在目录里**，与"这个市场没有这个插件"完全同形；客户端按
不变量不做二次筛选、不弹兼容提示（`plugin-security-and-authoring.md:156-158`），因此没有
任何一层留下"被挡"的痕迹。没有成功提示，也没有失败提示——这正是 §2③ 要求修的点。

---

## 2. 设计原则

① **产品版本只回答"哪一代／该给哪种资产"；兼容性由独立声明的维度回答。**
   版本号是身份与选资产生效的键（更新渠道、产物命名、runtime pin），不是能力契约。
   仓内既有范式：mobile 用**运行时指纹**而非版本号判定冷更
   （`apps/mobile/app.json:10-11` 的 `runtimeVersion.policy: "fingerprint"`）；远端运行时用
   **pin + protocol 协商**而不是靠版本号猜（[`meka-whitelist-verification.md:319-331`](meka-whitelist-verification.md) WL-4.1.6/4.1.7）。
   插件兼容性必须与"客户端是第几代 Meka"分开声明。

② **任何兼容判定只允许在同一条版本线（空间）内比较。**
   跨空间比较不是"结果不确定"，而是**无定义操作**，必须 fail closed 到「不适用」，
   不得退化成「满足」或「不满足」。空间必须是**被声明的输入**，不能靠数值范围猜。

③ **能力被门挡下必须可观测，禁止反向提示成功。**
   投影未命中、空间不匹配、身份不可判定三种情形必须产生互不相同的机器可读 reason，
   并在客户端可见；不得把"没有下发"记录成成功，也不得在能力缺席时装作正常。

④ **dev 与 release 上报同一语义身份。**
   "同一"指**同一套解析规则**下的身份（含 identityKind：`versioned` / `unversioned`），
   而不是"数值相同"。本地必须能用与发布版相同的解析器复现发布版的判定输入，否则
   「本地好、发布坏」这类缺陷无法在 PR 阶段发现。

⑤ **共享基建 + 数据隔离。**
   上游与 Meka 复用同一套协议包、同一套 parser、同一套市场服务形态（已成立：
   [`protocol-and-submodules.md:36,46-49`](protocol-and-submodules.md)、
   `plugin-security-and-authoring.md:516-526`）；但**数据域不交叉**：release 命名空间、账本、
   来源记录、投影输入、遥测各自归属本 edition，Meka 的数据不写进上游数据域，反之亦然
   （现有账本隔离见 `plugin-security-and-authoring.md:666-670`；本地账本落点见
   `apps/desktop/src/main/plugin-market/registerIpc.ts:56-69`）。

⑥ **增量演进、对未知 fail closed。**
   已发布 `schemaVersion` 的字段语义只增不改；新增能力对旧宿主 fail closed，不静默降级
   （[`protocol-and-submodules.md:28-29`](protocol-and-submodules.md)；
   `plugin-security-and-authoring.md:686-691`）。`delivery.ts:290-324` 是白名单解析、
   **不拒绝未知字段**，因此响应侧加字段对旧客户端安全。

---

## 3. 目标契约

### 3.1 术语与身份轴（先把词对齐）

| 术语 | 含义 | 现状锚点 |
|---|---|---|
| **edition** | 一次插件分发所属的产品版本空间，值为 `cindy` \| `meka` | 无显式声明（本 RFC 引入） |
| **venue（分发源）** | edition 对应的市场端点与凭证来源 | `cindy`：endpoint manifest 的 `pluginApiBaseUrl`（`config/endpoint.json:17`）；`meka`：用户配置的 MCPRouter origin + client key（`apps/desktop/src/main/meka-settings/routerService.ts:1015-1036`） |
| **surface** | Renderer 页面选路用的渠道键 | 代码枚举实际是 `'plugins' \| 'meka'`，见 `apps/desktop/src/renderer/features/plugin/lib/pluginMarketSurface.ts:7`；页面入口 `apps/desktop/src/renderer/router.tsx:117,201` |
| **version space** | 版本线标识：`cindy`（上游线，`0.1.x`…）／`cindy-meka`（Meka 线，`0.0.x`） | `packages/maker-shared/src/brandIdentity.ts:137-172` 的 `cdnPrefix: 'cindy-meka'` 是同源命名习惯 |
| **identityKind** | 客户端身份种类：`versioned` \| `unversioned` | `apps/desktop/src/main/updateService.ts:1435`（`isVersionlessAppVersion`）、`package-lib.mjs:14` |

> **口径修正（需评审确认）**：需求描述里的 `surface/channel` 枚举 `cindy|meka` 与代码
> 不完全一致——Renderer 的 surface 字面量是 `'plugins' | 'meka'`
> （`pluginMarketSurface.ts:7`），本地 `.cindy` 安装的渠道归属是 `channel: 'meka'`
> （`plugin-security-and-authoring.md:661-664`），IPC 前缀是 `meka-plugin-market:*`
> （`apps/desktop/src/shared/pluginMarket.ts:64`）。本 RFC 统一以 **edition**
> （`cindy` \| `meka`）为唯一新增轴，并要求声明工件**显式映射**到上述既有枚举，不再新增
> 第三套拼写。

### 3.2 Meka 侧：分发来源如何声明

新增一个**仓内、受 Git 管理、纯数据**的声明工件（单点），供应 source 决定"去哪、以什么
身份、进哪个数据域"：

`config/plugin-distribution.json`（新文件；`schemaVersion: 1`）

```json
{
  "schemaVersion": 1,
  "editions": {
    "cindy": {
      "surface": "plugins",
      "versionSpace": "cindy",
      "venue": { "kind": "endpoint-manifest", "endpointKey": "pluginApiBaseUrl",
                 "credential": "desktop-session" },
      "identity": { "header": "x-cindy-version", "source": "app.getVersion()" },
      "projectionOwner": "upstream-plugin-server",
      "dataDomain": "cindy"
    },
    "meka": {
      "surface": "meka",
      "versionSpace": "cindy-meka",
      "venue": { "kind": "mcpr-registry", "source": "meka-settings.routerUrl",
                 "credential": "meka-settings.clientKey" },
      "identity": { "header": "x-cindy-version", "source": "app.getVersion()" },
      "projectionOwner": "mcpr-registry",
      "dataDomain": "cindy-meka"
    }
  }
}
```

约束（都要有门禁，见 §5.2）：

- **只引用键名，不写字面地址**：真实运行期地址只允许出现在 `config/endpoint*.json`
  （既有门禁口径见 `scripts/check-endpoint-literals.mjs:25-39`）。工件里出现 URL 字面量
  即违规。
- **`edition` 集合必须与代码枚举全覆盖**：`pluginMarketSurface.ts:7` 的每个 surface
  字面量、以及 `meka-plugin-market:*` / `plugin-market:*` 两组 IPC 前缀，都必须在工件里
  有且只有一个归属。
- **`dataDomain` 必须与账本落点一致**：`cindy` → `plugin-market/ledger.v1.json`，
  `meka` → `plugin-market/meka-ledger.v1.json`（`registerIpc.ts:56-69`、
  `plugin-security-and-authoring.md:666-670`）。
- **本工件是唯一事实源**：`service.ts:645-666` 与 `registerIpc.ts:48-69` 的构造必须从它
  派生，不得各处自行硬编码常量或文件名。

### 3.3 下限如何声明：方案对比与选定

| | 方案 A：manifest 加 per-edition 下限字段 | 方案 B：新增请求头／兼容基线维度（**选定**） | 方案 C（对照，拒绝） |
|---|---|---|---|
| 形态 | v3 顶层新增 `minVersionBySpace: { "cindy"?: "0.1.61", "meka"?: "0.0.31" }`；v3 的"必须声明 `minCindyVersion`"（`manifest.ts:1264-1266`）放宽为"至少一个空间有下限" | 客户端请求显式带空间：`x-cindy-plugin-space: cindy\|meka`（缺省=`cindy`）；`x-cindy-version` 的数值解释为**该空间内**的客户端版本。释放列表再下发可选的 `compat` 元数据（`space` / `bound` / `reason`） | 把 Meka 版本换算成上游版本；或客户端按 `minCindyVersion` 二次筛选；或正式包发 `0.0.0` |
| 最小改动集（本仓） | `manifest.ts`（已知字段集合 + 校验 + v3 必填规则）、`apps/desktop/src/shared/ghost.ts` 镜像、`forge.ts` FORGE_GUIDE、`ghost.ts:2433-2468` 脚手架、全部 v3 fixture | `delivery.ts:44` 头常量；`plugin-market/api.ts:64-91,167-176` 一处 requestOptions；`config/plugin-distribution.json` | 无需改动（正因如此才危险） |
| 最小改动集（服务端） | 必须解析新字段并同时按两空间投影 | 必须按 space 分区投影（**本来就必须做**，见 §3.5） | 无 |
| 兼容性 | 顶层未知字段在 v3 下原样保留、不展示不授权不拦装（`plugin-security-and-authoring.md:686-691`）⇒ 旧客户端安全；但**旧服务端会忽略它**，在服务端升级前不解决任何问题；`minCindyVersion` 必填规则一改就是已发布 v3 语义变更，需双端同时上线 | 头是纯增量：旧服务端忽略新头 = 现行行为；旧客户端不发新头 ⇒ 服务端按缺省 `cindy` 处理 = 现行行为。`delivery.ts:290-324` 的增量容忍保证响应加字段安全 | 违反 §3.6 红线与核心不变量 |
| 作者负担 | 每个上游作者都要产出 Meka 视角的值（**不可接受**：上游作者没有 Meka 版本概念） | 作者零改动；Meka 侧由发布流程按"实际引入能力"推导 | — |
| 结论 | **不作为主路径**；仅当"同一 release 必须同时服务两个空间"成为现实需求时，作为 B 的**最小补充**启用，且必须由发布侧自动推导，禁止作者手填 | **选定**：缺的输入是"这次比较在哪个空间"，它属于**客户端身份**，不属于插件元数据；把它放在请求侧同时满足最小改动、双端可分阶段升级、数据隔离可落地（服务端按 space 分区） | **明确拒绝** |

**为什么选定 B（一句话）**：缺陷的缺失输入是**空间**，而空间是客户端/请求的属性；
把它写进 manifest 会让每个上游作者被迫理解 Meka 版本线，把问题从"契约缺失"变成
"作者负担 + 已发布 schema 语义变更"。

### 3.4 `minCindyVersion` 数值口径的最终定义

> **`minCindyVersion` 是空间内下限**：它的数值只能在「该 release **被发布到的 edition**
> 所对应的版本空间」里解释与比较；它回答"同一空间内，哪个正式版本起开始满足本插件的
> 依赖"，不回答"这是哪个产品的哪个版本"。

推论（实现与评审的判据）：

1. cindy-edition release 的 `minCindyVersion` = 上游 Cindy 线（**现状语义不变**，
   上游零改动）。
2. meka-edition release 的 `minCindyVersion` = **Cindy Meka 线**（`0.0.x`）。在 Meka
   生态里，它就是"Meka 从哪个版本起满足本插件依赖"。
3. 客户端版本只在**它声明（或被识别）所属的空间**内参与比较；跨空间比较必须 fail
   closed 为**不适用**（不是"满足"、也不是"不满足"），并产生 §3.5 的 reason。
4. `0.0.0` / `0.0.0-*` 的 `versionless` 语义**只对 dev／版本无关构建有效**，且必须在
   §3.2 工件里显式标注该身份的判定后果（现状 `manifest.ts:1131` 是无条件放行）。
   发布包的 `0.0.x` 永远是 `versioned`，与 versionless 不可混同。
5. **禁止**把 Meka 版本翻译成上游版本（或反向）来凑比较；任何"投影映射表"只能用于
   **上架决策**（决定 Meka 空间里该资产的下限填什么），不得成为运行期比较的输入。
6. 该字段仍是**发布／发现元数据**，不是客户端安装闸门（沿用
   [`plugin-security-and-authoring.md:153-160`](plugin-security-and-authoring.md)）。

**关于改名（决策：不改）**：把字段改成 `minHostVersion` 之类的"空间中性"名字在语义上
更干净，但（a）全仓零命中的新字段名 = 新增跨端契约，（b）已发布 `schemaVersion` 的字段
语义只增不改（`protocol-and-submodules.md:28-29`），（c）每次协议改动都要在上游同步时
重放（`protocol-and-submodules.md:18-29,79-80`）。口径问题用**空间声明**即可解决，不值得
付 fork 分歧成本。若上游未来主动改名，本仓跟随。

### 3.5 上游协同：服务端需要什么

服务端要做到"既服务上游客户端、又服务 Meka"，最少需要以下四件事（共享基建、数据隔离）：

1. **请求侧分辨空间**：接受 `x-cindy-plugin-space: cindy | meka`；**缺省（旧客户端）等价
   于 `cindy`**，且行为与今天逐字节一致。`x-cindy-version` 的值按该 space 解释。
2. **投影按空间分区，且不跨空间回退**：release 属于且仅属于一个 space；一个 space 的
   客户端永不收到另一个 space 的 release。跨空间"最近兼容版本"回退必须**不存在**——
   否则等于把 1.2 节的双向误用重新引回来。
3. **机器可读的未命中原因**：当没有兼容 release 时，服务端要能返回结构化 reason
   （例如区分 `space-mismatch` / `bound-unmet` / `identity-unresolved` / `no-release`），
   客户端据此产生可观测诊断（§2③）。响应侧是**纯增量字段**，旧客户端安全
   （`delivery.ts:290-324`）。
4. **数据隔离**：Meka 请求不得在上游数据域写入任何状态（发布记录、投影缓存、遥测、
   组织/个人来源记录等）；上游请求同样不得读 Meka 数据域。上游既有身份（组织 scope、
   `defaultInstall` 等）在 Meka 空间下要么显式等价存在，要么明确不可用，**不得靠
   venue 隐式继承**。

上游客户端侧的承诺保持不变：不新增筛选、不新增确认、下发即信任
（`plugin-security-and-authoring.md:153-160`）。

### 3.6 明确不做什么

| 不做 | 出处（明文不变量／红线） |
|---|---|
| 客户端按 `minCindyVersion` 二次筛选、跳过、弹兼容确认 | `plugin-security-and-authoring.md:156-158`；`forge.ts:1761-1763`；`help-knowledge/plugins.md:31-32`；锁定测试 `service.test.ts:1551-1566,1568-1595,1597+` |
| 正式包伪装成 versionless（把 `0.0.0` 当"无下限"用） | `manifest.ts:1087-1089` 与 `:1131` 的语义；打包侧已拒绝显式 `0.0.0` 作发布版本（`package-lib.mjs:195-197`）；Forge 脚手架也拒绝 `0.0.0`（`ghost.ts:2443-2451`） |
| 新增 `schemaVersion: 4` 或在运行期改写已发布 v2/v3 字段语义 | `protocol-and-submodules.md:28-29`；`plugin-security-and-authoring.md:686-691` |
| 按插件 ID、名称或服务端自报渠道**推断**空间 | 同形态的既有禁令：`plugin-security-and-authoring.md:496-499`（不得依据插件 ID／名称／服务端自报渠道推断渠道）；`plugin-security-and-authoring.md:516-526`（共享操作必须按 surface 选一次渠道） |
| 把兼容基线工件／映射表变成运行期比较输入 | §2② + 上表第一行；须有门禁证明它不被运行时 import（§5.2、§6.4） |
| 依赖打包期 assert 作为防线 | `apps/desktop/forge-meka-resources.ts:54-85` 只在本地 `electron-forge make` 跑，client-ci 无打包步骤（§5.3） |

---

## 4. 迁移与兼容

### 4.1 已安装用户（平滑，零动作）

- **不得触碰已安装插件的字节**：账本以原始 `ghost.json` 字节 SHA-256 为基线，存在但不
  匹配时必须 fail closed（`plugin-security-and-authoring.md:139-143`）。因此"批量改写已装
  manifest 的 `minCindyVersion`"这种迁移方案**直接违规**，本 RFC 排除。
- 已装插件不因投影变化被卸载；移除的唯一来源仍是市场 `removals` 通告
  （`api.ts:116-137` 的"在架优先"聚合规则）。`xd-sites` 在发布版缺席只影响"能否新装/
  能否更新"，不影响已装实例的可用性。
- 存量安装的 receipt backfill 必须无感（`plugin-security-and-authoring.md:682-685`），本
  设计不新增任何安装期确认。

### 4.2 已有插件的下限如何处理

- **cindy-edition 存量值原样保留**，语义不变；Meka 不再拿它和 Meka 版本比。
- **meka-edition 存量值（Forge 写出的 `0.0.x`）不迁移**：它本来就是 Meka 空间的数值，
  只是此前没有空间声明。工件落地后它自动获得正确解释。
- **已知资产要登记成证据表**（不是运行期输入）：至少 `xd-sites ≥ 1.0.11 @ cindy 0.1.61`
  与 `taptap-maker 2.1.15 @ cindy 0.1.64`，各自记录"Meka 空间里从哪个 `0.0.x` 起可用"及其
  **依据**（哪次 Meka 发布引入了它依赖的能力）。依据不足时必须走"移植能力"或"不上架"，
  **不得猜**。
- 占位纪律沿用 migration 的既有范式（"保留占位槽 + 内容哈希基线 + 冲突策略与门禁"，
  见 [`database-and-migrations.md:36-54`](database-and-migrations.md) 与
  `apps/desktop/scripts/lib/migration-freeze.mjs:19-52`）：**占位项必须显式登记，且不得让
  任何人把它误读为"能力已具备"**；登记表本身可像 baseline 一样冻结哈希，防事后静默改写。

### 4.3 上游同步时如何不重新长出旧行为

- 语义型回归抓不到结构性回归：`pnpm audit:merge` 与 diff 都拦不住"代码都在、语义被
  覆盖"（[`development-workflow.md`](development-workflow.md) 第 4 节口径）。本设计的防
  回归机制必须是**门禁 + 白名单登记**，不是文档提醒。
- 落地后必须按 [`meka-whitelist-verification.md`](meka-whitelist-verification.md) 登记新
  Meka 专属能力项（新增能力同一次交付登记，是 `AGENTS.md` 的硬性要求）。建议登记形态
  对齐 WL-4.1.6/4.1.7 的"不变量 + pin/常量 + 自动化门禁 + 实机验证"四段式
  （`meka-whitelist-verification.md:319-333`）。
- **fork 分歧成本必须显式记帐**：任何触碰 `packages/plugin-protocol` 的改动都是"上游
  同步时需重放"的债务（`protocol-and-submodules.md:18-29,79-80`；
  [`protocol-compatibility.md:70-79`](protocol-compatibility.md)）。本 RFC 因此把协议改动
  压到**一行头常量 + 可选响应字段**，并把 P1 全部留在本仓。

---

## 5. 落地拆分

### 5.1 P1（本仓；不改协议、不改配置语义，只加声明工件与门禁）

目标：**使 dev/release 的分发身份与版本空间可复现、可断言**，让 §1 这类缺陷在 PR 阶段
就红灯。

| # | 最小改动集 | 落点（`文件:行`） | 门禁落点 | 风险 |
|---|---|---|---|---|
| P1-1 | 新增声明工件 `config/plugin-distribution.json`（§3.2 形态） | 新文件，与 `config/endpoint.json` 同级 | 新 `scripts/__tests__/plugin-distribution-contract.test.mjs`，注册进根 `package.json` 的 `test:runner` 列表（CI 落点 `.github/workflows/ci.yml:63-64`；如需独立入口，加 `check:plugin-distribution` 到 `:84-85` 的 `check:*` 邻位） | 工件与实现漂移 → 由门禁反向读取源码枚举兜住 |
| P1-2 | 身份解析收口为纯函数 `resolvePluginClientIdentity({ edition, appVersion, versionless })` → `{ versionSpace, reportedVersion, identityKind }`，两渠道都用它 | `apps/desktop/src/main/plugin-market/api.ts:64-91`（`requestOptions`）、`:167-176`（`MekaPluginMarketApi`）；替代"各处自己传 getter" | desktop unit tier（`apps/desktop/vitest.config.ts:8-23` 自动收集）：`plugin-market/__tests__/api.test.ts` 补两条渠道的版本头与 identityKind 断言（现状 `api.test.ts:191-214` 只覆盖 endpoint/凭证） | 与 §5.4 的在途改动冲突 → 以收口后的单一入口合并，避免双份逻辑 |
| P1-3 | 渠道构造从工件派生（含 `dataDomain` → 账本文件） | `apps/desktop/src/main/plugin-market/registerIpc.ts:48-69`；`apps/desktop/src/main/plugin-market/service.ts:645-666` | 同上 tier；另可用源码级守卫（形态参考 `plugin-market/__tests__/ipcErrorBoundary.test.ts` 的源码断言）防"退回无参构造" | 误动上游渠道接线 → 现有 `api.test.ts:191-214` 保持绿即证明未牵动 |
| P1-4 | 可观测：`identity-unresolved` / `space-mismatch` / `bound-unmet` 三类 reason 进 snapshot 与日志 | `apps/desktop/src/shared/pluginMarket.ts`（snapshot 结构）；`apps/desktop/src/main/plugin-market/service.ts`（投影/对账）；`registerIpc.ts:330-346`（meka snapshot/detail） | 单测断言三类 reason 互不相同且不伴随成功语义；日志字段遵守 [`engineering-conventions.md`](engineering-conventions.md) | **UI 文案需产品裁决 + 术语表**（`i18n/GLOSSARY.md`、`pnpm check:i18n-glossary`）→ 未决 |
| P1-5 | 反向守卫：证明兼容基线工件**不被运行时消费**（防止它演化成客户端二次筛选） | 扫描 `apps/desktop/src/**` 的 import 图 | 新 `scripts/__tests__/plugin-distribution-contract.test.mjs` 内断言 | 断言过窄会误报 → 只钉"无运行时 import 路径" |
| P1-6 | 发布身份断言补齐（versioned / unversioned 两类产物） | `apps/desktop/scripts/ci/package-lib.mjs:190-218` 已就位 | `scripts/__tests__/meka-release-identity.test.mjs:15-40,73-80`、`meka-release-flow.test.mjs`（同一 `test:runner`） | 无 |
| P1-7 | dev 分发身份可复现：`XDT_PLUGIN_CLIENT_VERSION` 覆盖上报版本（仅 `!isPackaged`；非法值/哨兵 fail-loud） | `apps/desktop/src/main/plugin-market/clientIdentity.ts`（`applyDevPluginIdentityOverride` 纯函数 + `readPluginClientIdentity` 调用） | `plugin-market/__tests__/pluginDistributionContract.test.ts`（desktop unit tier，`pnpm test:unit` 必跑） | 覆盖只作用于上报值：不得演变成"改 `app.getVersion()`"或对打包构建生效 → 由"打包入参忽略覆盖"用例钉住 |

### 5.1.1 P1 实施现状（2026-09-23 更新；代码已落地在**未提交**工作区）

> 状态口径：本文件**仍是提议稿（proposed）**，下表记录的是"P1 相对本 RFC 已经实现到哪一步"，
> 不是"规则已生效"。§8 的索引／登记动作**一条都还没做**（获批后同一次交付再做，清单见 §8）。

| # | 项目 | 现状 | 落点 |
|---|---|---|---|
| P1-1 | 声明工件 | **已落地**：`config/plugin-distribution.json`（`schemaVersion: 1`），只引用键名、无地址字面量；默认终态按 **D1 方案 1**（每个 edition 单空间），并用 `fallbackVersionSpaces` 预留位表达**方案 2** 的过渡期双空间（不新增 schemaVersion） | 工件新增 `surface` / `ipcPrefix` / `versionSpace` / `fallbackVersionSpaces` / `venue` / `identity` / `projectionOwner` / `dataDomain` / `ledgerFile`，另有顶层 `versionlessPolicy` 显式声明"两个 space 都上报 `0.0.0` 是预期行为" |
| P1-2 | 身份解析收口 | **已落地**：新增单一真源 `apps/desktop/src/main/plugin-market/clientIdentity.ts`，导出 `resolvePluginClientIdentity({ edition, appVersion, versionless })`（纯函数）、`readPluginClientIdentity(edition)`、`pluginClientVersionReader(edition)`；`MekaPluginMarketApi` 的读取器改为**必填**（不再有"漏传 → `0.0.0`"路径）；`api.ts` 的头名改从协议常量取，不再留本地字面量。**当时不发** P2 的空间头（P2 就绪件已在同一工作区落地，但默认关闭，见 §5.5.1）：门禁钉住 `requestOptions()` 的**默认路径**只有 `x-cindy-version` | 两个渠道构造点：`registerIpc.ts` 的 `mekaService()` 与 `service.ts` 的 `PluginMarketService` 默认参数 |
| P1-3 | 渠道构造从工件派生 | **部分落地（形态调整，见下）**：`dataDomain` → 账本文件名在工件里声明，并与源码字面量对账；运行期**不** import 工件（原因见下） | 工件 `ledgerFile` 与 `service.ts` / `registerIpc.ts` 的 `ownerScopedUserDataPath(...)` 由门禁双向核对 |
| P1-4 | 可观测 reason（`identity-unresolved` / `space-mismatch` / `bound-unmet`） | **未落地**：依赖服务端返回结构化 reason（§3.5 第 3 条，仓外）与 D2 的产品裁决；P1 不做虚假承诺 | — |
| P1-5 | 反向守卫：工件不被运行期消费 | **已落地**：门禁断言 `apps/desktop/src/**` 运行期文件里没有引用工件路径的语句 | 与 P1-1 同一门禁文件 |
| P1-6 | 发布身份断言（versioned / unversioned 两类产物） | **已就位**：既有 `scripts/__tests__/meka-release-identity.test.mjs` / `meka-release-flow.test.mjs` 未改动 | 既有 `test:runner` |
| P1-7 | dev 分发身份可复现（原则④的最后一块） | **已落地**：新增 dev-only 环境变量 `XDT_PLUGIN_CLIENT_VERSION=<版本号>` 覆盖**上报给市场的版本**。生效范围：只在 `!app.isPackaged` 生效，打包构建无条件忽略（含非法值也忽略，不校验）；只改 `reportedVersion`/`identityKind`，不改 `app.getVersion()`、更新器、日志与 UI 版本显示。失败行为 **fail-loud**：非法形态（含空值）抛错并说明期望形态（`0.0.25` 这类）；versionless 哨兵（`0.0.0` / `0.0.0-*`）单独抛错并说明"传哨兵等于没开"。形态校验复用协议包 `isValidCindyVersion`，未自造正则。**可见后果（有意保留，非缺陷）**：打开该覆盖时，插件详情页显示的客户端版本仍是 `app.getVersion()` 原件，会**与上报给市场的版本不一致**——两者分工不同（页面回答"我在跑什么构建"，上报回答"该拿哪个兼容版本"），且发布形态下必然同源同值，只在本地诊断时分离；实现处的注释已按此口径写死（`GhostPluginDetailView.tsx` 的 `currentCindyVersion`） | `apps/desktop/src/main/plugin-market/clientIdentity.ts`：`applyDevPluginIdentityOverride({ appVersion, isPackaged, overrideRaw })` 纯函数（`readPluginClientIdentity` 调它）；用例补在 `plugin-market/__tests__/pluginDistributionContract.test.ts` |

**与 §5.1 表的三处偏差（已评审点，供裁决）**

1. **门禁落点**：§5.1 P1-1 建议 `scripts/__tests__/plugin-distribution-contract.test.mjs` 并挂根
   `test:runner`；实际落在 desktop unit tier 的
   `apps/desktop/src/main/plugin-market/__tests__/pluginDistributionContract.test.ts`（`vitest.config.ts`
   的 `desktopTestInclude` 自动收集，`pnpm test:unit` 必跑）。§5.3 把两者并列为合格落点，
   这样也不需要改根 `package.json`；若评审要求独立 `check:*` 入口，再补一层壳即可。
2. **P1-3 与 P1-5 在"运行期是否消费工件"上互相冲突**：P1-3 要求构造"从工件派生"，P1-5 要求
   "证明工件不被运行期消费"。本文按 §3.6（禁止把声明／基线类工件变成运行期输入）取 **P1-5 为准**，
   P1-3 以**最小可行替代**实现：运行期身份解析镜像在 `clientIdentity.ts`，工件是给人和门禁看的
   声明，两者由同一门禁双向绑定——漂移仍然红灯，但主进程 bundle 不依赖仓内 JSON 资产。
   若评审认为必须运行期 import 工件，则 P1-5 的断言要同步放宽，两件事必须一起裁决。
3. **工件字段比 §3.2 示例多**：`ipcPrefix` / `ledgerFile` / `fallbackVersionSpaces` /
   `versionlessPolicy` 是 §3.2 约束段（"IPC 前缀必须有归属""`dataDomain` 必须与账本落点一致"
   "显式标注 versionless 后果"）要求可门禁校验而必须落成字段的部分，`schemaVersion` 仍为 1。

**§6 验收标准现状**：①（身份可复现）、④（无客户端二次筛选 + 工件不在运行期 import 图上）、
⑤（守卫在 CI 里真的跑）、⑥（数据隔离／账本落点一致）已在新增门禁文件里有可执行覆盖；
②（两渠道身份不串台）由 `api.test.ts` 既有版本头断言覆盖（本次只把它的构造形态改成身份读取器，
断言未放宽）；⑦（发布身份不回退）沿用既有测试未改动；③（被门挡下有可见解释）**未覆盖**，属 P1-4。
① 中"dev 能复现**发布版判定输入**"这条原先只是"解析器一致"，由 P1-7 的
`XDT_PLUGIN_CLIENT_VERSION` 覆盖补齐（非打包 + 合法覆盖 ⇒ `versioned`；非打包 + 未设 ⇒ 行为不变；
打包 + 设了覆盖 ⇒ 忽略；非打包 + 非法值/哨兵 ⇒ 抛错；另有一条经 `vi.stubEnv` 的接线用例）。
本次交付的验证按「门禁留到交付时一次跑完」的口径只做了**单文件定向取证**（见 §5.6），
上表各"已落地"项在提交前仍需随完整门禁一起跑过。

### 5.2 P1 不包含什么

- 不改 `packages/plugin-protocol`（P2）。
- 不改服务端、不改任何线上数据。
- **不**新增客户端筛选、**不**改 `minCindyVersion` 的必填规则。P1 只让"当前行为"变得
  可声明、可断言、可解释；"站点在发布版恢复"属于 P2 + 上架动作，P1 不做虚假承诺。

### 5.3 门禁落点的现实边界（重要）

- client-ci **没有打包步骤**：`apps/desktop/forge-meka-resources.ts:54-85` 的两个 assert
  只在本地 `electron-forge make` 运行，**不能**当作 CI 防线。凡是必须在每次 PR 拦住的
  规则，都要落在 `test:runner`（`.github/workflows/ci.yml:63-64`）/ desktop unit tier
  （`vitest.config.ts`）上。
- 根 `check:*` 系列已被 CI 逐一执行（`.github/workflows/ci.yml:75-96` 区段），新增
  `check:plugin-distribution` 若确实需要独立 script 就挂在这里；否则优先并入
  `test:runner`（`package.json` 的 `test:runner` 列表，无需改 workflow）。
- `pnpm test:unit:related` 与 `pnpm test:unit` 的关系、门禁时机见
  [`development-workflow.md`](development-workflow.md)，本文不复制。

### 5.4 实现基线（本 RFC 与工作区改动的关系）

本文的 P1 各项与 P2 的**客户端就绪件**已在同一批未提交改动里落地（声明工件、身份收口、
dev 覆盖、space 头常量与默认关闭的发送路径、以及若干一致性门禁）。因此：

- 评审与后续实现请以**该批改动落地后**的代码为基线；§5.1 的"最小改动集"列是**原始计划**，
  **实施现状一律以 §5.1.1 与 §5.5.1 为准**（两节逐项标注已落地／部分落地／未落地）。
- §1.3-E1 对"Meka 渠道恒发 `0.0.0`"的取证指**修改前**的 HEAD 状态，用于解释缺陷成因；
  修改后的形态见 §5.1.1 的 P1-2 行与 `meka-whitelist-verification.md` WL-9 不变量 5。
- **仍未落地、且不得以客户端近似实现代替**的两项：**P1-4**（三类机器可读 reason——依赖仓外
  服务端返回 reason 与 D2 产品裁决）与 **P2 的服务端侧**（按 space 分区投影）；后者是"站点"
  在发布版真正恢复可见的前置条件。

### 5.5 P2（跨仓：协议 + 市场）

| # | 内容 | 落点 | 风险 |
|---|---|---|---|
| P2-1 | 新增 space 头常量（`x-cindy-plugin-space`，值 `cindy \| meka`，缺省 `cindy`）与可选响应 `compat` 元数据（`space`/`bound`/`reason`） | `packages/plugin-protocol/src/delivery.ts:44` 邻位；类型定义同文件 | 单端先行 = wire 漂移；必须双端同时改（`protocol-and-submodules.md:79-80`） |
| P2-2 | 服务端：按 space 分区 release 命名空间与投影；无兼容版本返回机器可读 reason；缺省头 = 现行行为 | 服务端仓（**仓外**，本仓不可验证） | 投影算法在仓外 → §7 未决 |
| P2-3 | 上架/复制流程：把 Meka 需要的上游资产（至少 `xd-sites`）在 Meka 空间登记，下限按 §4.2 的证据推导 | 发布/运营流程（**仓外**） | 责任人与资产清单未定 → §7 未决 |
| P2-4 | 上游协同确认：请上游确认 `minCindyVersion` 的"空间内下限"口径，并在服务端保留旧行为分支 | 跨团队沟通 | 上游若不接受 → 只能退到"自建镜像"路线，成本大幅上升 |

> **客户端就绪件现状**：P2-1 里**客户端侧可独立完成的那一半已落地、默认关闭**（协议常量 +
> 运行期开关 + 工件声明 + 双向绑定门禁），**不构成单端 wire 漂移**；逐项状态、翻开关前的
> 四项跨仓前置条件见 §5.5.1。

**终态形态（两选一，本 RFC 推荐形态 1）**

- **形态 1（推荐）**：Meka 构建的插件目录只面向 `meka` 空间；上游目录里 Meka 需要的资产
  由 Meka 侧发布流程在 Meka 空间重新登记。共享的是**基建与协议**，隔离的是**数据与版本
  空间**——与"基建尽可能公用、数据隔离"的裁决逐字对应。
- **形态 2（过渡）**：Meka 构建继续读 cindy 空间，服务端在同一目录下同时提供两个空间视角
  （需要 §3.3 方案 A 的补充字段）。仅在形态 1 短期不可行时启用，且必须由发布侧自动推导，
  不依赖上游作者手填。

#### 5.5.1 P2 客户端就绪件实施现状（2026-09-24 更新；代码已落地在**未提交**工作区）

> 状态口径同 §5.1.1：本文件**仍是提议稿（proposed）**。下表登记的是"P2-1 里**客户端侧能独立
> 完成的那一半**已经落到哪一步"，**不是**"空间头已启用"。**默认关闭**是本次的核心验收点：
> 常量与写头代码都在，但默认请求与今天逐字节相同，因此**不构成单端 wire 漂移**。

| # | 项目 | 现状 | 落点 |
|---|---|---|---|
| P2-1a | 协议常量（**默认不发送**） | **已落地**：`CINDY_PLUGIN_SPACE_HEADER = 'x-cindy-plugin-space'`，取值是两个 edition 空间名（`cindy` / `meka`），缺省（不发该头）等价于 `cindy`。纯增量导出：不动 `PLUGIN_API_SCHEMA_VERSION`、不动任何既有解析逻辑；注释写明它是**请求头**、**默认不发送**、服务端采纳后由客户端侧开关打开 | `packages/plugin-protocol/src/delivery.ts`（`CINDY_CLIENT_VERSION_HEADER` 邻位） |
| P2-1b | 运行期开关（**默认 false**） | **已落地**：`PLUGIN_SPACE_HEADER_ENABLED: boolean = false`——模块常量，**没有**环境变量／配置等运行期翻转入口（免得存在"某台机器上悄悄开始发头"的状态）。它是工件 `editions.*.identity.spaceHeader.enabled` 的运行期镜像（工件运行期不被 import，是 P1 既定设计）；取值入口 `pluginSpaceHeaderValue(edition)` 直接取身份解析的 `edition` 轴（`cindy` / `meka`），**不新造映射表**，也**不是** `versionSpace` 的 `cindy-meka` | `apps/desktop/src/main/plugin-market/clientIdentity.ts` |
| P2-1c | 发送路径（**默认不发**） | **已落地**：`requestOptions()` 仅在开关为 true 时附加该头（按渠道 edition：上游 `cindy`、Meka `meka`）；为 false 时那一支不执行，请求与今天**逐字节相同**（不新增任何头、也不改版本头）。渠道 edition 由 `PluginMarketApi#pluginEdition()` 给出（Meka 子类覆写），**没有改动** `service.ts` / `registerIpc.ts` 的构造点与版本身份读取器 | `apps/desktop/src/main/plugin-market/api.ts` |
| P2-1d | 声明工件 | **已落地**：`editions.*.identity.spaceHeader = { name: 'x-cindy-plugin-space', enabled: false }`；`name` 与协议常量、`enabled` 与运行期开关**双向绑定**（任一侧漂移即红灯）。顶部 `_comment` 已从"刻意不在此声明"改成"**已声明但默认关闭**，运行期由 `clientIdentity.ts` 的开关镜像" | `config/plugin-distribution.json` |
| P2-1e | 可选响应 `compat` 元数据（`space` / `bound` / `reason`） | **未落地**：响应侧字段属服务端（仓外），且与 P1-4 的可观测性一并依赖 D2 的产品裁决 | — |

**翻开关的前置条件（硬性，缺一不可）**——即 §3.5 的四项跨仓要求，全部在**仓外**，本仓无法
验证，也不得假设已完成：

1. **上游 plugin-server** 先部署能解析 `x-cindy-plugin-space` 的版本，且缺省（旧客户端不发该头）
   等价于 `cindy`、行为与今天逐字节一致；
2. **MCPRouter 侧**同样接受该头并按 space 分区 release 命名空间与投影；跨 space 的
   "最近兼容版本"回退必须不存在（否则等于把 §1.2 的双向误用引回来）；
3. 无兼容 release 时服务端返回机器可读 reason（`space-mismatch` / `bound-unmet` /
   `identity-unresolved` / `no-release`），否则客户端侧拿不到 §2③ 要求的可观测性；
4. 数据隔离：Meka 请求不得写上游数据域，上游请求不得读 Meka 数据域。

翻开关时必须**同一次交付**改两处并保持相等：`clientIdentity.ts` 的常量与工件
`spaceHeader.enabled`；门禁里"默认 false"的断言也要一并显式更新（这条摩擦是刻意的：单点改不动，
防静默开启）。**服务端未就绪就把开关打开 = 单端先行 wire 漂移**
（[`protocol-and-submodules.md`](protocol-and-submodules.md) 的修改准入），这正是本阶段选择
"常量先落、默认不发"的原因。

---

### 5.6 P1／P2 本次交付的验证现状（定向取证，不是门禁）

- **跑过**：`pnpm --dir apps/desktop exec vitest run src/main/plugin-market/__tests__/pluginDistributionContract.test.ts`
  → `18 passed`（2026-09-23，Windows 本机）。按仓库「门禁留到交付时一次跑完」的口径，这是
  **为确认自洽的定向取证**，不是提交前门禁。
- **跑过（P1-7 追加）**：同一命令 → `24 passed`（含新增的 6 条 dev 覆盖用例：非打包/打包 ×
  合法/未设/非法/哨兵 + 一条 `vi.stubEnv` 接线用例）。同样是**定向取证**，不是门禁。
  该开关的边界未止于此：**未跑**打包产物验证（打包路径忽略覆盖由纯函数 `isPackaged: true`
  入参断言，不依赖真实 Electron 与 make 产物）。
- **牙齿验证（断言能红灯）**：临时把工件 `editions.meka.versionSpace` 改成 `cindy`，同一文件
  2 条用例转红；随后按 SHA-256 校验还原（哈希一致）。证明这套守卫不是恒绿。
- **牙齿验证（P1-7 追加）**：临时把覆盖判定的打包早退去掉（`if (false && isPackaged) ...`），
  "打包 + 设了覆盖 ⇒ 忽略覆盖"这条转红（1 failed / 23 passed）；随后逐字还原并重跑，
  `24 passed`。证明"打包忽略覆盖"不是恒真断言。
- **跑过（P2 客户端就绪件追加，2026-09-24）**：
  `pnpm --dir apps/desktop exec vitest run src/main/plugin-market/__tests__/pluginDistributionContract.test.ts src/main/plugin-market/__tests__/api.test.ts`
  → `2 passed (2) / 46 passed (46)`（contract 27 条 + api 19 条）。同样是**定向取证**，不是门禁。
- **复跑（同一天，P1-5 反向守卫加固后）**：
  `pnpm --dir apps/desktop exec vitest run src/main/plugin-market/__tests__/pluginDistributionContract.test.ts`
  → `28 passed`（contract 27 → 28）。加固内容：扫描前先做**词法级去注释**（否则注释里用反引号提到
  工件文件名会被当成引用而误报）、引用判据纳入反引号（``import(`config/plugin-distribution.json`)``
  这类模板字面量不再漏判），并补了**三条自查**——分类器必须命中一条真实引用、去注释必须消掉
  文档式提及、语料规模必须 >100 个运行期文件。有这三条，"违规集合为空"才不可能是扫描器坏掉
  造成的恒真断言；同时新增一条哨兵形态用例（`0.0.0` / `0.0.0-dev` / `0.0.0-dev.1` / `0.0.0-local`
  在两个 edition 下都**原样透传**且 `identityKind = unversioned`，反面 `0.0.25-rc.1` 必须是
  `versioned`），钉住"客户端不做版本归一化"。
- **牙齿验证（P2 追加）**：临时把 `PLUGIN_SPACE_HEADER_ENABLED` 从 `false` 改成 `true`，同一命令
  → `3 failed / 43 passed`，红的正是三条"默认不发／双向绑定／默认 false"守卫
  （`api.test.ts` 的"默认请求头逐字节相同"、contract 的"工件 ↔ 运行期常量双向绑定"与
  "运行期开关是模块常量"）；随后按 SHA-256 校验还原（哈希与修改前一致 `9067ad76…`）并重跑
  → `46 passed`。这同时证明了两件事：① **默认路径真的不带空间头**（否则"逐字节相同"这条
  不会在开启时变红）；② 工件↔运行期双向绑定与"默认 false"两条守卫不是恒绿。
- **未跑**：`pnpm test:runner` / `pnpm test:unit` / `pnpm test:unit:related` / 任何 `check:*` /
  desktop typecheck / 打包；`ipcErrorBoundary.test.ts` 与 `packages/plugin-protocol` 的改动只做了
  源码级核对、未单独执行（协议包新增的是纯常量导出，未改任何既有解析逻辑）。提交前必须按开发
  流程一次性跑完整门禁。

### 5.7 提交前门禁的实跑结果（2026-09-24，Windows 本机）

| 门禁 | 结果 | 说明 |
|---|---|---|
| `pnpm test:unit:related` | **exit 1** | 见下「环境性失败」：在 runner 自检处即中止，**未进入 workspace 单测扫描** |
| `pnpm test:runner` | 669 tests：**660 pass / 2 fail / 7 skipped** | 两条失败均为环境性；本次新增的打包断言用例（asar 合成归档、`@electron/asar` 真实归档交叉校验、版本断言矩阵、`verifyPackagedAppVersion` 位置断言）在这 660 条内通过 |
| workspace unit 全量（`node scripts/test-workspaces.mjs --tier unit`） | **27 PASS / 1 FAIL / 6 SKIP** | 关键：**`apps/desktop unit` PASS（577.2s）**、`packages/plugin-protocol unit` PASS、`apps/mobile unit` PASS；唯一 FAIL 为环境性抖动（见下） |
| `pnpm --filter desktop run typecheck` | exit 0 | |
| `pnpm --filter @cindy/plugin-protocol run typecheck` | exit 0 | |
| `pnpm check:dev-docs` / `check:i18n` / `check:i18n-glossary` / `check:brand-terminology` / `check:endpoints` | 全部 exit 0 | i18n 为 10337 key × 5 语言一致 |

**两条环境性失败（均非本次 diff 引入，已在仓库外报告，未在本提交内修改）**

1. `test:runner` → `scripts/__tests__/hardcoded-color-audit.test.mjs:287` 与 `:405`。两处都用
   `spawnSync('bash', ['-e','-c', <ci.yml 里的聚合脚本>], {env:{...process.env, VERIFY_CHECKS_RESULT, LINUX_UNIT_SHARDS_RESULT}})`
   再断言退出码。本机 `bash` 解析到 `C:\Windows\system32\bash.exe`（WSL 启动器），Windows 环境变量
   **不进入** WSL 进程：实测在父进程设 `VERIFY_CHECKS_RESULT=success` 后，bash 内打印为空 ⇒
   全成功分支的聚合脚本仍非零退出 ⇒ 断言失败。该测试的输入（`.github/workflows/ci.yml`、
   `package.json`）本次 diff **未触碰**；CI 在 ubuntu 上是真 bash，不受影响。
   副效应：`test-workspaces.mjs` 在 runner 预检失败时直接 `return`（`scripts/test-workspaces.mjs:1079-1085`），
   因此 `test:unit:related` 不会跑到 workspace 单测；上表第三行是绕过该预检单独取的证据
   （预检仅在 `related` 模式下触发）。另：直调 `node scripts/test-workspaces.mjs` 时本机
   `npm_execpath` 指向 npm 的 CLI，会被 `resolvePnpmInvocation` 当成 pnpm 而把 `--dir` 交给 npm
   （报 `Unknown command: <abs path>`），需显式指向 `pnpm.cjs` 才能跑出真实结果——这是**本机环境**
   的坑，与本次改动无关。
2. workspace sweep → `packages/maker-pi-manager unit` 单条 `TEST_ASSERTION_FAILED`：
   `src/__tests__/session-registry.test.ts:910` 等 `child.kill` 被以 `'SIGKILL'` 调用，用例自身注释
   已记录该轮询上限由 500 提到 5000 的历史抖动。该包本次 diff **完全未触碰**（
   `git status --porcelain -- packages/maker-pi-manager` 为空），且不依赖 `plugin-protocol` / `desktop`，
   无传递路径；**单独重跑该文件 57/57 通过（545ms）**，判定为并行满载下的时序抖动。

> 口径说明：以上是**提交前门禁**的实跑记录，不是「CI 已绿」。本分支为直推集成分支
> （`meka/main`），权威门禁是推送后 `client-ci`（ubuntu）的 push 触发；上表两条环境性失败
> 在 ubuntu 上不复现。未跑：`electron-forge make` 真实打包、`test:all` 的 db／integration 等
> 更重 tier，以及任何 macOS／Linux 产物验证。

## 6. 验收标准

"修好"必须可执行判定，不接受"看起来正常"。

1. **身份可复现（对应原则④）**
   `resolvePluginClientIdentity` 的纯函数测试证明：给定 `{ edition, appVersion, versionless }`
   三元组，输出的 `{ versionSpace, reportedVersion, identityKind }` 唯一确定；同一解析器
   能分别复现发布包的 `versioned / 0.0.x / cindy-meka` 与源码包的
   `unversioned / 0.0.0 / cindy-meka`，**两者差异只体现在 identityKind 上**，且无需打包即可
   复现发布版判定输入。
   **现状（已落地）**：源码包的 `0.0.0` 身份是"最宽投影"（协议对 versionless 无条件放行），
   与发布版 `0.0.x` 的可被 `minCindyVersion` 挡住**不是同一个判定输入**，光靠上面这条
   三元组只能证明"解析器一致"，不能证明"dev 能拿到发布版的输入"。dev 下用
   `XDT_PLUGIN_CLIENT_VERSION=<真实 0.0.x>` 补齐（仅 `!app.isPackaged` 生效，非法值与
   versionless 哨兵 fail-loud 抛错，见 §5.1.1 P1-7）；覆盖用例断言覆盖后
   `reportedVersion` = 覆盖值且 `identityKind === 'versioned'`，未设覆盖时行为与 HEAD 一致。
2. **两渠道身份互不串台**
   `api.test.ts` 断言：Meka 渠道的 `x-cindy-version` 来自该 edition 的读取器、永不落到
   构造默认值、且不等于 `0.0.0`（发布包）；同一轮里 Cindy 渠道仍由自己的读取器决定。
   （HEAD 的 `api.test.ts:191-214` 只覆盖 endpoint/凭证；工作区在途改动已补上版本头断言，
   见 §5.4。）
3. **被门挡下有可见解释（对应原则③）**
   单测对 `space-mismatch` / `bound-unmet` / `identity-unresolved` 三种情形断言：产生互不
   相同的结构化 reason；**不产生任何成功语义的日志或 UI 状态**；`identity-unresolved`
   不静默等同于"兼容"。
4. **没有客户端二次筛选（对应 §3.6）**
   `service.test.ts:1551-1595` 等既有锁定测试保持绿；新增断言证明声明工件与兼容基线工件
   不出现在任何运行时模块的 import 图上。
5. **守卫在 CI 里真的跑**
   新门禁出现在 `pnpm test:runner`（或 CI 已执行的 `check:*`）中，且能在与实现不一致时
   红灯——不接受只写在文档里的规则（`docs/dev-rules/README.md:12` 的既有口径）。
6. **数据隔离**
   两渠道各自的账本文件、凭证来源、来源记录不交叉（`registerIpc.ts:56-69` +
   `api.test.ts:191-214`）；工件里 `dataDomain` 与账本落点一致。
7. **发布身份不回退**
   `meka-release-identity.test.mjs` 中 `cindy-meka-<x.y.z>` / `cindy-meka-unversioned` 两类
   身份断言通过。
8. **空间头就绪但默认不发（P2 客户端就绪件，对应原则⑥与 §3.6）**
   协议常量 `CINDY_PLUGIN_SPACE_HEADER` 与运行期开关 `PLUGIN_SPACE_HEADER_ENABLED`（默认
   `false`）已落地，但**默认请求与今天逐字节相同**：`api.test.ts` 断言两条渠道的 `headers`
   序列化后恰好等于 `{ 'x-cindy-version': … }`（多出任何一个头即红灯），并在模块图层面把开关
   置 true 后断言两条渠道各带自己 edition 的空间名（`cindy` / `meka`）；开关是模块常量，
   **没有运行期翻转入口**。工件 `identity.spaceHeader` 与运行期常量的**双向绑定**由
   `pluginDistributionContract.test.ts` 断言（`name` ↔ 协议常量、`enabled` ↔ 运行期开关），
   任一侧漂移即红灯；"默认 false"本身也被门禁钉住。
   **现状（已落地，默认关闭）**：见 §5.5.1；服务端（跨仓）采纳前不得翻开关。

---

## 7. 风险与未决项

**依赖仓外、本仓无法闭环的结论（必须标注，不得当已确认）**

- **U1 服务端投影算法**：`delivery.ts:125-127` 只描述"服务端为该客户端选择 Release"，
  具体投影规则在服务端仓。本 RFC 的 §3.5 是**需求**，不是对现状的断言。
- **U2 `cindy-meka-cicd` 的版本入参来源**：本仓只看到 `--version` 解析与 CDN baseline
  bump（`package-lib.mjs:186-205`），发布编排仓如何决定每次发布的版本号**未验证**。它决定
  "Meka 版本线是否长期停在 `0.0.x`"以及能否保证单调可比——本 RFC 的 `0.0.x` 口径依赖它。
- **U3 上游资产清单与责任人**：哪些上游插件（除 `xd-sites`）是 Meka 必须提供的、由谁负责
  在 Meka 空间登记（§5.5 P2-3）未定。
- **U4 账号/身份跨空间边界**：Meka 仍登录上游 auth 端点（`config/endpoint.json:3`），
  "数据隔离"在本 RFC 中只约束**插件分发数据域**；账号域是否共享需单独裁决。

**需人工裁决的点**

- **D1 终态形态 1 还是形态 2**（§5.5）：影响"站点"恢复路径与跨仓工作量。
- **D2 是否向用户暴露"被挡"的解释**：需要产品裁决 + 术语表登记；只做日志不算满足原则③
  的"可观测"上限，但 UI 文案有 i18n 成本。
- **D3 `surface` 枚举口径统一**（§3.1 的口径修正）：是把 Renderer 的 `'plugins'` 改名为
  `'cindy'`，还是让工件映射接受 `'plugins'`？本 RFC 倾向前者不动代码、只在工件里映射。
- **D4 是否启用方案 A 的补充字段**：取决于 D1。启用则需重新走协议准入
  （`protocol-and-submodules.md:23-25`，需用户对"修改协议"的明确确认）。
- **D5 基线登记表的冻结方式**：是否照 migration baseline 做成哈希冻结并进门禁；冻结则每
  次更新都要显式改基线（有成本，但防静默改写）。

**已识别但本次不修**

- §1.3-E2 的 `supportsCindyVersion(ghost.manifest.version, …)` 跨空间复用比较器
  （`apps/desktop/src/main/cindy-brain/index.ts:3792-3798`）：属存量实现习惯，不在本次
  交付范围；本 RFC 记入 §4.3 的防回归观察项，实施 P1-2 统一身份解析时应顺手评估是否
  换成插件空间的比较函数。

---

## 8. 获批后的登记动作（本次不执行）

本文件目前是提议稿。获批（或部分获批）后，需在**同一次交付**内完成索引与登记，否则规则
不可发现。

> **执行状态（2026-09-23）**：下列 5 条**全部未执行**。P1 代码已在未提交工作区落地（§5.1.1），
> 但按"获批前不改索引"的口径，`docs/dev-rules/README.md`、根 `AGENTS.md`、
> `meka-whitelist-verification.md`、migration 总账与 `plugin-security-and-authoring.md` 的正本
> 都保持原样；审批落地时这 5 条要与代码同一次交付完成。

1. `docs/dev-rules/README.md` 的「当前文档」补条目（并写明状态）。
2. 根 `AGENTS.md` 的规则索引补「读取时机」（改插件分发来源/版本兼容前必读）。
3. [`meka-whitelist-verification.md`](meka-whitelist-verification.md) 登记 Meka 专属能力项
   （形态对齐 WL-4.1.6/4.1.7 四段式）。
4. [`../migrations/xdmaker-meka-to-cindy.md`](../migrations/xdmaker-meka-to-cindy.md) 同步
   Meka 迁移/兼容状态。
5. 若含代码改动，按「文档同步」硬性要求同步 `plugin-security-and-authoring.md` 的插件
   分发段落与作者契约（`FORGE_GUIDE` 同步另有门禁，见该文件 §7）。
