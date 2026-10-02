/**
 * dsh-session-cost 的单元测试。
 *
 * 三类覆盖：
 * 1. **计价内核** —— 峰谷判定、价目匹配、整数微元换算。
 * 2. **折叠状态机** —— 用合成事件序列钉死「一次请求只算一次」与「重试算两次」。
 * 3. **真实日志重放** —— 把本机 `~/.dsh/sessions` 里的会话全量喂进 fold，和一个
 *    独立的参考实现对账。这是最有价值的一层：合成用例想不出真实日志里的
 *    `assistant/attempt` → `llm/retry` → `llm/retry-started` → `assistant/message`
 *    这种序列。目录不存在时自动跳过（CI/他人机器）。
 *
 * 运行：node --test lib/index.test.js
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

import {
  OFFICIAL_PRICING,
  VALLEY_HOLIDAYS_2026,
  attemptMicros,
  isPeakAt,
  resolvePrice,
  resolvePricingOptions,
} from './pricing.js'
import { Config, createSessionCostProjection, foldSessionCost } from './index.js'
import { int, object, record, str } from './schema.js'

/** 北京时间 2026-10-01 是国庆假期（周四）10:00，若按工作日算本应是高峰。 */
const HOLIDAY_MS = Date.UTC(2026, 9, 1, 2, 0, 0)
/** 北京时间 2026-10-12 是普通周一 10:00，属于高峰时段。 */
const PEAK_MS = Date.UTC(2026, 9, 12, 2, 0, 0)
/** 北京时间 2026-10-12 是普通周一 13:00，属于空闲时段（12:00–14:00 的午休）。 */
const LUNCH_MS = Date.UTC(2026, 9, 12, 5, 0, 0)
/** 北京时间 2026-10-11 是周日，全天空闲。 */
const SUNDAY_MS = Date.UTC(2026, 9, 11, 2, 0, 0)

const flashOptions = resolvePricingOptions({})

describe('pricing.isPeakAt', () => {
  const holidays = new Set(VALLEY_HOLIDAYS_2026)

  test('工作日的高峰区间判为高峰', () => {
    assert.equal(isPeakAt(PEAK_MS, holidays), true)
  })

  test('工作日午休判为空闲', () => {
    assert.equal(isPeakAt(LUNCH_MS, holidays), false)
  })

  test('周末全天判为空闲', () => {
    assert.equal(isPeakAt(SUNDAY_MS, holidays), false)
  })

  test('法定节假日全天判为空闲（即使落在工作日的9-12点）', () => {
    assert.equal(isPeakAt(HOLIDAY_MS, holidays), false)
    // 同一时刻若不考虑节假日则是高峰——证明是节假日规则在起作用。
    assert.equal(isPeakAt(HOLIDAY_MS, new Set()), true)
  })

  test('非法时刻判为空闲而不是抛错', () => {
    assert.equal(isPeakAt(Number.NaN, holidays), false)
  })
})

describe('pricing.resolvePrice', () => {
  test('内置表按子串匹配，长键优先', () => {
    const peak = resolvePrice('deepseek-v4-pro', flashOptions, true)
    assert.deepEqual(peak, { hit: 0.3, miss: 9, out: 27 })
    const valley = resolvePrice('deepseek-v4-pro', flashOptions, false)
    assert.deepEqual(valley, { hit: 0.15, miss: 4.5, out: 13.5 })
  })

  test('已下线的旧名按 Flash 计价', () => {
    assert.deepEqual(resolvePrice('deepseek-v4-flash-vision-exp', flashOptions, false), {
      hit: OFFICIAL_PRICING['deepseek-flash'].hit[0],
      miss: OFFICIAL_PRICING['deepseek-flash'].miss[0],
      out: OFFICIAL_PRICING['deepseek-flash'].out[0],
    })
  })

  test('未知模型不猜价', () => {
    assert.equal(resolvePrice('gpt-5', flashOptions, false), undefined)
  })

  test('自定义价目表覆盖内置表且支持两档写法', () => {
    const options = resolvePricingOptions({
      prices: [{ match: 'deepseek-flash', hit: 1, miss: [10, 20], out: [30, 40] }],
    })
    assert.deepEqual(resolvePrice('deepseek-flash', options, false), { hit: 1, miss: 10, out: 30 })
    assert.deepEqual(resolvePrice('deepseek-flash', options, true), { hit: 1, miss: 20, out: 40 })
  })

  test('defaultPrice 兜住未知模型', () => {
    const options = resolvePricingOptions({ defaultPrice: { hit: 1, miss: 2, out: 3 } })
    assert.deepEqual(resolvePrice('some-other-model', options, false), { hit: 1, miss: 2, out: 3 })
    // 内置表仍然优先于兜底价。
    assert.deepEqual(resolvePrice('deepseek-flash', options, false), { hit: 0.02, miss: 1, out: 4 })
  })
})

