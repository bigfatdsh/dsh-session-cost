/**
 * dsh-session-cost —— Host 半边：把「本会话 / 本轮花了多少钱」做成一个会话投影。
 *
 * ## 为什么是投影，而不是在前面算好再推给界面
 *
 * DSH 的界面读会话数据只有一条正规通道：**会话投影**（session projection）。
 * `ctx.sessionProjections.register()` 注册的每个 unit 都会被框架自动折进
 * 每个会话、随 control 流同步到浏览器，并在变化时通知；客户端用
 * `useProjection(key)` 读。所以插件只要交出一个纯 fold，投递是框架的事——
 * 不需要自己开 HTTP 路由、不需要轮询、也不需要客户端插件里再存一份状态。
 *
 * ## 折叠口径
 *
 * 计费的基本单位是**一次模型请求**：`assistant/message` 与 `assistant/attempt`
 * 各自是一次真实请求，都会产生费用，因此是**累加**关系（`llm/retry-started`
 * 会把重试后的新请求重新打开为一次独立尝试）。这与 `dsh-token-meter` 的
 * `tokenUsage` 投影口径一致：那里同样把同一 (turn, step) 内的多次
 * attempt 依次累加。
 *
 * 每个 attempt 的单价由**该次请求自己的**路由（provider/model）与**该次请求
 * 发生的时刻**决定：模型决定用哪一档价目，时刻决定高峰/空闲。会话中途换模型
 * 或跨峰谷时段时，这两条都让总价保持正确。
 *
 * ## 与官方界面口径的两处刻意差异
 *
 * 1. 官方 `TurnUsagePanel` 在发现 attempt 缺少路由时不展示该轮的模型行；本插件
 *    仍会给这笔用量计价，路由回落到「本会话最近一次已知路由」。重试几乎总落在
 *    同一个模型上，这比直接丢弃这段 token 更接近真实账单。
 * 2. 官方 fold 遇到生命周期不自洽时会整轮不展示用量；本插件改为一律累加
 *    `assistant/message` 的用量。理由是**漏算一次成功请求**比多算更糟，而
 *    真实日志里不存在 attempt 与 message 指向同一次请求的情况（已用本机
 *    19 个会话、1824 条 assistant/message 全量核对）。
 *
 * 解析不到单价的模型不会被猜价：它的 token 计入 `unpricedTokens`，界面据此
 * 显示「+」标记，表示实际花费只会更高。
 *
 * @module dsh-session-cost
 */

import {
  attemptMicros,
  isPeakAt,
  resolvePrice,
  resolvePricingOptions,
} from './pricing.js'
import { int, nullable, object, record, signedInt, str } from './schema.js'

/** 投影键。客户端以 `useProjection('sessionCost')` 读取。 */
export const PROJECTION_KEY = 'sessionCost'

/** Cordis 插件名；`cordis.patch.yml` 里的 id 即此。 */
export const name = 'session-cost'

/** 投影注册表是这个插件的全部意义所在：没有它，fiber 保持 pending。 */
export const inject = ['sessionProjections']

/**
 * 运行时配置：currency / peakPricing / prices / defaultPrice / holidays。
 *
 * 校验与默认值都在 `./config.js` 里以 Standard Schema（`~standard`）实现——这是
 * Cordis 解析插件配置的唯一契约，且不依赖任何可能解析不到的外部包。`apply` 内部
 * 仍对每个字段做一次 `?? 兜底`，所以即使配置未经校验（例如 `Config` 被替换掉），
 * 行为依旧确定。
 */
export { Config } from './config.js'

/** 一个 token 桶必须是非负安全整数。 */
function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * 把 provider 报的 usage 归一化成四个互不重叠的桶。
 *
 * `TokenUsage.inputTokens` 已经是**未命中**输入（`totalTokens` 等于三个输入桶
 * 加输出），所以这里不做任何相减；缺失的缓存字段按 0 处理。
 *
 * @param usage - `assistant/message` 事件上的 usage，或 stream 里的 usage chunk。
 * @returns 归一化后的桶，字段非法时返回 null。
 */
function normalizeSample(usage) {
  if (typeof usage !== 'object' || usage === null) return null
  const uncached = count(usage.inputTokens)
  const output = count(usage.outputTokens)
  if (uncached === undefined || output === undefined) return null
  const cacheRead = count(usage.cacheReadTokens ?? 0)
  const cacheWrite = count(usage.cacheWriteTokens ?? 0)
  if (cacheRead === undefined || cacheWrite === undefined) return null
  return {
    uncachedInputTokens: uncached,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  }
}

