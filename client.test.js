/**
 * dsh-session-cost 浏览器半边的测试。
 *
 * `client.js` 是手写的 `window.__ModuleLoader__.load({...})` bundle，没有构建步骤
 * 替它把关，所以这里用一个最小的 React / ModuleLoader / document 桩把它真的加载
 * 一遍，再直接调用注册进去的组件函数，对渲染出的元素树做断言。
 *
 * 两个组件都不使用 React 状态（只读投影），因此可以当普通函数调用——这也是这层
 * 测试能成立的前提。
 *
 * 运行：node --test client.test.js
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** 最小的 createElement：把元素树变成普通对象，便于断言。 */
function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children }
}

/** 把元素树里所有字符串叶子按顺序收集起来。 */
function textOf(node) {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || typeof node !== 'object') return ''
  return textOf(node.children)
}

/** 按 className 在元素树里找第一个匹配节点。 */
function findByClass(node, className) {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByClass(child, className)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof node.props?.className === 'string' && node.props.className.split(' ').includes(className)) return node
  return findByClass(node.children, className)
}

/**
 * 在受控的全局环境里加载 client.js。
 *
 * 桩的形状对齐真实的 slot 服务：`ctx.slots.inject(key, callback)` 调用
 * `callback()`，而 callback 闭包捕获 `ctx` 并调用 `ctx.slots.register(options, Component)`。
 *
 * @returns `{ exports, dictionaries, registrations, styleNodes }`。
 */
function loadClient() {
  const dictionaries = []
  const registrations = []
  const styleNodes = []
  const document = {
    head: { append(node) { styleNodes.push(node) } },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
  }
  const ctx = {
    effect: (callback) => {
      callback()
      return () => {}
    },
    locale: {
      register: (ns, dicts) => {
        dictionaries.push({ ns, dicts })
        return () => {}
      },
    },
    slots: {
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
      inject: (key, callback) => {
        callback()
        return () => {}
      },
    },
  }
  const pending = []
  const window = { __ModuleLoader__: { load: (registration) => pending.push(registration) } }
  const require = (specifier) => {
    if (specifier === 'react') return { createElement }
    throw new Error(`client.js 不应 require ${specifier}`)
  }
  // bundle 只依赖 window / document / require，因此可以在受控环境里直接求值。
  new Function('window', 'document', 'require', readFileSync(join(here, 'client.js'), 'utf8'))(window, document, require)
  assert.equal(pending.length, 1, 'client.js 应当恰好注册一个模块')
  assert.equal(pending[0].id, 'dsh-session-cost')
  const exports = pending[0].factory(require)
  exports.apply(ctx)
  return { exports, dictionaries, registrations, styleNodes }
}

const { exports: client, dictionaries, registrations, styleNodes } = loadClient()

/** 取某个 slot 的注册项。 */
function entryOf(name) {
  const entry = registrations.find((item) => item.options.name === name)
  assert.ok(entry !== undefined, `应当注册 ${name}`)
  return entry
}

/** 逐字复刻界面插值的 t 桩。 */
function translator(dict) {
  return (key, params) => String(dict[key]).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? `{${name}}`))
}

const zh = dictionaries[0].dicts.zh
const en = dictionaries[0].dicts.en
const t = translator(zh)

/** 只回固定投影值的 useProjection 桩。 */
function projectionHook(view) {
  return (key) => {
    assert.equal(key, 'sessionCost')
    return view
  }
}

/** 造一个投影值。 */
function viewOf({ micros = 0, unpricedTokens = 0, currency = 'CNY', turns = {}, messages = {} } = {}) {
  return { micros, unpricedTokens, currency, turns, messages }
}

const SessionPill = entryOf('conversation.composer.dock').component
const TurnPill = entryOf('conversation.chat.assistant-actions').component