describe('pricing.attemptMicros', () => {
  test('微元 = token × 单价（元/百万 token）', () => {
    // 1M 命中缓存 token × 0.02 元/百万 = 0.02 元 = 20000 微元。
    assert.equal(attemptMicros(
      { uncachedInputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 0 },
      { hit: 0.02, miss: 1, out: 4 },
    ), 20_000)
  })

  test('缓存写入按未命中单价计费', () => {
    const withWrite = attemptMicros(
      { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1000, outputTokens: 0 },
      { hit: 0.02, miss: 1, out: 4 },
    )
    assert.equal(withWrite, 1000)
  })

  test('与官方样例一致：306 未命中 + 7424 命中 + 115 输出', () => {
    const micros = attemptMicros(
      { uncachedInputTokens: 306, cacheReadTokens: 7424, cacheWriteTokens: 0, outputTokens: 115 },
      { hit: 0.02, miss: 1, out: 4 },
    )
    // 306×1 + 7424×0.02 + 115×4 = 306 + 148.48 + 460 = 914.48 微元 = 0.00091448 元
    assert.equal(micros, 914)
  })
})

describe('schema', () => {
  test('接受合法对象并剥掉未声明字段之外的输入', () => {
    const schema = object({ a: int(), b: str(), m: record(int()) })
    assert.deepEqual(schema.parse({ a: 1, b: 'x', m: { k: 2 } }), { a: 1, b: 'x', m: { k: 2 } })
  })

  test('拒绝未知字段、负数与非整数', () => {
    const schema = object({ a: int() })
    assert.throws(() => schema.parse({ a: 1, extra: 2 }), /not a declared field/)
    assert.throws(() => schema.parse({ a: -1 }), /non-negative safe integer/)
    assert.throws(() => schema.parse({ a: 1.5 }), /non-negative safe integer/)
    assert.throws(() => schema.parse({ a: '1' }), /non-negative safe integer/)
    assert.throws(() => schema.parse(null), /must be an object/)
  })
})

/** 造一条 step/start。 */
function stepStart(turn, step, time) {
  return { type: 'step/start', time, data: { turn, step } }
}

/** 造一条 step/end。 */
function stepEnd(turn, step, time) {
  return { type: 'step/end', time, data: { turn, step } }
}

/** 造一条 assistant/message。 */
function assistantMessage({ turn, step, time, usage, model = 'deepseek-flash', messageId = `m-${turn}-${step}` }) {
  return {
    type: 'assistant/message',
    time,
    data: {
      turn,
      step,
      usage,
      message: { id: messageId, source: { kind: 'model', provider: 'deepseek-account', model } },
    },
  }
}

/** 一批 token 桶。 */
function buckets(uncached, cacheRead, output) {
  return { inputTokens: uncached, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0 }
}

/** 把一串事件折完，返回最终状态。 */
function foldAll(events, options = resolvePricingOptions({ peakPricing: false })) {
  let state = createSessionCostProjection(options).init()
  for (const event of events) state = foldSessionCost(state, event, options)
  return state
}