/**
 * 读一条 durable assistant stream 里最后一个 usage chunk。
 *
 * 复刻 `@deepseek-ai/dsh-llm/assistant-stream` 的 `lastAssistantStreamChunk`：
 * 从尾部找 `{ type: 'chunk', chunk: { type: 'usage' } }`。不能直接 import 那个
 * 包（见模块头注释）。
 *
 * @param stream - 事件的 `data.stream` 记录数组。
 * @returns 归一化后的桶，没有或非法时返回 null。
 */
function streamSample(stream) {
  if (!Array.isArray(stream)) return null
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record_ = stream[index]
    if (typeof record_ !== 'object' || record_ === null) continue
    if (record_.type !== 'chunk') continue
    const chunk = record_.chunk
    if (typeof chunk !== 'object' || chunk === null || chunk.type !== 'usage') continue
    return normalizeSample(chunk.usage)
  }
  return null
}

/**
 * 从一条 assistant 消息里读它的路由。
 *
 * @param message - `event.data.message`。
 * @returns `{ provider, model }`，任一为空时返回 null（该请求不算「有路由」）。
 */
function messageRoute(message) {
  if (typeof message !== 'object' || message === null) return null
  const source = message.source
  if (typeof source !== 'object' || source === null) return null
  const provider = typeof source.provider === 'string' ? source.provider : ''
  const model = typeof source.model === 'string' ? source.model : ''
  return provider === '' || model === '' ? null : { provider, model }
}

/** 两个路由是否指向同一个模型。 */
function sameRoute(left, right) {
  return left !== null && right !== null && left.provider === right.provider && left.model === right.model
}

/** 把三个桶加总成「这次请求一共动了多少 token」。 */
function totalTokens(buckets) {
  return buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens
}

/**
 * 重试原因里哪些通常已经被服务端受理并计费。
 *
 * RATE_LIMIT（429）与 SERVER（5xx）几乎都在生成开始前就被拒绝，不该估；
 * TRANSPORT（流中断）、TIMEOUT、EMPTY_RESPONSE 都是服务端已经开始处理后失败的，
 * 输入基本都会被计费，所以按随后那次成功请求的输入桶估一次。
 */
const BILLED_FAILURE_CODES = Object.freeze(['TRANSPORT', 'TIMEOUT', 'EMPTY_RESPONSE'])

/** 不可变地删掉一个键。 */
function dropKey(record, key) {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return record
  const next = { ...record }
  delete next[key]
  return next
}

/**
 * 一个会话的计价折叠状态。
 *
 * `phase` 复刻官方 `deriveTurnTokenUsage` 的尝试生命周期，用来判断「当前这次
 * 请求是否已经被计过价」；`sample` 是待结算的那次请求的用量。
 */
function initialState() {
  return {
    phase: 'idle',
    turn: -1,
    step: -1,
    by: '',
    time: 0,
    sample: null,
    route: null,
    lastRoute: null,
    micros: 0,
    unpricedTokens: 0,
    estimatedMicros: 0,
    estimatedRequests: 0,
    failed: {},
    turns: {},
    messages: {},
  }
}

/**
 * 结算当前这次尝试：把它折进总额与轮次表。
 *
 * 单价取 `state.route`（本次请求自己的路由），缺失时回落到 `lastRoute`
 * （本会话最近一次已知路由）。两者都没有时这次请求不猜价，token 计入
 * `unpricedTokens`。
 *
 * @param state - 当前状态。
 * @param options - 计价选项。
 * @param fallbackTime - `state.time` 不可用时（例如事件窗口不完整）退回的事件时刻。
 */
