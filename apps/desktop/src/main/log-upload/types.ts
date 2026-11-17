/**
 * 日志采集/脱敏模块的内部类型。刻意与 `shared/logUpload.ts`（跨进程契约）分开：
 * 这里的形状只在 main 内部流转，改动不影响 preload / renderer。
 *
 * WL-26：Meka 不启用客户端日志上报。上报目标与上传元数据形状（原 `LogUploadTarget` /
 * `LogUploadMeta`）已随上报面删除；本文件只保留「报告问题」采集与脱敏仍在用的记录形状。
 */

/**
 * 一条采集记录的**最终形状**（第四层字段白名单的产物）。
 *
 * 只有这五个字段进入采集结果。解析出的其它字段（NDJSON 的 `tz` / `seq` / `sessionId`，
 * 未来新增的任何字段）一律丢弃——白名单是正向的，不是「排除已知危险字段」。
 * WL-26 之后这条形状只在本地「报告问题」诊断里使用，不再有上报出口。
 */
export interface UploadRecord {
  /** 原始时间戳（本地 ISO + offset）。不能用读取时刻覆盖，否则崩溃时间线失真。 */
  ts: string;
  level: string;
  /** 记录来自哪条本地流。`main` = main-*.log，`proxy` = agent-*.ndjson 的 proxy 源。 */
  src: 'main' | 'proxy';
  scope: string;
  msg: string;
}

/** 一条记录在裁剪前的中间形态：多带一个用于锚点打分的 epoch ms。 */
export interface ParsedRecord extends UploadRecord {
  tsMs: number;
}

/** 采集统计，只进本机日志，用于观察体量分布（需求 §4.6）。 */
export interface CollectStats {
  filesRead: number;
  bytesRead: number;
  linesScanned: number;
  /** 通过全部四层后保留的条数。 */
  kept: number;
  /** 被来源白名单挡掉的条数。 */
  droppedBySource: number;
  /** 因条数上限被锚点裁剪掉的条数。 */
  droppedByCap: number;
  /**
   * 因「不是转义版本写的」被整份跳过的 main 文件数（见 `startsWithFormatSentinel`）。
   * 单独计数是为了让「升级当天采到 0 条」在本机日志里能一眼归因，而不是查半天读窗口。
   */
  filesSkippedLegacyFormat: number;
  /**
   * 解析中途命中「未转义续行」而提前停止的 main 文件数（回滚场景：新版本建文件、旧版本
   * 同日追加未转义内容）。用于观察这类污染的发生频次。
   */
  mainFilesStoppedAtViolation: number;
  /** 实际回溯的天数。 */
  lookbackDays: number;
}

export interface CollectResult {
  records: UploadRecord[];
  stats: CollectStats;
  /**
   * 崩溃锚点里**其读取窗口确已覆盖**的那些（epoch ms 子集）。WL-26：Meka 不上报，
   * 该字段只描述采集窗口的覆盖情况，保留形状以兼容仍以 anchors 调用采集的本地诊断入口
   * （「报告问题」传空数组，不依赖它）。
   */
  coveredAnchors: number[];
}

