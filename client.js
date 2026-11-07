/**
 * dsh-session-cost —— 浏览器半边。
 *
 * 两个入口，都只做展示，不做任何计算：金额由 Host 的 `sessionCost` 会话投影
 * 算好并同步过来，这里只负责排版。
 *
 * 1. `conversation.composer.dock`（输入框下方）—— 本会话累计花费，
 *    与内置的「token 用量 · 缓存命中」是同一行的兄弟节点。
 * 2. `conversation.chat.assistant-actions`（每条回复的动作行）—— 本轮花费，
 *    与内置的「用量 N tok」在同一行。该入口的 owner prop 只有 `messageId`，
 *    所以先用投影里的 `messages` 索引反查轮次，再取该轮的金额。
 *
 * ## 为什么是手写的 bundle
 *
 * DSH 的客户端插件按 `exports["./client"]` 取文件，内容必须是
 * `window.__ModuleLoader__.load({ id, factory })` 形式。手写这个包裹（而不是走
 * 构建产物）在本 profile 里已有先例（`dsh-orb/client.js`），并且让插件保持
 * 「零依赖、零构建」：只需要 `require('react')`，它是启动期的平台种子模块。
 *
 * @module dsh-session-cost/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-cost',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    /** createElement 的短别名；本文件刻意不用 JSX，免去构建步骤。 */
    const h = React.createElement

    /** 字典命名空间，同时作为 slot 注册的 `locale` 字段。 */
    const NS = 'session-cost'

    /** 投影键，必须与 Host 侧 `PROJECTION_KEY` 一致。 */
    const PROJECTION_KEY = 'sessionCost'

    /** 中文文案。 */
    const zh = {
      'cost.session': '本会话 {amount}',
      'cost.sessionTitle': '本会话累计花费 {amount}',
      'cost.turn': '花费 {amount}',
      'cost.turnTitle': '本轮花费 {amount}',
      'cost.unpriced': '另有 {tokens} token 未计价：该模型不在价目表中，实际花费只会更高。',
      'cost.estimated': '其中 {count} 次失败重试按输入估算（{amount}）：这些请求服务端已计费，但会话里没有 usage，金额是保守下限估算。',
      'cost.peak': '按 DeepSeek 官方峰谷分时价目表计算，高峰时段单价翻倍。',
    }

    /** English copy, keyed against the Chinese set. */
    const en = {
      'cost.session': 'Session {amount}',
      'cost.sessionTitle': 'Session total {amount}',
      'cost.turn': 'Cost {amount}',
      'cost.turnTitle': 'This turn {amount}',
      'cost.unpriced': '{tokens} more tokens are unpriced: that model is not in the price table, so the real cost is higher.',
      'cost.estimated': '{count} failed retries are estimated from their input ({amount}): the server billed them but no usage was recorded, so this is a conservative lower bound.',
      'cost.peak': 'Priced with DeepSeek\'s peak/off-peak table; peak hours cost double.',
    }

    /**
     * 视觉规格逐条对齐内置胶囊（`StatsPills` / `TurnUsagePanel` 的 CSS）：
     * 同样的圆角、字号、行高、gap 与 14px 图标盒，所以并排时不显得是外来的。
     */
    const style = `
/* 币种符号充当内置胶囊里的 14px 图标位；字号跟着内容字号设置缩放。 */
.dsh-cost-sym {
  flex: none;
  width: 14px;
  text-align: center;
  font-size: 1.1em;
  line-height: 1;
  opacity: .9;
}
/*
 * 输入框下方那枚胶囊。
 *
 * 字号与行高必须**自己写死**，不能继承：dock 那一行本身不设 font-size，
 * 继承下来的是正文的 14px；而内置胶囊 StatsPills 在自己根节点上把字号降到
 * 了 secondary - 1px（约 12px）。不照抄这三个值，本插件就会明显比旁边大一号。
 */
.dsh-cost-pill {
  box-sizing: border-box;
  corner-shape: round;
  max-width: 100%;
  color: var(--dsw-alias-label-tertiary);
  font-family: inherit;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  font-variant-numeric: tabular-nums;
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  white-space: nowrap;
  background: 0 0;
  border: none;
  border-radius: 999px;
  align-items: center;
  gap: 6px;
  padding: 1px 8px;
  display: inline-flex;
}
.dsh-cost-pill:hover {
  color: var(--dsw-alias-label-secondary);
}
.dsh-cost-label {
  text-overflow: ellipsis;
  min-width: 0;
  overflow: hidden;
}
/*
 * 回复动作行里的「本轮花费」。尺寸逐条对齐内置的 TurnUsagePanel。
 *
 * order: 8 是把它挪到动作行右端的那根主杠杆：动作行的 DOM 顺序是
 *   复制 → extraActions（本插件所在的位置）→ 反馈 → 分支 → 用量
 * 也就是插件天然排在「用量」**前面**。flex 的 order 只对本元素生效，把它推到
 * 末尾，至少能落进右侧那一簇，而不是夹在左边的图标中间。
 * 下面是把它进一步插到「用量」与时间之间的细化，见 [data-turn-tail] 规则。
 */
.dsh-cost-action {
  order: 8;
  min-width: 0;
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-tertiary);
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  font-variant-numeric: tabular-nums;
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  white-space: nowrap;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  display: inline-flex;
}
/*
 * 「用量 N tok」与时间被包在同一个 span 里，所以光靠 order 只能排到那一簇的
 * 右边（变成 用量 · 时间 · 花费）。display: contents 把这个容器摊平，让两者
 * 成为动作行的直接 flex item，再给时间一个更大的 order，就得到
 *   用量(0) → 花费(8) → 时间(9)
 * 也就是真正贴着「用量」。
 *
 * 选择器用 CSS Modules 类名的稳定半边：<hash>_endInfo 的哈希随构建变，
 * _endInfo / _timeEnd 来自源码里的类名，跨构建稳定。上游改名时这两条规则
 * 只是不生效，上面的 order: 8 仍然兜住位置，不会显示错乱。
 */
[data-turn-tail] [class*='_endInfo'] { display: contents; }
[data-turn-tail] [class*='_timeEnd'] {
  order: 9;
  /* 这两条原本由被摊平的容器提供，补回来才能保住窄窗口下的省略收缩与配色 */
  min-width: 0;
  color: var(--dsw-alias-label-tertiary);
}
@media (width <= 480px) {
  .dsh-cost-label { display: none; }
}
`

    /** 各币种的显示符号；未列出的币种退回三字母代码。 */
    const SYMBOLS = { CNY: '¥', RMB: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥', HKD: 'HK$' }

    /** 取币种符号（未知币种带一个尾随空格，避免与数字粘连）。 */
    function symbolOf(currency) {
      const code = typeof currency === 'string' ? currency.toUpperCase() : 'CNY'
      return Object.prototype.hasOwnProperty.call(SYMBOLS, code) ? SYMBOLS[code] : `${code} `
    }

    /**
     * 去掉超出「金额最少两位小数」的尾零。
     *
     * 精度是按量级选的上限（`0.42` 用三位、`0.008` 用四位），直接用 `toFixed`
     * 会显示成 `0.420` / `0.0080`。金额习惯保留两位，所以只从第三位起裁尾零。
     *
     * @param text - `toFixed` 的结果。
     * @param minDecimals - 至少保留的小数位。
     */
    function trimZeros(text, minDecimals) {
      const dot = text.indexOf('.')
      if (dot === -1) return text
      let end = text.length
      while (end - dot - 1 > minDecimals && text[end - 1] === '0') end -= 1
      return text.slice(0, end)
    }

    /**
     * 微元 → 显示用金额（不含币种符号）。
     *
     * 精度随量级自适应：一次普通请求常在千分之几元，会话总额常在几元到几十元，
     * 用同一个精度不是看不见就是太啰嗦。千分位用半角逗号，与界面内置的
     * `number.groupSeparator` 一致。
     *
     * @param micros - 整数微元。
     * @returns 形如 `12.35`、`0.42`、`0.008`、`<0.0001` 的文本。
     */
    function formatAmount(micros) {
      const value = micros / 1e6
      if (!(value > 0)) return '0'
      const decimals = value >= 1 ? 2 : value >= 0.01 ? 3 : 4
      const fixed = value.toFixed(decimals)
      if (Number(fixed) === 0) return `<${(10 ** -decimals).toFixed(decimals)}`
      const [whole, fraction] = trimZeros(fixed, 2).split('.')
      const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      return fraction === undefined ? grouped : `${grouped}.${fraction}`
    }

    /** 大数字加千分位（用于「未计价 token」的说明文字）。 */
    function formatCount(value) {
      return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /**
     * 拼装 title 提示：金额口径 + 未计价说明 + 峰谷口径说明。
     *
     * 用原生 `title` 而不是内置的 Tooltip 组件，是为了不 require
     * `@deepseek-ai/dsh-client-ui-primitives`——那会把插件绑到另一个包的构建产物上。
     *
     * @param t - 本命名空间的翻译函数。
     * @param baseKey - `cost.sessionTitle` 或 `cost.turnTitle`。
     * @param amount - 已带币种符号的金额文本。
     * @param unpricedTokens - 该范围的未计价 token 数。
     */
    function titleOf(t, baseKey, amount, unpricedTokens, estimate) {
      let text = t(baseKey, { amount })
      if (unpricedTokens > 0) text += `\n${t('cost.unpriced', { tokens: formatCount(unpricedTokens) })}`
      if (estimate !== undefined && estimate.count > 0) {
        text += `\n${t('cost.estimated', {
          count: formatCount(estimate.count),
          amount: `${symbolOf(estimate.currency)}${formatAmount(estimate.micros)}`,
        })}`
      }
      return `${text}\n${t('cost.peak')}`
    }

    /**
     * 币种符号 + 文案，两个入口共用的「钱」的可视单位。
     *
     * 币种符号充当图标位（内置胶囊这里是 14px 的 SVG），因此**文案里的金额不带
     * 符号**，否则会显示两次。
     *
     * @param currency - ISO 币种代码。
     * @param label - 已经不含币种符号的正文。
     */
    function amountGlyph(currency, label) {
      return [
        h('span', { className: 'dsh-cost-sym', key: 'sym', 'aria-hidden': true }, symbolOf(currency)),
        h('span', { className: 'dsh-cost-label', key: 'label' }, label),
      ]
    }

    /**
     * 输入框下方的「本会话累计花费」胶囊。
     *
     * `useProjection` 是会话作用域 slot 自带的标准 hook（由 `dsh-client-ui-session`
     * 的绑定提供），投影键不存在或本会话还没有任何计费请求时返回 undefined。
     *
     * @param props - slot 注入的 { useProjection, t }。
     */
    function SessionCostPill({ useProjection, t }) {
      const view = useProjection(PROJECTION_KEY)
      if (view === undefined || view === null) return null
      const { micros, unpricedTokens, estimatedMicros = 0, estimatedRequests = 0, currency } = view
      if (micros === 0 && unpricedTokens === 0) return null
      const digits = `${formatAmount(micros)}${unpricedTokens > 0 ? '+' : ''}`
      const estimate = estimatedRequests > 0 ? { count: estimatedRequests, micros: estimatedMicros, currency } : undefined
      return h(
        'span',
        {
          className: 'dsh-cost-pill',
          'data-session-cost': true,
          title: titleOf(t, 'cost.sessionTitle', `${symbolOf(currency)}${digits}`, unpricedTokens, estimate),
        },
        amountGlyph(currency, t('cost.session', { amount: digits })),
      )
    }

    /**
     * 每条回复动作行里的「本轮花费」。
     *
     * owner prop 只有 `messageId`，所以先用投影的 `messages` 索引换算出轮次号，
     * 再读该轮的金额。映射还没同步到（例如历史窗口刚载入）时整块不渲染，宁可
     * 晚一点出现，也不显示一个错的数。
     *
     * @param props - slot 注入的 { messageId, useProjection, t }。
     */
    function TurnCostPill({ messageId, useProjection, t }) {
      const view = useProjection(PROJECTION_KEY)
      if (view === undefined || view === null) return null
      const turn = view.messages === undefined ? undefined : view.messages[messageId]
      if (turn === undefined) return null
      const entry = view.turns === undefined ? undefined : view.turns[String(turn)]
      if (entry === undefined || (entry.micros === 0 && entry.unpricedTokens === 0)) return null
      const currency = view.currency
      const digits = `${formatAmount(entry.micros)}${entry.unpricedTokens > 0 ? '+' : ''}`
      return h(
        'span',
        {
          className: 'dsh-cost-action',
          'data-turn-cost': turn,
          title: titleOf(t, 'cost.turnTitle', `${symbolOf(currency)}${digits}`, entry.unpricedTokens),
        },
        amountGlyph(currency, t('cost.turn', { amount: digits })),
      )
    }

    /** 需要的服务：slot 注册表与字典注册表。 */
    const inject = ['slots', 'locale']

    /**
     * 客户端插件主体：注册字典与两个 slot 入口。
     *
     * @param ctx - 客户端根上下文。
     */
    function apply(ctx) {
      if (typeof document !== 'undefined' && document.getElementById('dsh-session-cost-style') === null) {
        const node = document.createElement('style')
        node.id = 'dsh-session-cost-style'
        node.textContent = style
        document.head.append(node)
      }
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-cost: dictionaries')
      // order 10：内置的 stats 胶囊是 0，本入口排在它右侧，与「token 用量 · 缓存命中」相邻。
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'session-cost',
        order: 10,
        locale: NS,
      }, SessionCostPill))
      // order 5：内置反馈入口是 10，本入口在它左边，紧挨「用量 N tok」所在的动作行。
      ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
        name: 'conversation.chat.assistant-actions',
        id: 'session-cost',
        order: 5,
        locale: NS,
      }, TurnCostPill))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
