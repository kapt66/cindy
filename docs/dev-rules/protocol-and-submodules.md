# 协议兼容与 submodule

> **状态**：权威开发规则（authoritative）
> **读取时机**：升级 `cindy-protocol`、修改插件分发来源边界、修改 device-link
> 协议／relay／隧道 payload／IPC allowlist，或任何改动客户端与服务端之间 wire protocol
> 的地方之前

`cindy-protocol` 是客户端与服务端共享的 wire protocol 权威来源。submodule 指针漂移或
单端改协议会让两端不一致，且这类不一致在本仓的 typecheck／单测里发现不了，只有真实
连接时才暴露。device-link 的运行时约束另见
[`remote-and-mobile-adaptation.md`](remote-and-mobile-adaptation.md)，submodule 初始化命令见
[`environment-setup.md`](environment-setup.md)。

> **增量适用原则**：wire protocol 兼容对所有跨端改动生效，不因是小改而豁免。

## 修改准入（硬性要求）

- **非必要不得修改 `cindy-protocol`。** 单客户端功能、临时兼容、本地开发便利或绕过
  parser／validator 均不自动构成修改共享协议的理由。应先核对上游是否已有对应能力，
  并优先采用不改变跨端契约的本地实现、现有协议能力或兼容路径。
- 确认现有协议无法表达需求时，代理也不得自行修改协议子仓。动手前必须向用户明确说明：
  为什么必须修改、已排除哪些替代方案、会影响哪些仓库与发布顺序，并取得用户针对
  **修改协议子仓** 的明确确认；用户只同意修改 Cindy 或某项产品功能，不等于授权修改
  协议子仓。
- 获得确认后、对子仓产生任何写入前，必须执行
  `git -C cindy-protocol remote get-url origin` 核对来源。`origin` 必须是官方上游
  `https://github.com/makecindy/cindy-protocol.git`；若不是，先执行
  `git -C cindy-protocol remote set-url origin https://github.com/makecindy/cindy-protocol.git`
  纠正，再从上游拉取并核对目标能力与基线。不得基于私有 fork、临时 remote 或仅本地
  commit 修改并推进父仓 gitlink。
- 协议修改必须在协议上游形成可审查、可拉取的提交，再按本页的兼容和发布顺序更新消费方
  与父仓 submodule 指针；不得把未上游化的脏子仓状态当作 Cindy 功能实现的一部分交付。

## 事实来源

| 内容 | 权威来源 |
|---|---|
| 协议权威源 | 根 submodule `cindy-protocol`（`github.com/makecindy/cindy-protocol`） |
| desktop 消费的协议包 | `@cindy/slack-hook-protocol` |
| device-link relay 层定义 | `@cindy/device-link-protocol`；客户端重连、IPC allowlist、隧道 payload 在 `packages/device-link` |
| 插件来源 | 客户端不预装插件；一律通过 SkillHub 或用户手动安装 `.cindy` 包 |

## 1. `cindy-protocol` 是协议权威源

- 协议定义以 `cindy-protocol` submodule 为准；desktop 通过 `@cindy/slack-hook-protocol`
  消费，device-link 复用 `@cindy/device-link-protocol` 的 relay 层定义。客户端重连、IPC
  allowlist 与隧道 payload 留在 `packages/device-link`，不在客户端另造一套协议。
- `makecindy/cindy-protocol` 以新历史公开；父仓锁定的 submodule commit 必须始终
  可从公开仓拉取——合入协议仓 `main`，或打 `client-baseline-<sha>` tag，不允许只
  停在 feature 分支上（分支删除会让 gitlink 失效）。当前锁定的 `4468730` 已在协议
  仓 `main` 上；历史 tag `client-baseline-436a45f` 仍可能被旧 checkout 依赖，不要
  删除。
- **升级 submodule 指针前必须确认服务端同步升级**，避免两端 wire protocol 漂移。协议是
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
2. 是否已向用户说明必要性、替代方案与跨仓影响，并取得修改协议子仓的明确确认？
3. 子仓 `origin` 是否已核对或纠正为 `https://github.com/makecindy/cindy-protocol.git`？
4. 改动是否触及跨端 wire protocol？是否要同步 `cindy-protocol` 与服务端？
5. 升级 submodule 指针时，是否确认了服务端同步、不会造成协议漂移？
6. 客户端是否在 `packages/device-link` 之外另造了协议或绕过 relay 层定义？
7. 插件能力是否通过 `.cindy` 包和 SkillHub／手动安装分发，而不是重新引入预装／播种
   机制、私有种子 submodule 或绕过插件权限边界？

协议改动按 [`desktop-development.md`](desktop-development.md) 跑相关测试，并与服务端确认
兼容；submodule 相关操作见 [`environment-setup.md`](environment-setup.md)。
