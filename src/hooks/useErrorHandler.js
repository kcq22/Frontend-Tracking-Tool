// useErrorHandler(options) -> 返回一个 ErrorHandler 实例
// 设计目标：
// - 实例化（每个 tracker 一个实例）避免模块级全局污染
// - 可配置：去重间隔、速率限制、最大缓存数、debug 等
// - 提供 setup() / teardown() / reportJsError() / getVueErrorHandler() 接口
// - 防守式编程（对外部依赖如 trackSelfDescribingEvent、getRequestId 做容错）
// - 轻量、不引入额外库

import { trackSelfDescribingEvent } from '@snowplow/browser-tracker'
import { getRequestId } from '../utils/index' // 你的工具函数（可能抛异常，内部做了保护）

/**
 * options:
 *  - jsErrorSchema: 字符串，默认 null（上报时使用的 schema）
 *  - resourceErrorSchema: 资源错误的 schema
 *  - dedupIntervalMs: 去重时间窗，默认 60s
 *  - rateLimitPerMinute: 整体速率限制（条/分钟），默认 300
 *  - maxRecentErrors: recentErrors Map 的最大大小，用于内存控制，默认 2000
 *  - debug: 是否启用 debug 日志
 *  - swallowErrors: window.onerror 包装器是否吞掉错误（返回 true，默认 false）
 */

