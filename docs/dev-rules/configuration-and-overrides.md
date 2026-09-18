# 配置分层与 override 契约

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改 Settings UI、配置文件、本地偏好存储、运行时 profile，或
> agent／MCP／provider 相关开关之前

本规则适用于所有用户可配置项。Cindy 允许用户高度定制，但**默认配置承载创作者品味，
是产品体验的一部分**——不是让每个选项都堆进设置页。产品边界见
[`../product-rules/core-product-principles.md`](../product-rules/core-product-principles.md)；
进入 Settings UI 的配置还必须遵守
[`../design-rules/cindy-design-system.md`](../design-rules/cindy-design-system.md)（主题
token）与 [`engineering-conventions.md`](engineering-conventions.md)（i18n）。

> **增量适用原则**：约束新增和正在修改的配置项，不要求为统一形式专项重构存量配置。

## 1. 可见性分层

新增／修改任何可配置项前，先判断它属于常规设置、高级设置、隐藏配置还是内部常量；不要
因为技术上能配置就放进 Settings 外层。

- 只有大多数用户经常需要理解并调整、且无需理解内部实现的选项，才默认可见。
- 低频、专业或误改成本高的选项进入高级设置。
- 有定制价值但不值得占用 UI 注意力的选项进入配置文件、本地配置存储，或由 agent 通过
  自然语言修改。
- 涉及产品语义、安全边界、数据契约或核心体验的不变量保留为内部常量。

## 2. 默认值与用户 override 分离

- 每个配置项都必须能判断是否被用户显式自定义。
- 运行时以「系统默认值 + 用户 override」合并出有效值；持久化只记录 override 与必要的
  自定义标记，**不把完整默认配置复制进用户配置**。
- 未自定义的用户随版本获得新默认值，已自定义的用户保留自己的选择。

模型资料的系统层再区分公共默认、供应商默认、供应商实报与服务端明确修正；用户覆盖始终最高。
发现快照和用户字段分开持久化，详见 [模型资料优先级](../product-rules/model-metadata-precedence.md)。

<a id="模型可见性2026-09-13-用户更正"></a>

### 模型可见性

显示开关的有效值是 **用户显式 override ?? 当前目录 defaultEnabled**。此条只约束模型显示开关。

- 目录下发哪些默认开、哪些默认关，没拨过开关的路线一律跟随。目录后来新增的默认开模型
  要显示出来；客户端不得把「没有开关记录」做成全关。
- 用户手动开过或关过的写成 override，升级不清、不覆盖。
- 「恢复默认」只删除本次点名路线的 override，重新跟随当前目录。
- 收藏、历史选择、引擎偏好不能当成开关。
- 桌面、IM 与远端用同一套 override；没 override 的路线由各端按当时目录 defaultEnabled 计算。