describe('foldSessionCost', () => {
  test('一次普通请求：按路由计价并记进轮次表', () => {
    const state = foldAll([
      stepStart(1, 1, LUNCH_MS),
      assistantMessage({ turn: 1, step: 1, time: LUNCH_MS, usage: buckets(1000, 0, 1000), messageId: 'a' }),
      stepEnd(1, 1, LUNCH_MS),
    ])
    // 1000×1 + 1000×4 = 5000 微元
    assert.equal(state.micros, 5000)
    assert.deepEqual(state.turns['1'], { micros: 5000, unpricedTokens: 0 })
    assert.equal(state.messages.a, 1)
    assert.equal(state.unpricedTokens, 0)
  })

  test('同一 step 的 attempt + 重试各算一次（累加而非覆盖）', () => {
    const state = foldAll([
      // 先有一轮成功请求，让 lastRoute 立起来——attempt 事件本身不带路由。
      stepStart(1, 1, LUNCH_MS),
      assistantMessage({ turn: 1, step: 1, time: LUNCH_MS, usage: buckets(1000, 0, 1000), messageId: 'b0' }),
      stepEnd(1, 1, LUNCH_MS),
      stepStart(2, 1, LUNCH_MS),
      // 失败的一次：stream 里带 usage。
      {
        type: 'assistant/attempt',
        time: LUNCH_MS,
        data: { turn: 2, step: 1, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: buckets(500, 0, 200) } }] },
      },
      { type: 'llm/retry', time: LUNCH_MS, data: { turn: 2, step: 1 } },
      { type: 'llm/retry-started', time: LUNCH_MS, data: { turn: 2, step: 1 } },
      assistantMessage({ turn: 2, step: 1, time: LUNCH_MS, usage: buckets(1000, 0, 1000), messageId: 'b' }),
      stepEnd(2, 1, LUNCH_MS),
    ])
    // 第 1 轮：1000×1 + 1000×4 = 5000
    // 第 2 轮失败：500×1 + 200×4 = 1300；成功：1000×1 + 1000×4 = 5000
    assert.equal(state.micros, 11_300)
    assert.equal(state.turns['2'].micros, 6300)
    assert.equal(state.unpricedTokens, 0)
  })

  test('step/end 不会把已结算的请求再算一遍', () => {
    const state = foldAll([
      stepStart(1, 1, LUNCH_MS),
      assistantMessage({ turn: 1, step: 1, time: LUNCH_MS, usage: buckets(100, 0, 100), messageId: 'c' }),
      stepEnd(1, 1, LUNCH_MS),
      stepEnd(1, 1, LUNCH_MS),
    ])
    assert.equal(state.micros, 500)
  })

  test('无 usage 的请求不产生金额，也不产生假轮次', () => {
    const state = foldAll([stepStart(1, 1, LUNCH_MS), stepEnd(1, 1, LUNCH_MS)])
    assert.equal(state.micros, 0)
    assert.deepEqual(state.turns, {})
  })

  test('未知模型只计 unpricedTokens，不猜价', () => {
    const state = foldAll([
      stepStart(1, 1, LUNCH_MS),
      assistantMessage({ turn: 1, step: 1, time: LUNCH_MS, usage: buckets(1000, 0, 1000), model: 'gpt-5', messageId: 'd' }),
      stepEnd(1, 1, LUNCH_MS),
    ])
    assert.equal(state.micros, 0)
    assert.equal(state.unpricedTokens, 2000)
  })

  test('attempt 缺路由时回落到本会话最近一次已知路由', () => {
    const state = foldAll([
      stepStart(1, 1, LUNCH_MS),
      assistantMessage({ turn: 1, step: 1, time: LUNCH_MS, usage: buckets(1000, 0, 0), messageId: 'e' }),
      stepEnd(1, 1, LUNCH_MS),
      stepStart(1, 2, LUNCH_MS),
      {
        type: 'assistant/attempt',
        time: LUNCH_MS,
        data: { turn: 1, step: 2, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: buckets(1000, 0, 0) } }] },
      },
      stepEnd(1, 2, LUNCH_MS),
    ])
    assert.equal(state.micros, 2000)
    assert.equal(state.unpricedTokens, 0)
  })

  test('中途换模型：各自按自己的单价计', () => {
    const state = foldAll([
      stepStart(1, 1, LUNCH_MS),
      assistantMessage({ turn: 1, step: 1, time: LUNCH_MS, usage: buckets(1_000_000, 0, 0), messageId: 'f' }),
      stepEnd(1, 1, LUNCH_MS),
      stepStart(1, 2, LUNCH_MS),
      assistantMessage({ turn: 1, step: 2, time: LUNCH_MS, usage: buckets(1_000_000, 0, 0), model: 'deepseek-v4-pro', messageId: 'g' }),
      stepEnd(1, 2, LUNCH_MS),
    ])
    // Flash 未命中 1 元/百万 + Pro 未命中 4.5 元/百万 = 5.5 元 = 5_500_000 微元
    assert.equal(state.micros, 5_500_000)
  })

  test('峰谷按每次请求各自的时刻判定', () => {
    const options = resolvePricingOptions({ peakPricing: true })
    const state = foldAll([
      stepStart(1, 1, PEAK_MS),
      assistantMessage({ turn: 1, step: 1, time: PEAK_MS, usage: buckets(1_000_000, 0, 0), messageId: 'h' }),
      stepEnd(1, 1, PEAK_MS),
      stepStart(1, 2, LUNCH_MS),
      assistantMessage({ turn: 1, step: 2, time: LUNCH_MS, usage: buckets(1_000_000, 0, 0), messageId: 'i' }),
      stepEnd(1, 2, LUNCH_MS),
    ], options)
    // 高峰 2 元 + 空闲 1 元 = 3 元
    assert.equal(state.micros, 3_000_000)
  })

  test('与计价无关的事件原样返回同一个状态引用（框架据此跳过重算）', () => {
    const options = resolvePricingOptions({})
    const state = foldAll([stepStart(1, 1, LUNCH_MS)], options)
    for (const event of [
      { type: 'tool/call', time: LUNCH_MS, data: { turn: 1, step: 1 } },
      { type: 'tool/result', time: LUNCH_MS, data: { turn: 1, step: 1 } },
      { type: 'user/message', time: LUNCH_MS, data: {} },
    ]) {
      assert.equal(foldSessionCost(state, event, options), state)
    }
  })

  test('投影定义通过自身 schema 校验', () => {
    const projection = createSessionCostProjection(resolvePricingOptions({}))
    const state = foldAll([
      stepStart(1, 1, LUNCH_MS),
      assistantMessage({ turn: 1, step: 1, time: LUNCH_MS, usage: buckets(10, 0, 10), messageId: 'j' }),
      stepEnd(1, 1, LUNCH_MS),
    ])
    assert.doesNotThrow(() => projection.stateSchema.parse(state))
    assert.doesNotThrow(() => projection.wire.viewSchema.parse(projection.wire.view(state)))
  })
})