const DEFAULT_MAX_RECENT_ERRORS = 500
const DEFAULT_STRING_LIMIT = 500
export function useErrorHandler(options = {}) {
  // 合并默认配置，保证每个字段都有定义
  const cfg = {
    jsErrorSchema: null,
    resourceErrorSchema: null,
    dedupIntervalMs: 60 * 1000,
    rateLimitPerMinute: 300,
    maxRecentErrors: DEFAULT_MAX_RECENT_ERRORS,
    debug: false,
    swallowErrors: false,
    ...options
  }

  // ====== 规范化配置 ======
  cfg.dedupIntervalMs = Number.isFinite(cfg.dedupIntervalMs) && cfg.dedupIntervalMs > 0 ? Number(cfg.dedupIntervalMs) : 60 * 1000
  // rateLimitPerMinute: 如果用户想要无限上报，允许设置为 Infinity；若传 0 或负数，认为是禁用上报（这里我们用 Infinity 避免误配置）
  cfg.rateLimitPerMinute = Number.isFinite(cfg.rateLimitPerMinute) && cfg.rateLimitPerMinute > 0 ? Number(cfg.rateLimitPerMinute) : Infinity
  // maxRecentErrors 最小为 100，避免误配导致频繁 prune
  cfg.maxRecentErrors = Math.max(100, Number.isFinite(cfg.maxRecentErrors) ? Number(cfg.maxRecentErrors) : DEFAULT_MAX_RECENT_ERRORS)

  // safeLog: 受控的 debug 输出封装（避免在没有 console 的环境异常）
  function safeLog(...args) {
    if (cfg.debug && typeof console !== 'undefined' && console.debug) {
      try {
        console.debug('[ErrorHandler]', ...args)
      } catch (e) { /* 忽略控制台异常 */
      }
    }
  }

  // safeStringify: 尝试安全地把对象转为字符串（避免循环引用崩溃）
  // 如果 stringify 失败，会退回取 message 或 String(obj)
  function safeStringify(obj, maxLen = 1000) {
    try {
      const s = typeof obj === 'string' ? obj : JSON.stringify(obj)
      return (typeof s === 'string' && s.length > maxLen) ? s.slice(0, maxLen) + '…' : s
    } catch (e) {
      try {
        if (obj && obj.message) return String(obj.message).slice(0, maxLen)
        return String(obj).slice(0, maxLen)
      } catch (ee) {
        return '<<unserializable>>'
      }
    }
  }

  // safeGetRequestId: 调用外部 getRequestId，但做 try/catch 保护（防止抛错影响上报）
  function safeGetRequestId() {
    try {
      return getRequestId()
    } catch (e) {
      return null
    }
  }

  // normalizeString: 将可能是对象/数组/错误堆栈等值规范化为长度受限的字符串
  function normalizeString(s, limit = DEFAULT_STRING_LIMIT) {
    if (!s) return null
    try {
      const str = typeof s === 'string' ? s : safeStringify(s, limit)
      return str.length > limit ? str.slice(0, limit) : str
    } catch {
      return null
    }
  }

  // extractMessageFromErr: 从错误对象中抽取 message 字段（尽量友好）
  function extractMessageFromErr(err) {
    if (!err) return 'UnknownError'
    if (typeof err === 'string') return err
    if (err.message) return err.message
    return safeStringify(err, 200)
  }

  // 实例级别内部状态（每个 handler 一个独立实例）
  const recentErrors = new Map() // key -> timestamp(ms)，用于去重
  let windowStart = Date.now()   // 速率计数窗口起点
  let countInWindow = 0          // 当前窗口内累计数

  // 保存原 window.onerror（可能为空），便于 teardown 时恢复
  let _origOnError = null
  let _installed = false
  // 绑定后的处理器引用，用于 removeEventListener
  let _boundWindowError = null
  let _boundUnhandledRejection = null
  let _boundOnErrorWrapper = null

  // pruneRecentErrors: opportunistic 清理 recentErrors，避免内存长期增长
  // 逻辑：移除超时条目，然后如果仍超限再移除最旧若干条
  function pruneRecentErrors() {
    try {
      if (recentErrors.size === 0) return
      const now = Date.now()
      // TTL：取 dedupIntervalMs  与 60s 最大值，避免过早清理
      const ttl = Math.max(cfg.dedupIntervalMs, 60 * 1000)
      for (const [k, ts] of recentErrors) {
        if (now - ts > ttl) recentErrors.delete(k)
        // 为了避免在一个循环中做过多 work，如果 map 很大，会继续循环，
        // 这里没有复杂限流，保持实现简单
      }
      // 如果仍然过大，按顺序移除最旧的键以保证上限
      if (recentErrors.size > cfg.maxRecentErrors) {
        const toRemove = recentErrors.size - cfg.maxRecentErrors
        const it = recentErrors.keys()
        for (let i = 0; i < toRemove; i++) {
          const k = it.next().value
          if (k === undefined) break
          recentErrors.delete(k)
        }
      }
    } catch (e) {
      // 永远不要因为清理逻辑导致上层崩溃
      safeLog('pruneRecentErrors failed', e)
    }
  }

  // shouldSendError: 去重 + 全局速率控制的核心函数
  // 返回 true 表示允许上报，false 表示丢弃
  function shouldSendError(key) {
    if (!key) key = 'unknown'
    try {
      const now = Date.now()
      // 固定窗口速率控制（每分钟计算一次）
      if (now - windowStart > 60_000) {
        windowStart = now
        countInWindow = 0
      }
      // 窗口内计数
      if (++countInWindow > cfg.rateLimitPerMinute) {
        safeLog('rate limit hit')
        return false
      }
      const last = recentErrors.get(key)
      if (last && (now - last) < (cfg.dedupIntervalMs || 0)) {
        safeLog('dedupe drop', key)
        return false
      }
      // 记录这次上报的时间
      recentErrors.set(key, now)
      // opportunistic prune：当 map 过大时进行清理
      if (recentErrors.size > cfg.maxRecentErrors) pruneRecentErrors()
      return true
    } catch (e) {
      // 如果内部逻辑异常，为了不丢掉重要错误，采取保守放行策略
      safeLog('shouldSendError internal failure', e)
      return true
    }
  }

  // buildPayload: 构造通用上报负载（加上 timestamp, requestId）
  function buildPayload(base) {
    return {
      timestamp: Date.now(),
      requestId: safeGetRequestId(),
      ...base
    }
  }

  // safeTrack: 调用 snowplow 的 trackSelfDescribingEvent 的保护封装
  // 如果 trackSelfDescribingEvent 不存在或抛错，catch 掉，避免中断主应用
  function safeTrack(schema, data) {
    try {
      if (typeof trackSelfDescribingEvent === 'function') {
        trackSelfDescribingEvent({ event: { schema: schema || 'no-schema', data } })
      } else {
        safeLog('trackSelfDescribingEvent not available; skipping event', schema, data && data.type)
      }
    } catch (e) {
      safeLog('trackSelfDescribingEvent threw', e)
    }
  }

  // reportJsError: 外部可调用的手动上报函数
  // 参数 err 支持 Error/object/string，meta 为额外上下文，jsErrorSchema 可覆盖实例配置
  function reportJsError(err, meta = {}, jsErrorSchema = null) {
    try {
      const message = extractMessageFromErr(err)
      const stack = normalizeString(err && (err.stack || err.stackTrace) || meta.stack || null)
      const key = `${message}|${(stack && stack.slice(0, 200)) || ''}`
      if (!shouldSendError(key)) return
      const payload = buildPayload({
        type: 'manual',
        message,
        stack,
        ...meta
      })
      safeTrack(jsErrorSchema || cfg.jsErrorSchema || 'no-schema', payload)
      if (cfg.debug) {
        try {
          console.error('[reportJsError]', payload)
        } catch (e) { /* ignore */
        }
      }
    } catch (e) {
      // 手动上报函数内部错误也不能抛出
      safeLog('reportJsError failed', e)
    }
  }

  // handleWindowErrorEvent: 处理 window 的 error 事件（包括资源错误和 JS 错误）
  // 兼容 ErrorEvent、或我们从 window.onerror 包装而来的人造对象
  function handleWindowErrorEvent(e) {
    try {
      // 1) 资源加载错误：event.target 存在 src 或 href（注意：此需 capture=true 来捕获到）
      const target = e && e.target
      if (target && (target.src || target.href)) {
        const url = target.src || target.href
        const tag = (target.tagName && String(target.tagName)) || 'unknown'
        const message = `ResourceError: ${tag} ${url}`
        const key = `resource|${tag}|${url}`
        if (!shouldSendError(key)) return
        const payload = buildPayload({
          type: 'resource',
          message,
          resourceUrl: url,
          tagName: tag
        })
        safeTrack(cfg.resourceErrorSchema || 'no-schema', payload)
        if (cfg.debug) {
          try {
            console.error('[resource error]', payload)
          } catch (err) { /* ignore */
          }
        }
        return
      }

      // 2) 普通 JS ErrorEvent / 由 onerror wrapper 传入的对象
      const message = (e && (e.message || (e.error && e.error.message))) || (typeof e === 'string' ? e : 'UnknownError')
      const stack = normalizeString(e && (e.error && e.error.stack) || e && e.stack || null)
      const key = `error|${message}|${(stack && stack.slice(0, 200)) || ''}`
      if (!shouldSendError(key)) return
      const payload = buildPayload({
        type: 'js',
        message,
        filename: e?.filename || (e?.error && e?.error?.fileName) || null,
        lineno: e?.lineno || null,
        colno: e?.colno || null,
        stack
      })
      safeTrack(cfg.jsErrorSchema || 'no-schema', payload)
      if (cfg.debug) {
        try {
          console.error('[window.error 捕获]', payload)
        } catch (err) { /* ignore */
        }
      }
    } catch (err) {
      safeLog('handleWindowErrorEvent failed', err)
    }
  }

  // handleUnhandledRejection: 处理 Promise 的 unhandledrejection 事件
  function handleUnhandledRejection(e) {
    try {
      const reason = e && e.reason
      const message = (reason && (reason.message || safeStringify(reason, 200))) || 'UnhandledRejection'
      const stack = normalizeString(reason && reason.stack)
      const key = `unhandledrejection|${message}|${(stack && stack.slice(0, 200)) || ''}`
      if (!shouldSendError(key)) return
      const payload = buildPayload({
        type: 'unhandledrejection',
        message,
        stack
      })
      safeTrack(cfg.jsErrorSchema || 'no-schema', payload)
      if (cfg.debug) {
        try {
          console.error('[unhandledrejection 捕获]', payload)
        } catch (err) { /* ignore */
        }
      }
    } catch (err) {
      safeLog('handleUnhandledRejection failed', err)
    }
  }

  // onErrorWrapper: 包装旧式 window.onerror 的适配器
  // 它既会把参数封成一个对象交给 handleWindowErrorEvent，也会调用原先的 window.onerror（若存在）
  function onErrorWrapper(message, source, lineno, colno, error) {
    try {
      handleWindowErrorEvent({ message, filename: source, lineno, colno, error })
    } catch (e) {
      safeLog('onErrorWrapper internal error', e)
    }
    try {
      if (typeof _origOnError === 'function') {
        try {
          _origOnError(message, source, lineno, colno, error)
        } catch (e) { /* 忽略原 onerror 内部异常 */
        }
      }
    } catch (e) { /* ignore */
    }
    // 如果配置 swallowErrors 为 true，则返回 true（表示阻止浏览器默认错误处理），否则返回 false
    return !!cfg.swallowErrors
  }

  // setup: 安装全局监听（error capture、unhandledrejection、替换 window.onerror）
  function setup() {
    try {
      if (typeof window === 'undefined') {
        safeLog('setup skipped: no window') // 在 SSR/非浏览器环境不安装
        return false
      }
      if (_installed) return true

      // 绑定具体函数引用，方便 teardown 时移除
      _boundWindowError = handleWindowErrorEvent
      _boundUnhandledRejection = handleUnhandledRejection
      _boundOnErrorWrapper = onErrorWrapper

      // 1) 资源错误需要 capture 阶段捕获
      window.addEventListener('error', _boundWindowError, true)
      // 2) promise 未处理的拒绝
      window.addEventListener('unhandledrejection', _boundUnhandledRejection)

      // 保存并替换原始 window.onerror
      try {
        _origOnError = window.onerror
      } catch (e) {
        _origOnError = null
      }
      try {
        window.onerror = _boundOnErrorWrapper
      } catch (e) {
        safeLog('set window.onerror failed', e)
      }

      _installed = true
      safeLog('error handler installed')
      return true
    } catch (e) {
      safeLog('setup failed', e)
      return false
    }
  }

  // teardown: 恢复原状态，移除监听并恢复原 onerror
  function teardown() {
    try {
      if (typeof window === 'undefined') return
      if (!_installed) return
      try {
        window.removeEventListener('error', _boundWindowError, true)
      } catch (e) { /* ignore */
      }
      try {
        window.removeEventListener('unhandledrejection', _boundUnhandledRejection)
      } catch (e) { /* ignore */
      }
      try {
        window.onerror = _origOnError
      } catch (e) { /* ignore */
      }
      // 重置内部引用与安装标记
      _installed = false
      _boundWindowError = null
      _boundUnhandledRejection = null
      _boundOnErrorWrapper = null
      safeLog('error handler torn down')
    } catch (e) {
      safeLog('teardown failed', e)
    }
  }

  // getVueErrorHandler: 返回可直接挂到 Vue 的全局错误处理函数（兼容 Vue2/3）
  // app.config.errorHandler = handler.getVueErrorHandler()
  function getVueErrorHandler(jsErrorSchema = null) {
    return (err, vm, info) => {
      try {
        const vmName = (vm && (vm.$options?.name || vm.$options?._componentTag || vm?.name)) || null
        // 将 vm 和 info 作为 meta 透传
        reportJsError(err, { source: 'vue', vm: vmName, info }, jsErrorSchema || cfg.jsErrorSchema)
      } catch (e) {
        safeLog('vue handler failed', e)
      }
    }
  }

  // 返回实例 API：setup/teardown/reportJsError/getVueErrorHandler
  return {
    setup,
    teardown,
    reportJsError,
    getVueErrorHandler,
    // 内部对象暴露仅用于 debug/测试（谨慎使用）
    _internal: {
      cfg,
      recentErrors,
      shouldSendError
    }
  }
}