实现核对须区分上游原始目录与执行端活动目录：当前仍有客户端精简陈列投影，见
[已知实现差异](model-catalog-maintenance.md#visibility)。该说明不是对本节合同的豁免；
不得仅因代码仍在筛选就反向修改产品规则，也不能未验证便声称两者已一致。

**Meka 谱系条款（2026-09-10 上游同步定稿；2026-09-18 同步按用户裁决 A 修订）**：初始化资格由
Main 按**该 owner 的库文件 / 迁移标记是否存在**判定（库已在 ⇒ `existing`），只有判成 `new`
的配置才会拿到初始化清单。
Meka 谱系在本轮同步之前完全没有这套机制（`eligibleForDefaults` / `INITIALIZATION_KEY_PREFIX`
/ `profileOrigin` 在合并前的 `meka/main` 中出现 0 次），所以**没有任何既有 Meka 配置可能持有
清单**，整个存量用户群都会落到「无清单」分支（**当时**上游读取侧把「无清单」当作关闭；
2026-09-18 同步后该分支改为跟随目录，见下与 WL-10）。注意这与库名前缀无关：
`ownerDatabasePath` 两端使用同一个 `dbFilePrefix`，上游同形态的老配置同样被判成 `existing`。
合并前 Meka 的
可见性口径是「显式 override 优先，否则跟随目录 `defaultEnabled`」，老用户不需要任何初始化
记录就能看到模型 —— 这正是 2026-09-18 同步后重新生效的最终口径。

- 因此 `state/modelVisibilityPrefs.ts` 对「没有任何有效初始化清单」的老配置(资格位不为真
  且 `defaults` 为空，含被该机制跑过一遍写下的空清单)**补种一次快照**：按首次观察到的
  目录冻结 `defaultEnabled !== false` 的基线，并落下一次性标记。**2026-09-18 同步后该快照
  只作基线留痕**（记录这份老配置升级时看到过什么，并作为「已初始化过」的判定输入），
  **不决定可见性** —— 见下条与 WL-10。
- 补种不得跨越：显式 override 永远最高优先；「恢复默认」的具名路线(`followCatalogKeys`)
  继续动态跟随目录；`pending`(Main 尚未定性)不得猜测，定性缺失时失败关闭。
  > **已修订（2026-09-18 同步，用户裁决 A = 接纳上游语义）**：原表述「补种后新增模型不随
  > 目录默认开启」**不再成立**。现行有效语义是 [`模型可见性`](#模型可见性2026-09-13-用户更正)
  > 那条的通用口径 —— 可见性恒为 `override ?? 当前目录 defaultEnabled`，初始化清单
  > `defaults` **不参与可见性判定**，所以目录后来新增的默认开模型会直接显示。**兼容边界**：
  > 该语义逐字等于 Meka 上一轮同步**之前**的原生口径
  > （`override ?? isModelVisible(undefined, model.defaultEnabled)`），所以不变量「存量
  > Meka 用户升级后仍能看到合并前的可见集合」仍由目录原生满足，上一轮那起「选择器整张
  > 清空」的 P0 不会复现；被取代的只是**上一轮为补上该语义打的冻结补丁**，不是 Meka 的
  > 产品分歧。显式 override 的跨升级保留、`followCatalogKeys` 的跟随语义、`pending` 的
  > 失败关闭三者都不变。
- 该机制只存在于客户端 renderer；Server 目录不下发也不覆盖它。调整目录 `defaultEnabled` 时
  按 `docs/dev-rules/model-catalog-maintenance.md` 先确认实际下发目录与数据归属 —— 已补种的
  老配置与其它未自定义路线一样**跟随**目录改动（不存在「老配置被冻结在升级那一刻」这回事）；
  只有**显式 override** 不跟随。
- override 表或初始化清单一旦变化必须**重新镜像给 main**：`mirrorToMain` 推的是
  `effectiveMap(map) => ({ ...map })`（**override 表**；`defaults` **不进**载荷）加上
  **不含 `fallback: false`** 的策略。main 侧 `getModelVisibilityOverride` 在非 strict 下对
  未知 key 返回 `undefined`，由共享 `isModelVisible` 回落目录 `defaultEnabled`
  ⇒ IM `/model` 与应用内列表同口径，且不会因「没有镜像记录」整张清空。只有本地 override 表
  无法解析时才推 `fallback: false`（失败关闭）。`load()` 在 cache 置非空后不再触发镜像，
  所以补种/首次初始化之后必须显式重推一次；若改成把 `defaults` 塞进载荷或请求
  `fallback: false`，就会退回上一轮同步报告 §4.6 那起 P0 的「无记录 ⇒ 整张清空」形态。

## 3. 默认值演进与迁移

- 默认值变化时，分别说明新用户、未自定义老用户、已自定义老用户的行为。
- 迁移必须基于「是否自定义」的状态判断，**不得通过旧值猜测用户意图**；只有历史数据缺少
  自定义状态时才允许一次性兼容迁移，并在代码或 PR 中说明判断依据与风险。

## 4. 恢复默认

- Settings 中「恢复默认」的语义是**删除对应 override、重新跟随当前版本默认值**，而不是
  写入一份静态默认值快照。配置组与整体设置页应提供相应粒度的恢复入口。
- 用户通过 agent 要求恢复默认时同样删除 override。

## 5. 隐藏配置也是正式契约

- 隐藏配置必须有清晰 schema、字段说明、取值约束和安全边界，不能依赖零散分支或隐式
  约定。
- agent 修改配置时，只有用户明确要求才写入 override，不得把当前默认值固化回用户配置。

## Review 清单

1. 新配置的可见性层级选对了吗？是否因“技术上能配”就塞进了设置页外层？
2. 有效值是否由「默认 + override」合并？持久化是否只存 override 而非完整默认？
3. 默认值变化的迁移是否基于「是否自定义」，而非用旧值猜意图？
4. 「恢复默认」是否删 override 跟随版本，而不是写静态快照？
5. 隐藏配置是否有正式 schema 与安全边界？agent 是否只在用户明确要求时写 override？

实现／PR 说明至少写明：配置层级、默认值及推荐理由、override 如何记录与识别、未自定义
用户如何跟随新默认、恢复默认会清除什么。