function closeAttempt(state, options, fallbackTime) {
  const buckets = state.sample
  const route = state.route ?? state.lastRoute
  const base = { ...state, sample: null, route: null }
  if (buckets === null) return base
  const tokens = totalTokens(buckets)
  if (tokens === 0) return base
  const at = state.time > 0 ? state.time : fallbackTime
  const peak = options.peakPricing && isPeakAt(at, options.holidays)
  const price = resolvePrice(route === null ? undefined : route.model, options, peak)
  const micros = price === undefined ? 0 : attemptMicros(buckets, price)
  const unpriced = price === undefined ? tokens : 0
  // 重试前那次失败的请求：服务端多半已经按输入计费，但会话里没有它的 usage
  // （失败的 attempt 不产生 assistant/message）。用随后成功那次的输入桶做保守
  // 估算、输出记 0；RATE_LIMIT / SERVER 这类多半没被受理，不估。
  const stepKey = `${state.turn}/${state.step}`
  const failed = options.estimateFailedAttempts ? state.failed[stepKey] : undefined
  let estimated = 0
  if (failed !== undefined && price !== undefined) {
    const inputOnly = {
      uncachedInputTokens: buckets.uncachedInputTokens,
      cacheReadTokens: buckets.cacheReadTokens,
      cacheWriteTokens: 0,
      outputTokens: 0,
    }
    const failedPeak = options.peakPricing && isPeakAt(failed.at, options.holidays)
    const failedPrice = resolvePrice(route === null ? undefined : route.model, options, failedPeak)
    if (failedPrice !== undefined) estimated = attemptMicros(inputOnly, failedPrice)
  }
  const failedRest = failed === undefined ? state.failed : dropKey(state.failed, stepKey)
  const key = String(state.turn)
  const previous = Object.prototype.hasOwnProperty.call(state.turns, key)
    ? state.turns[key]
    : { micros: 0, unpricedTokens: 0 }
  return {
    ...base,
    micros: state.micros + micros + estimated,
    unpricedTokens: state.unpricedTokens + unpriced,
    estimatedMicros: state.estimatedMicros + estimated,
    estimatedRequests: state.estimatedRequests + (estimated > 0 ? 1 : 0),
    failed: failedRest,
    turns: {
      ...state.turns,
      [key]: { micros: previous.micros + micros + estimated, unpricedTokens: previous.unpricedTokens + unpriced },
    },
    lastRoute: route ?? state.lastRoute,
  }
}

/**
 * 处理一条 `assistant/message`。
 *
 * 消息索引（messageId → turn）**先记**，且不依赖 phase：界面要按 messageId
 * 反查轮次，这条映射必须对每条已定稿的消息都成立。
 *
 * 随后**一律**给这条消息计价，不做 phase 门禁。官方 fold 遇到生命周期不自洽
 * 时会整轮作废，但一次已定稿的模型请求必然产生费用：漏算一次成功请求，比在
 * 「不该出现」的事件序列上多算一次更糟。真实日志里 `assistant/attempt` 之后
 * 直接跟同 step 的 `assistant/message` 一次都没出现过（本机 19 个会话全量核对），
 * 所以这条路径不会造成重复计价。
 */
function applyMessage(state, event, options) {
  const turn = event.data.turn
  const step = event.data.step
  const route = messageRoute(event.data.message)
  let next = state
  if (route !== null && !sameRoute(state.lastRoute, route)) next = { ...next, lastRoute: route }
  const messageId = event.data.message?.id
  if (typeof messageId === 'string' && messageId !== '' && state.messages[messageId] !== turn) {
    next = { ...next, messages: { ...next.messages, [messageId]: turn } }
  }
  const stillOpen = next.phase === 'open' && next.turn === turn && next.step === step
  // 同一 (turn, step) 内，attempt 已经结算过的样本不能被 message 再算一遍，
  // 所以只有仍处于本次尝试时才会沿用旧样本。
  const sample = normalizeSample(event.data.usage)
    ?? streamSample(event.data.stream)
    ?? (stillOpen ? next.sample : null)
  if (sample === null) return next
  return closeAttempt({ ...next, phase: 'settled', turn, step, by: '', sample, route }, options, event.time)
}

/**
 * 纯 fold：一条 committed 会话事件 → 下一个计价状态。
 *
 * 状态引用只在真的发生变化时才换新（框架据此决定是否重算并广播 wire view），
 * 所以与计价无关的事件（工具调用、消息正文等）不会带来任何开销。
 *
 * @param state - 上一个状态。
 * @param event - 一条 `SessionEvent`。
 * @param options - {@link resolvePricingOptions} 的结果。
 * @returns 下一个状态；无变化时原样返回。
 */
