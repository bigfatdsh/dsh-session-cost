/**
 * 插件配置的校验与默认值。
 *
 * ## 为什么是 Standard Schema，而不是 zod / schemastery
 *
 * Cordis 解析插件配置走的是一条固定契约（`cordis/lib/index.js` 的 `resolveConfig`）：
 *
 * ```js
 * const result = runtime.Config["~standard"].validate(config)
 * if (result.issues) throw new ValidationError(result.issues)
 * else return result.value
 * ```
 *
 * 也就是 [Standard Schema](https://standardschema.dev) —— 一个只有 `validate` 的
 * 极小接口。zod v4 与 `@deepseek-ai/schemastery` 都实现了它，但两者在这个位置都
 * 不是可靠选择：profile 侧插件按真实路径解析依赖，从插件目录往上走既找不到
 * `zod`（在 profile 根），也不保证找得到 `@deepseek-ai/*`（在 app.asar 内）。
 *
 * 所以这里直接实现 `~standard`：零依赖、永远可用、校验与默认值都在本地完成。
 *
 * 注意一个坑：**`Config` 一旦导出，就必须带 `~standard`**。Cordis 只判断
 * `runtime.Config` 是否存在，随后立刻取 `["~standard"]`；导出一个没有该字段的
 * 对象会让插件在带配置时直接抛错。导出 `undefined` 才是「跳过校验」。
 *
 * 代价：配置面板的 JSON Schema 投影只认原生 schemastery 标记，本插件会显示为
 * `unsupported`（“声明了 schema，但不是原生那种”），校验与默认值照常生效。
 *
 * @module dsh-session-cost/config
 */

/** 声明本 schema 的 vendor 字段。 */
const VENDOR = 'dsh-session-cost'

/** 允许作为单价的写法：有限非负数。 */
function readUnit(value, path, issues) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    issues.push({ message: `${path} 必须是有限非负数`, path: [path] })
    return undefined
  }
  return value
}

/**
 * 读一档单价：可以是单值（峰谷同价），也可以是 `[空闲, 高峰]` 两元组。
 *
 * @param value - 配置里的原始值。
 * @param path - 出错时上报的字段路径。
 * @param issues - 问题收集器。
 * @returns 归一化后的 `[空闲, 高峰]`，非法时返回 undefined。
 */
function readPrice(value, path, issues) {
  if (Array.isArray(value)) {
    if (value.length !== 2) {
      issues.push({ message: `${path} 写成数组时必须恰好两个元素 [空闲, 高峰]`, path: [path] })
      return undefined
    }
    const off = readUnit(value[0], `${path}[0]`, issues)
    const peak = readUnit(value[1], `${path}[1]`, issues)
    return off === undefined || peak === undefined ? undefined : [off, peak]
  }
  const single = readUnit(value, path, issues)
  return single === undefined ? undefined : [single, single]
}

/** 三桶单价（命中 / 未命中 / 输出）里必须齐备的键。 */
const PRICE_KEYS = ['hit', 'miss', 'out']

/**
 * 读一组三桶单价。
 *
 * @param value - 配置里的原始对象。
 * @param path - 出错时上报的字段路径。
 * @param issues - 问题收集器。
 * @param allowed - 除 hit/miss/out 之外、由调用方自己消费的键（`prices` 项里的 `match`）。
 * @returns `{ hit, miss, out }`（各为 `[空闲, 高峰]`），非法时返回 undefined。
 */
function readPriceSet(value, path, issues, allowed = []) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({ message: `${path} 必须是对象`, path: [path] })
    return undefined
  }
  for (const key of Object.keys(value)) {
    if (!PRICE_KEYS.includes(key) && !allowed.includes(key)) issues.push({ message: `${path}.${key} 不是可识别的单价字段（只能是 hit / miss / out${allowed.length > 0 ? ` / ${allowed.join(' / ')}` : ''}）`, path: [path, key] })
  }
  const out = {}
  let ok = true
  for (const key of PRICE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      issues.push({ message: `${path}.${key} 缺失`, path: [path, key] })
      ok = false
      continue
    }
    const price = readPrice(value[key], `${path}.${key}`, issues)
    if (price === undefined) ok = false
    else out[key] = price
  }
  return ok ? out : undefined
}

