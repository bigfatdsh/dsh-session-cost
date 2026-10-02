/**
 * 计价内核：DeepSeek 官方价目表、峰谷时段判定、以及 token → 金额的整数换算。
 *
 * 本模块是纯函数集合，**不 import 任何外部包**：profile 侧插件是以符号链接
 * 挂进 `~/.dsh/profiles/<profile>/node_modules/` 的，Node 会按真实路径解析依赖，
 * 因此 `@deepseek-ai/*`（只存在于 app.asar 内）和 `zod` 都可能在运行时解析不到。
 * 计价是插件的正确性核心，不能依赖这样的运气。
 *
 * ## 金额单位：微元（micros）
 *
 * 价格是「元 / 百万 token」，所以
 *
 *     微元 = token × 单价     （因为 微元/1e6 元 = token/1e6 × 单价）
 *
 * 即 1M token 命中缓存按 0.02 元/百万计价 = 20000 微元 = 0.02 元。
 * 全程用整数累加，避免浮点在成百上千次累加后的漂移，也让投影的 wire schema
 * 能用「非负整数」这一条硬约束来校验。
 *
 * ## 价格来源
 *
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * （2026-10-01 核对：Flash 命中 0.02/0.04、未命中 1/2、输出 4/8；
 *   Pro 命中 0.15/0.30、未命中 4.5/9.0、输出 13.5/27.0，单位元/百万 token）
 *
 * @module dsh-session-cost/pricing
 */

/** 计价币种。价目表按人民币录入；其它币种只能通过 `prices` 配置自行提供。 */
export const DEFAULT_CURRENCY = 'CNY'

/**
 * 内置价目表，单位「元 / 百万 token」。
 *
 * 每个模型给三个桶，每个桶是 `[空闲时段价, 高峰时段价]`：
 * - `hit`  —— 输入，缓存命中
 * - `miss` —— 输入，缓存未命中（缓存写入同样按未命中计费）
 * - `out`  —— 输出
 *
 * 键按「长度降序」做子串匹配（见 {@link resolvePrice}），所以 `deepseek-v4-pro`
 * 不会被 `deepseek-v4` 之类的前缀误伤。
 */
export const OFFICIAL_PRICING = Object.freeze({
  // deepseek-v4-flash 与 deepseek-v4-flash-vision-exp 两个旧名已下线，
  // 请求由 V4.1-Flash 提供服务并按 Flash 价计费，故三者同价。
  'deepseek-v4-flash-vision-exp': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-pro': { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] },
})

/**
 * 2026 年中国法定节假日（仅列**放假**日期，调休上班日都落在周末，本来就按空闲计费）。
 *
 * 依据：官方计费脚注「北京时间周一至周五（不含中国法定节假日）9:00–12:00、
 * 14:00–18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段」，
 * 以及《国务院办公厅关于 2026 年部分节假日安排的通知》。
 *
 * ⚠️ 每年 11 月国务院公布次年安排后，需要在这里补下一年的日期，或改用
 * `holidays` 配置项自行下发。
 */
export const VALLEY_HOLIDAYS_2026 = Object.freeze([
  '2026-01-01', '2026-01-02', '2026-01-03', // 元旦
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23', // 春节
  '2026-04-04', '2026-04-05', '2026-04-06', // 清明
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', // 劳动节
  '2026-06-19', '2026-06-20', '2026-06-21', // 端午
  '2026-09-25', '2026-09-26', '2026-09-27', // 中秋
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07', // 国庆
])

/** 北京时间的偏移毫秒数（中国全境单一时区，无夏令时）。 */
const BEIJING_OFFSET_MS = 8 * 3600 * 1000

/** 高峰时段（北京时间的小时区间，左闭右开）。 */
const PEAK_HOURS = Object.freeze([[9, 12], [14, 18]])

/**
 * 判定一个时刻是否处于**高峰时段**。
 *
 * 规则与官方脚注逐条对应：周末全天空闲、法定节假日全天空闲，工作日只在该两个
 * 区间内高峰。实现上把时刻平移 +8h 后按 UTC 字段读，即得北京「墙上时间」。
 *
 * @param epochMs - 事件时间（毫秒；DSH 的 `SessionEvent.time` 即此）。
 * @param holidays - 放假日期的 `YYYY-MM-DD` 集合；空集合表示不考虑节假日。
 * @returns 高峰时段返回 true（价目表取第二位），否则 false（取第一位）。
 */
