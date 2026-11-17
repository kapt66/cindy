// 设置页签的唯一真源已上移到 `@cindy/maker-shared/settings-tabs`（上游第八轮：
// 由 `lizi-mcps` 的 `get_settings_link` 与桌面设置页共用同一张表）。Meka 的
// `meka-assistant` 页签登记在那张表里（位次：providers → meka-assistant → billing，
// WL-1.1），本文件只做透传，不再保留第二份清单。
export * from '@cindy/maker-shared/settings-tabs';
