# 协议兼容与 submodule

> **状态**：权威开发规则（authoritative）
> **读取时机**：修改协议包、修改插件分发来源边界、修改 device-link
> 协议／relay／隧道 payload／IPC allowlist，或任何改动客户端与服务端之间 wire protocol
> 的地方之前

协议包是客户端与服务端共享的 wire protocol 权威来源。**2026-09-10 起本仓不再使用
`cindy-protocol` submodule**：协议包改为上游的仓内 workspace（见
[`../migrations/2026-09-origin-main-to-meka-main.md`](../migrations/2026-09-origin-main-to-meka-main.md)
的 D1 决策）。协议不一致或单端改协议会让两端对不上，且这类不一致在本仓的
typecheck／单测里发现不了，只有真实连接时才暴露。device-link 的运行时约束另见
[`remote-and-mobile-adaptation.md`](remote-and-mobile-adaptation.md)，依赖安装见
[`environment-setup.md`](environment-setup.md)。

> **增量适用原则**：wire protocol 兼容对所有跨端改动生效，不因是小改而豁免。

## 修改准入（硬性要求）

- **非必要不得修改跨端 wire protocol。** 单客户端功能、临时兼容、本地开发便利或绕过
  parser／validator 均不自动构成修改共享协议的理由。应先核对上游是否已有对应能力，
  并优先采用不改变跨端契约的本地实现、现有协议能力或兼容路径。
- 确认现有协议无法表达需求时，代理也不得自行扩大协议。动手前必须向用户明确说明：
  为什么必须修改、已排除哪些替代方案、会影响哪些仓库与发布顺序，并取得用户针对
  **修改协议** 的明确确认；用户只同意修改 Cindy 或某项产品功能，不等于授权修改跨端协议。
- 协议修改必须形成可审查、可拉取的提交，再按本页的兼容和发布顺序更新消费方与服务端；
  不得把未上游化的本地脏状态当作 Cindy 功能实现的一部分交付。
- **已发布 schema 版本不重写**：`schemaVersion` 2 / 3 的既有字段语义、通道名与错误码
  只增不改；新增能力必须对不认识的旧宿主 fail closed，不能把它静默降级。

## 事实来源

| 内容 | 权威来源 |
|---|---|
| 协议权威源 | 仓内 workspace `packages/plugin-protocol`、`packages/slack-hook-protocol`、`packages/device-link-protocol`；历史 `cindy-protocol` submodule 已移除 |
| Meka 插件 manifest / delivery 协议 | `packages/plugin-protocol`（Cindy 与 Meka 共用一套 parser，靠渠道／来源／身份适配器表达差异） |
| desktop 消费的协议包 | `@cindy/slack-hook-protocol` |
| device-link relay 层定义 | `@cindy/device-link-protocol`；客户端重连、IPC allowlist、隧道 payload 在 `packages/device-link` |
| 插件来源 | 客户端不预装插件；一律通过 SkillHub 或用户手动安装 `.cindy` 包 |

## 1. 协议包是权威源

### 1.1 仓内 workspace 约定

- Desktop 的插件市场、插件包 manifest 与 Plugin Delivery parser 使用
  `@cindy/plugin-protocol`，来源是本仓 `packages/plugin-protocol`；不得在
  `apps/desktop/src/shared` 新增第二份协议实现。
- Meka 与上游共用同一套协议实现，产品差异通过渠道（`cindy` / `meka`）、来源与身份适配器
  表达，不复制两套 parser。
- Desktop 的同名本地文件若为历史 import 兼容层，只能 re-export 协议包，不能增加或覆盖
  route、slot、字段和错误码定义。
- **存量插件兼容是红线**：协议改动不得要求用户重新安装、重新确认权限或重新配置已装插件；
  旧 manifest 必须继续可解析。

### 1.2 修改顺序

1. 在 `packages/plugin-protocol` 修改协议源码、测试和协议文档；涉及 `mcpr` 时同步核对
   `docs/mcpr-plugin-capability-gateway.md` 与 Desktop Host 契约。
2. 运行 `pnpm --filter @cindy/plugin-protocol test` 与 typecheck，提交带 DCO 的 commit。
3. 运行 Desktop 定向测试和 typecheck，确认消费方未破坏兼容。
4. 服务端先部署能解析该协议的版本，再发布使用新字段或新 slot 的插件；旧客户端必须
   对不认识的能力 fail closed，不能把它静默降级成普通 slot。

### 1.3 市场协议排查

Meka 插件市场可以使用独立的 MCPRouter endpoint 和凭证，但仍复用同一个
`@cindy/plugin-protocol` list/detail/download parser。看到
`response.plugin.currentRelease.manifest 不合法` 且可用 slot 列表不含新 slot 时，按以下
顺序检查：

- `packages/plugin-protocol/src/manifest.ts` 的 `LEGACY_GHOST_SLOTS` / v3 声明字段是否
  包含该能力名；
- `pnpm-workspace.yaml` 是否仍把 `packages/*` 纳入 workspace（协议包不再来自 submodule）；
- Desktop 是否已重新构建，避免继续运行旧的 `.vite/build` 产物。

- 协议定义以 `packages/*-protocol` 为准；desktop 通过 `@cindy/slack-hook-protocol`
  消费，device-link 复用 `@cindy/device-link-protocol` 的 relay 层定义。客户端重连、IPC
  allowlist 与隧道 payload 留在 `packages/device-link`，不在客户端另造一套协议。
- **任何改动都必须与服务端同步升级**，避免两端 wire protocol 漂移。协议是
  跨仓契约，单端先行会让线上连接对不上。

## 2. 插件来源

- 客户端不包含内建插件种子 submodule，不在安装包中预置插件，启动期也没有播种
  （provisioning）逻辑——预装机制已整体移除（2026-07）。
- 插件运行时保留，用户通过 SkillHub 或手动安装 `.cindy` 包；没有任何插件时启动和
  开发不应因此失败。
- 不要重新引入预装／播种机制或私有种子 submodule；需要推荐插件时走 SkillHub 的
  分发与安装确认流程。

## Review 清单

1. 是否真的必须修改共享协议，且已核对上游能力并排除不改协议的实现？
2. 是否已向用户说明必要性、替代方案与跨仓影响，并取得修改协议的明确确认？
3. 是否保持了已发布 `schemaVersion` 的字段语义、通道名与错误码向后兼容？
4. 改动是否触及跨端 wire protocol？是否要同步服务端？
5. 是否确认了服务端同步升级、不会造成协议漂移？
6. 客户端是否在 `packages/device-link` 之外另造了协议或绕过 relay 层定义？
7. 插件能力是否通过 `.cindy` 包和 SkillHub／手动安装分发，而不是重新引入预装／播种
   机制、私有种子 submodule 或绕过插件权限边界？

协议改动按 [`desktop-development.md`](desktop-development.md) 跑相关测试，并与服务端确认
兼容；依赖与 workspace 结构见 [`environment-setup.md`](environment-setup.md)。