export function foldSessionCost(state, event, options) {
  switch (event.type) {
    case 'turn/start':
      // 上一轮没有以 step/end 收尾（中断、取消）时，开新轮前先归位，避免把新
      // 请求的用量记到旧轮头上。
      return state.phase === 'idle'
        ? state
        : { ...state, phase: 'idle', turn: -1, step: -1, by: '', sample: null, route: null, failed: {} }
    case 'step/start':
      return {
        ...state,
        phase: 'open',
        turn: event.data.turn,
        step: event.data.step,
        by: '',
        time: event.time,
        sample: null,
        route: null,
      }
    case 'assistant/attempt': {
      if (state.phase !== 'open' || state.turn !== event.data.turn || state.step !== event.data.step) return state
      const sample = streamSample(event.data.stream) ?? state.sample
      // attempt 事件不带 message，也就没有路由；留给 lastRoute 兜底。
      return closeAttempt({ ...state, phase: 'finishClosed', sample, route: null }, options, event.time)
    }
    case 'assistant/message':
      return applyMessage(state, event, options)
    case 'llm/retry': {
      if (state.phase === 'idle' || state.turn !== event.data.turn || state.step !== event.data.step) return state
      const closed = state.phase === 'open' ? closeAttempt(state, options, event.time) : state
      const code = event.data?.failure?.code
      const failed = typeof code === 'string' && BILLED_FAILURE_CODES.includes(code)
        ? { ...closed.failed, [`${event.data.turn}/${event.data.step}`]: { at: event.time, code } }
        : closed.failed
      return { ...closed, phase: 'settled', by: 'retry', sample: null, route: null, failed }
    }
    case 'llm/retry-started': {
      if (state.phase !== 'settled' || state.by !== 'retry'
        || state.turn !== event.data.turn || state.step !== event.data.step) return state
      // 重试是一次全新的请求：清空样本，并按重试发起的时刻重新判定峰谷。
      return { ...state, phase: 'open', by: '', time: event.time, sample: null, route: null }
    }
    case 'step/end': {
      if (state.phase === 'idle') return state
      if (state.turn !== event.data.turn || state.step !== event.data.step) {
        return { ...state, phase: 'idle', turn: -1, step: -1, by: '', sample: null, route: null }
      }
      const closed = state.phase === 'open' ? closeAttempt(state, options, event.time) : state
      return { ...closed, phase: 'idle', turn: -1, step: -1, by: '', sample: null, route: null, failed: {} }
    }
    default:
      return state
  }
}

const bucketsSchema = object({
  uncachedInputTokens: int(),
  outputTokens: int(),
  cacheReadTokens: int(),
  cacheWriteTokens: int(),
})

const turnCostSchema = object({
  micros: int(),
  unpricedTokens: int(),
})

const stateSchema = object({
  phase: str(),
  turn: signedInt(),
  step: signedInt(),
  by: str(),
  time: int(),
  sample: nullable(bucketsSchema),
  route: nullable(object({ provider: str(), model: str() })),
  lastRoute: nullable(object({ provider: str(), model: str() })),
  micros: int(),
  unpricedTokens: int(),
  estimatedMicros: int(),
  estimatedRequests: int(),
  failed: record(object({ at: int(), code: str() })),
  turns: record(turnCostSchema),
  messages: record(int()),
})

const viewSchema = object({
  micros: int(),
  unpricedTokens: int(),
  estimatedMicros: int(),
  estimatedRequests: int(),
  currency: str(),
  turns: record(turnCostSchema),
  messages: record(int()),
})

/**
 * 构造 `sessionCost` 投影 unit。
 *
 * wire view 的 `turns` / `messages` 直接复用 state 里的对象引用（不复制），
 * 代价是它们必须被当作只读——框架只把它们序列化下发，不会改写。
 *
 * @param options - {@link resolvePricingOptions} 的结果。
 * @returns 可交给 `ctx.sessionProjections.register()` 的投影定义。
 */
export function createSessionCostProjection(options) {
  return {
    key: PROJECTION_KEY,
    stateVersion: 2,
    stateSchema,
    init: () => initialState(),
    apply: (state, event) => foldSessionCost(state, event, options),
    wire: {
      viewSchema,
      view: (state) => ({
        micros: state.micros,
        unpricedTokens: state.unpricedTokens,
        estimatedMicros: state.estimatedMicros,
        estimatedRequests: state.estimatedRequests,
        currency: options.currency,
        turns: state.turns,
        messages: state.messages,
      }),
    },
  }
}

/**
 * 注册 `sessionCost` 投影。
 *
 * 注册是挂在本 fiber 上的 effect，插件卸载即撤下该键；客户端读不到键时会
 * 自行隐藏这两个数字，不需要额外的开关。
 *
 * @param ctx - Cordis 上下文。
 * @param config - 解析后的插件配置。
 */
export function apply(ctx, config) {
  const options = resolvePricingOptions(config ?? {})
  ctx.sessionProjections.register(createSessionCostProjection(options))
}