describe('client bundle', () => {
  test('导出 apply / inject，并声明依赖 slots 与 locale', () => {
    assert.equal(typeof client.apply, 'function')
    assert.deepEqual(client.inject, ['slots', 'locale'])
  })

  test('注册中英文字典，且两份键集合一致', () => {
    assert.equal(dictionaries.length, 1)
    assert.equal(dictionaries[0].ns, 'session-cost')
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  })

  test('注入样式表', () => {
    assert.equal(styleNodes.length, 1)
    assert.match(styleNodes[0].textContent, /\.dsh-cost-pill/)
    assert.match(styleNodes[0].textContent, /\.dsh-cost-action/)
  })

  test('两个 slot 注册项齐备，且带 locale 与 order', () => {
    assert.equal(registrations.length, 2)
    for (const { options } of registrations) {
      assert.equal(options.locale, 'session-cost')
      assert.equal(options.id, 'session-cost')
      assert.equal(typeof options.order, 'number')
    }
    // 内置 stats 胶囊 order 为 0，本入口排在它右边。
    assert.ok(entryOf('conversation.composer.dock').options.order > 0)
  })
})

describe('样式（两个曾经踩过的坑）', () => {
  const css = styleNodes[0].textContent

  /** 取出一个选择器的声明块。 */
  function blockOf(selector) {
    const index = css.indexOf(`${selector} {`)
    assert.ok(index >= 0, `样式里应当有 ${selector}`)
    const end = css.indexOf('}', index)
    return css.slice(index + selector.length + 2, end)
  }

  test('输入框胶囊自己声明字号与行高，不靠继承', () => {
    // dock 那一行不设 font-size，继承下来是正文的 14px，而内置胶囊
    // （StatsPills 根节点）把字号降到了 secondary - 1px。少了这两条，本插件
    // 就会明显比旁边大一号。
    const block = blockOf('.dsh-cost-pill')
    assert.match(block, /font-size:\s*calc\(var\(--dsh-content-font-size-secondary,\s*13px\)\s*-\s*1px\)/)
    assert.match(block, /line-height:\s*calc\(20px\s*\+\s*var\(--dsh-content-font-delta-secondary,\s*0px\)\)/)
    assert.doesNotMatch(block, /font:\s*inherit/, 'font 简写会盖掉上面写死的字号')
  })

  test('胶囊与内置 StatsPills 的字号公式逐字相同', () => {
    // 内置值：.OpZ85W_root{font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px)}
    assert.match(css, /font-size:\s*calc\(var\(--dsh-content-font-size-secondary, ?13px\) - 1px\)/)
  })

  test('本轮花费用 flex order 挪到动作行右端', () => {
    // 插槽只给了 extraActions 这个位置，DOM 顺序上排在「用量」前面；
    // order 是唯一能把它推到右侧的杠杆。
    assert.match(blockOf('.dsh-cost-action'), /order:\s*8/)
  })

  test('再把花费插进「用量」与时间之间，且带降级', () => {
    assert.match(css, /\[data-turn-tail\] \[class\*='_endInfo'\]\s*\{\s*display:\s*contents/)
    assert.match(css, /\[data-turn-tail\] \[class\*='_timeEnd'\]\s*\{[^}]*order:\s*9/)
    // 摊平容器后时间不再继承 tertiary 色，必须补回来。
    assert.match(css, /\[data-turn-tail\] \[class\*='_timeEnd'\][^}]*color:\s*var\(--dsw-alias-label-tertiary\)/)
  })

  test('选择器只用 CSS Modules 名字的稳定半边', () => {
    // 哈希前缀随构建变，源码类名那半边才稳定；整段里不应出现具体哈希。
    assert.doesNotMatch(css, /\.[A-Za-z0-9_-]{6}_endInfo/)
    assert.doesNotMatch(css, /\.[A-Za-z0-9_-]{6}_timeEnd/)
  })
})

