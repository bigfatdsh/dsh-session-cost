/**
 * 投影 schema：一份不依赖任何第三方包的「只实现 `parse`」校验器。
 *
 * ## 为什么不用 zod
 *
 * `ctx.sessionProjections.register()` 只对 schema 调用 `.parse()`（见
 * `@deepseek-ai/dsh-session-projection` 的 `snapshot` / `viewCell` / `drive`），
 * 所以运行期契约就是「有个 parse 方法」。
 *
 * 而 zod 在这个位置并不可靠：profile 侧插件是符号链接进
 * `~/.dsh/profiles/<profile>/node_modules/` 的，Node 按真实路径解析依赖，
 * 于是 `zod`（只存在于 profile 根或 app.asar 内）在插件自身目录下可能解析不到。
 * Config 用不上 zod 只是少一层校验（Cordis 会跳过），但**投影 stateSchema 是
 * 恢复持久化缓存时的唯一防线**——它必须永远可用，所以这里自带一份。
 *
 * 校验是严格的：未知字段、类型不符、越界都会抛错。这样一行来自旧版本或被改坏的
 * 缓存行会被判为不可用并触发重放，而不是静默地算出一个错的金额。
 *
 * @module dsh-session-cost/schema
 */

/** 构造一条带路径的校验错误。 */
function invalid(path, expected, value) {
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  return new TypeError(`session-cost schema: ${path} must be ${expected}, received ${actual}`)
}

/** 非负整数。 */
export function int() {
  return {
    parse(value, path = '$') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid(path, 'a non-negative safe integer', value)
      return value
    },
  }
}

/** 允许为负的安全整数（未归位时的 turn/step 用 -1 表示「不在任何一轮/一步里」）。 */
export function signedInt() {
  return {
    parse(value, path = '$') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalid(path, 'a safe integer', value)
      return value
    },
  }
}

/** 有限数字。 */
export function num() {
  return {
    parse(value, path = '$') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(path, 'a finite number', value)
      return value
    },
  }
}

/** 字符串。 */
export function str() {
  return {
    parse(value, path = '$') {
      if (typeof value !== 'string') throw invalid(path, 'a string', value)
      return value
    },
  }
}

/** 布尔值。 */
export function bool() {
  return {
    parse(value, path = '$') {
      if (typeof value !== 'boolean') throw invalid(path, 'a boolean', value)
      return value
    },
  }
}

/** 允许缺省（undefined）的可选包装。 */
export function optional(inner) {
  return {
    parse(value, path = '$') {
      return value === undefined ? undefined : inner.parse(value, path)
    },
  }
}

/** 同一个 schema 允许 null。 */
export function nullable(inner) {
  return {
    parse(value, path = '$') {
      return value === null ? null : inner.parse(value, path)
    },
  }
}

/**
 * 对象：**逐字段校验**,返回一个只含声明字段的新对象（未知字段一律拒绝）。
 *
 * 返回新对象是刻意的：投影 state 是不可变值，恢复缓存时若把外部对象直接当成
 * state 使用，缓存行里的额外/原型字段就可能渗进后续 fold。
 */
export function object(shape) {
  const keys = Object.keys(shape)
  return {
    parse(value, path = '$') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(path, 'an object', value)
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(shape, key)) throw new TypeError(`session-cost schema: ${path}.${key} is not a declared field`)
      }
      const out = {}
      for (const key of keys) {
        const field = shape[key]
        const parsed = field.parse(value[key], `${path}.${key}`)
        if (parsed !== undefined) out[key] = parsed
      }
      return out
    },
  }
}

/** 字典：键为字符串，值为同一 schema（金额表、消息索引都用它）。 */
export function record(inner) {
  return {
    parse(value, path = '$') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(path, 'an object', value)
      const out = {}
      for (const key of Object.keys(value)) {
        out[key] = inner.parse(value[key], `${path}[${JSON.stringify(key)}]`)
      }
      return out
    },
  }
}