// ---------------------------------------------------------------------------
// 插件配置（Standard Schema）
// ---------------------------------------------------------------------------

describe('Config', () => {
  const validate = (raw) => Config['~standard'].validate(raw)

  test('导出的是 Standard Schema：Cordis 只认这条契约', () => {
    // Cordis 的 resolveConfig 直接取 Config["~standard"].validate(...)，
    // 缺这个字段会在带配置时抛错，所以这是硬约束而不是风格问题。
    assert.equal(typeof Config['~standard'].validate, 'function')
    assert.equal(Config['~standard'].version, 1)
    assert.equal(typeof Config['~standard'].vendor, 'string')
  })

  test('空配置得到全套默认值', () => {
    const result = validate(undefined)
    assert.deepEqual(result, { value: { currency: 'CNY', peakPricing: true, prices: [] } })
  })

  test('校验结果是同步的（Cordis 明确拒绝异步校验）', () => {
    const result = validate({})
    assert.equal(typeof result?.then, 'undefined')
    assert.ok('value' in result)
  })

  test('归一化币种写法', () => {
    assert.equal(validate({ currency: ' usd ' }).value.currency, 'USD')
  })

  test('单值单价展开成 [空闲, 高峰]', () => {
    const result = validate({ prices: [{ match: 'my-model', hit: 1, miss: 2, out: [3, 6] }] })
    assert.deepEqual(result.value.prices, [{ match: 'my-model', hit: [1, 1], miss: [2, 2], out: [3, 6] }])
  })

  test('defaultPrice 缺省时不出现（区别于「全 0 元」）', () => {
    assert.equal('defaultPrice' in validate({}).value, false)
    assert.deepEqual(validate({ defaultPrice: { hit: 1, miss: 2, out: 3 } }).value.defaultPrice, {
      hit: [1, 1], miss: [2, 2], out: [3, 3],
    })
  })

  test('拼错的配置项当场报错，而不是被静默忽略', () => {
    const result = validate({ currnecy: 'USD' })
    assert.ok(Array.isArray(result.issues))
    assert.match(result.issues[0].message, /currnecy/)
  })

  test('类型错误逐项上报并带路径', () => {
    const result = validate({ peakPricing: 'yes', prices: [{ match: 'm', hit: -1, miss: 2, out: 3 }] })
    assert.equal(result.issues.length, 2)
    assert.deepEqual(result.issues.map((issue) => issue.path).flat(), ['peakPricing', 'prices[0].hit'])
  })

  test('prices 项缺少字段时点名缺失的字段', () => {
    const result = validate({ prices: [{ match: 'm', hit: 1 }] })
    assert.equal(result.issues.length, 2)
    assert.match(result.issues.map((issue) => issue.message).join(' '), /miss 缺失.*out 缺失/)
  })

  test('holidays 只接受 YYYY-MM-DD', () => {
    assert.deepEqual(validate({ holidays: ['2027-01-01'] }).value.holidays, ['2027-01-01'])
    assert.match(validate({ holidays: ['2027/01/01'] }).issues[0].message, /YYYY-MM-DD/)
  })

  test('校验后的配置能直接被 pricing 层消费', () => {
    const options = resolvePricingOptions(validate({
      prices: [{ match: 'my-model', hit: 0.5, miss: [10, 20], out: [30, 40] }],
    }).value)
    assert.deepEqual(resolvePrice('my-model', options, true), { hit: 0.5, miss: 20, out: 40 })
  })
})