export function isPeakAt(epochMs, holidays) {
  if (!Number.isFinite(epochMs)) return false
  const beijing = new Date(epochMs + BEIJING_OFFSET_MS)
  const weekday = beijing.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  if (holidays !== undefined && holidays.size > 0 && holidays.has(beijing.toISOString().slice(0, 10))) return false
  const hour = beijing.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

/** 把配置里的节假日数组折成查找集合；未配置时回落到 {@link VALLEY_HOLIDAYS_2026}。 */
function holidaySet(holidays) {
  if (holidays === undefined) return new Set(VALLEY_HOLIDAYS_2026)
  return new Set(holidays)
}

/**
 * 归一化一条用户自定义价格。
 *
 * 允许三种写法，便于手写配置：
 * - `{ hit, miss, out }`            —— 单值，峰谷同价
 * - `{ hit: [谷, 峰], ... }`        —— 显式给两档
 * - `{ value: 1.5, ... }`           —— 同上，等价于单值
 *
 * @param raw - 配置里的原始对象。
 * @returns 三桶均为 `[谷, 峰]` 二元组的价目，非法输入返回 undefined。
 */
function normalizePriceEntry(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const buckets = {}
  for (const key of ['hit', 'miss', 'out']) {
    const value = raw[key]
    const pair = Array.isArray(value) ? value : [value, value]
    const off = toPrice(pair[0])
    const peak = toPrice(pair[1])
    if (off === undefined || peak === undefined) return undefined
    buckets[key] = [off, peak]
  }
  return buckets
}

/** 单个单价必须是有限非负数。 */
function toPrice(value) {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * 解析插件配置为一份可复用的计价选项。
 *
 * @param config - Cordis 传入的插件配置（可能只有部分字段）。
 * @returns 计价选项：自定义价目表、默认价、币种、峰谷开关与节假日集合。
 */
export function resolvePricingOptions(config) {
  const source = config ?? {}
  const custom = []
  const declared = Array.isArray(source.prices) ? source.prices : []
  for (const entry of declared) {
    if (typeof entry !== 'object' || entry === null) continue
    const match = typeof entry.match === 'string' ? entry.match.trim().toLowerCase() : ''
    if (match === '') continue
    const price = normalizePriceEntry(entry)
    if (price === undefined) continue
    custom.push({ match, price })
  }
  // 最长关键字优先，避免短关键字（如 pro）抢走更长模型的匹配。
  custom.sort((left, right) => right.match.length - left.match.length)

  const fallback = normalizePriceEntry(source.defaultPrice)
  return {
    currency: typeof source.currency === 'string' && source.currency.trim() !== ''
      ? source.currency.trim().toUpperCase().slice(0, 8)
      : DEFAULT_CURRENCY,
    peakPricing: source.peakPricing !== false,
    custom,
    fallback,
    holidays: holidaySet(Array.isArray(source.holidays) ? source.holidays : undefined),
  }
}

/**
 * 为一个模型名解析单价。
 *
 * 匹配顺序：自定义价目表（最长关键字优先）→ 内置官方价目表（同样最长优先）
 * → `defaultPrice`（若配置了）。都没有则返回 undefined，调用方应把这次请求
 * 的 token 计入「未计价」而不是猜一个价格。
 *
 * @param model - 路由到的模型名（大小写不敏感的子串匹配）。
 * @param options - {@link resolvePricingOptions} 的结果。
 * @param peak - 该次请求是否处于高峰时段。
 * @returns `{ hit, miss, out }`（元/百万 token），或 undefined。
 */
export function resolvePrice(model, options, peak) {
  const name = typeof model === 'string' ? model.toLowerCase() : ''
  const pick = (buckets) => ({
    hit: buckets.hit[peak ? 1 : 0],
    miss: buckets.miss[peak ? 1 : 0],
    out: buckets.out[peak ? 1 : 0],
  })
  for (const { match, price } of options.custom) {
    if (name.includes(match)) return pick(price)
  }
  if (name !== '') {
    const keys = Object.keys(OFFICIAL_PRICING).sort((left, right) => right.length - left.length)
    for (const key of keys) {
      if (name.includes(key)) return pick(OFFICIAL_PRICING[key])
    }
  }
  return options.fallback === undefined ? undefined : pick(options.fallback)
}

/**
 * 把一次请求的 token 分桶折成金额（微元）。
 *
 * 计费口径与官方文档一致：**缓存未命中的输入**与**缓存写入**都按未命中单价计费。
 * DSH 的 `TokenUsage.inputTokens` 已经是「未命中输入」（`totalTokens` 等于
 * `inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens`），所以这里
 * 不做任何相减。
 *
 * @param buckets - `{ uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }`。
 * @param price - {@link resolvePrice} 的结果。
 * @returns 进位到整数的微元金额。
 */
export function attemptMicros(buckets, price) {
  const missTokens = buckets.uncachedInputTokens + buckets.cacheWriteTokens
  return Math.round(
    missTokens * price.miss
    + buckets.cacheReadTokens * price.hit
    + buckets.outputTokens * price.out,
  )
}