/** 配置里允许出现的顶层字段；未知字段一律报错，让 YAML 里的拼写错误当场暴露。 */
const CONFIG_KEYS = ['currency', 'peakPricing', 'estimateFailedAttempts', 'prices', 'defaultPrice', 'holidays']

/**
 * 校验并归一化插件配置。
 *
 * @param raw - Cordis 交来的原始配置（无配置时为 undefined / null）。
 * @returns `{ value }` 或 `{ issues }`，符合 Standard Schema 的返回约定。
 */
export function validateConfig(raw) {
  const issues = []
  const source = raw === undefined || raw === null ? {} : raw
  if (typeof source !== 'object' || Array.isArray(source)) {
    return { issues: [{ message: '插件配置必须是对象', path: [] }] }
  }
  for (const key of Object.keys(source)) {
    if (!CONFIG_KEYS.includes(key)) issues.push({ message: `${key} 不是可识别的配置项（可用：${CONFIG_KEYS.join(' / ')}）`, path: [key] })
  }

  const config = {}

  if (source.currency === undefined) config.currency = 'CNY'
  else if (typeof source.currency !== 'string' || source.currency.trim() === '') issues.push({ message: 'currency 必须是非空字符串', path: ['currency'] })
  else config.currency = source.currency.trim().toUpperCase().slice(0, 8)

  if (source.peakPricing === undefined) config.peakPricing = true
  else if (typeof source.peakPricing !== 'boolean') issues.push({ message: 'peakPricing 必须是布尔值', path: ['peakPricing'] })
  else config.peakPricing = source.peakPricing

  if (source.estimateFailedAttempts === undefined) config.estimateFailedAttempts = true
  else if (typeof source.estimateFailedAttempts !== 'boolean') issues.push({ message: 'estimateFailedAttempts 必须是布尔值', path: ['estimateFailedAttempts'] })
  else config.estimateFailedAttempts = source.estimateFailedAttempts

  if (source.prices === undefined) config.prices = []
  else if (!Array.isArray(source.prices)) issues.push({ message: 'prices 必须是数组', path: ['prices'] })
  else {
    const prices = []
    for (const [index, entry] of source.prices.entries()) {
      const path = `prices[${index}]`
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        issues.push({ message: `${path} 必须是对象`, path: [path] })
        continue
      }
      if (typeof entry.match !== 'string' || entry.match.trim() === '') {
        issues.push({ message: `${path}.match 必须是非空字符串（模型名子串）`, path: [path, 'match'] })
        continue
      }
      const normalized = readPriceSet(entry, path, issues, ['match'])
      if (normalized !== undefined) prices.push({ match: entry.match.trim(), ...normalized })
    }
    config.prices = prices
  }

  if (source.defaultPrice !== undefined) {
    const normalized = readPriceSet(source.defaultPrice, 'defaultPrice', issues)
    if (normalized !== undefined) config.defaultPrice = normalized
  }

  if (source.holidays !== undefined) {
    if (!Array.isArray(source.holidays)) issues.push({ message: 'holidays 必须是 YYYY-MM-DD 字符串数组', path: ['holidays'] })
    else {
      const holidays = []
      for (const [index, day] of source.holidays.entries()) {
        if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          issues.push({ message: `holidays[${index}] 必须是 YYYY-MM-DD`, path: ['holidays', String(index)] })
          continue
        }
        holidays.push(day)
      }
      config.holidays = holidays
    }
  }

  return issues.length > 0 ? { issues } : { value: config }
}

/**
 * 插件的 `Config` 导出：一个最小的 Standard Schema。
 *
 * 同步返回、无副作用，符合 Cordis 对「异步校验不支持」的限制。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: VENDOR,
    validate: validateConfig,
  },
}