describe('SessionCostPill', () => {
  test('投影缺失时不渲染', () => {
    assert.equal(SessionPill({ useProjection: projectionHook(undefined), t }), null)
  })

  test('会话还没有任何用量时不渲染', () => {
    assert.equal(SessionPill({ useProjection: projectionHook(viewOf()), t }), null)
  })

  test('渲染币种符号、标签与金额', () => {
    const tree = SessionPill({ useProjection: projectionHook(viewOf({ micros: 12_345_678 })), t })
    assert.equal(findByClass(tree, 'dsh-cost-sym').children[0], '¥')
    assert.equal(textOf(tree), '¥本会话 12.35')
  })

  test('金额精度随量级自适应', () => {
    const cases = [
      [12_345_678, '12.35'],
      [42_000, '0.042'],
      [1_234, '0.0012'],
      [1, '<0.0001'],
      [1_234_567_890, '1,234.57'],
    ]
    for (const [micros, expected] of cases) {
      const tree = SessionPill({ useProjection: projectionHook(viewOf({ micros })), t })
      assert.match(textOf(tree), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${micros} 微元应显示为 ${expected}`)
    }
  })

  test('有未计价 token 时加「+」并把数量写进提示', () => {
    const tree = SessionPill({
      useProjection: projectionHook(viewOf({ micros: 1_000_000, unpricedTokens: 2345 })),
      t,
    })
    assert.match(textOf(tree), /\+/)
    assert.match(tree.props.title, /2,345 token 未计价/)
  })

  test('美元等其他币种使用各自的符号', () => {
    const tree = SessionPill({ useProjection: projectionHook(viewOf({ micros: 2_000_000, currency: 'USD' })), t })
    assert.equal(findByClass(tree, 'dsh-cost-sym').children[0], '$')
  })

  test('英文词典渲染英文标签', () => {
    const tree = SessionPill({ useProjection: projectionHook(viewOf({ micros: 12_345_678 })), t: translator(en) })
    assert.equal(textOf(tree), '¥Session 12.35')
  })
})

describe('TurnCostPill', () => {
  const view = viewOf({
    micros: 12_000_000,
    turns: { 3: { micros: 420_000, unpricedTokens: 0 }, 4: { micros: 8_000, unpricedTokens: 0 } },
    messages: { 'msg-c': 3, 'msg-d': 4 },
  })

  test('messageId 未知时不渲染', () => {
    assert.equal(TurnPill({ messageId: 'nope', useProjection: projectionHook(view), t }), null)
  })

  test('投影缺失时不渲染', () => {
    assert.equal(TurnPill({ messageId: 'msg-c', useProjection: projectionHook(undefined), t }), null)
  })

  test('按 messageId 反查轮次并显示该轮金额', () => {
    const tree = TurnPill({ messageId: 'msg-c', useProjection: projectionHook(view), t })
    assert.equal(textOf(tree), '¥花费 0.42')
    assert.equal(tree.props['data-turn-cost'], 3)
    assert.match(tree.props.title, /本轮花费 ¥0.42/)
  })

  test('同一会话里不同轮次显示各自的金额', () => {
    const tree = TurnPill({ messageId: 'msg-d', useProjection: projectionHook(view), t })
    assert.equal(textOf(tree), '¥花费 0.008')
    assert.equal(tree.props['data-turn-cost'], 4)
  })

  test('该轮金额为 0 时不渲染', () => {
    const zero = viewOf({ turns: { 1: { micros: 0, unpricedTokens: 0 } }, messages: { m: 1 } })
    assert.equal(TurnPill({ messageId: 'm', useProjection: projectionHook(zero), t }), null)
  })

  test('该轮全是未计价 token 时仍然渲染并标注', () => {
    const unpriced = viewOf({ turns: { 1: { micros: 0, unpricedTokens: 500 } }, messages: { m: 1 } })
    const tree = TurnPill({ messageId: 'm', useProjection: projectionHook(unpriced), t })
    assert.equal(textOf(tree), '¥花费 0+')
    assert.match(tree.props.title, /500 token 未计价/)
  })
})