// ---------------------------------------------------------------------------
// 真实日志重放
// ---------------------------------------------------------------------------

/** 读出 zstd 里所有拼接帧并解析成事件数组。 */
function decodeSessionFile(path) {
  const buf = readFileSync(path)
  const magic = [0x28, 0xb5, 0x2f, 0xfd]
  const offsets = []
  for (let i = 0; i < buf.length - 3; i += 1) {
    if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) offsets.push(i)
  }
  let raw = ''
  for (const offset of offsets) {
    try {
      raw += zstdDecompressSync(buf.subarray(offset)).toString('utf8')
    } catch {
      // 非帧起始位置的魔数（理论上不会出现）直接跳过。
    }
  }
  const events = []
  for (const line of raw.split('\n')) {
    if (line === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 尾部半行，忽略。
    }
  }
  return events
}

/** 递归收集所有会话日志。 */
function sessionFiles(directory) {
  const out = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) out.push(...sessionFiles(path))
    else if (entry.endsWith('.jsonl.zstd')) out.push(path)
  }
  return out
}

/**
 * 参考实现：不复用 fold 的任何代码，直接按「每条 assistant/message 一次请求」
 * 独立累加。真实日志里不存在 attempt→message 指向同一请求的情况，所以两者应当
 * 逐分会相等（attempt 在本机日志里都没有 usage，贡献为 0）。
 */
function referenceMicros(events, options) {
  let micros = 0
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (usage === undefined) continue
    const model = event.data?.message?.source?.model
    const at = event.data.turn === undefined ? event.time : (event.time ?? 0)
    const peak = options.peakPricing && isPeakAt(at, options.holidays)
    const price = resolvePrice(model, options, peak)
    if (price === undefined) continue
    micros += attemptMicros({
      uncachedInputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    }, price)
  }
  return micros
}

describe('真实会话日志重放', () => {
  const root = join(homedir(), '.dsh', 'sessions')
  let files = []
  try {
    files = sessionFiles(root)
  } catch {
    files = []
  }

  test('会话日志目录存在（否则跳过）', { skip: files.length === 0 ? '本机没有 ~/.dsh/sessions' : false }, () => {
    assert.ok(files.length > 0)
  })

  test('全量重放：fold 的总额与独立参考实现一致', { skip: files.length === 0 ? '本机没有 ~/.dsh/sessions' : false }, () => {
    const options = resolvePricingOptions({})
    let sessions = 0
    let checked = 0
    let totalMicros = 0
    for (const file of files) {
      const events = decodeSessionFile(file)
      if (!events.some((event) => event.type === 'assistant/message')) continue
      const state = foldAll(events, options)
      const reference = referenceMicros(events, options)
      sessions += 1
      totalMicros += state.micros
      assert.equal(state.micros, reference, `会话 ${file} 的金额与参考实现不一致`)
      // 每条 assistant/message 都应留下 messageId → turn 映射。
      const messages = events.filter((event) => event.type === 'assistant/message')
      for (const event of messages) {
        const id = event.data?.message?.id
        if (typeof id !== 'string' || id === '') continue
        assert.equal(state.messages[id], event.data.turn, `会话 ${file} 缺少 ${id} 的轮次映射`)
        checked += 1
      }
      // 状态必须始终能通过投影自己的 schema。
      assert.doesNotThrow(() => createSessionCostProjection(options).stateSchema.parse(state))
    }
    assert.ok(sessions > 0, '应当至少重放一个会话')
    assert.ok(checked > 0, '应当至少核对一条消息映射')
    console.log(`      重放 ${sessions} 个会话、${checked} 条 assistant/message，合计 ${(totalMicros / 1e6).toFixed(4)} 元`)
  })
})
