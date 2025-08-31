import { trackSelfDescribingEvent } from '@snowplow/browser-tracker'
import { getRequestId } from './index'

// 防抖/去重：记录最近上报过的错误 key 与时间
const recentErrors = new Map()
const ERROR_DEDUP_MS = 60 * 1000 // 同一错误 60s 内只上报一次
const ERROR_RATE_LIMIT = { maxPerMinute: 300 } // 整体限流（可按需调整）
let errorCountWindowStart = Date.now()
let errorCountInWindow = 0

let _jsErrorSchema, _resourceErrorSchema

function shouldSendError(key) {
  const now = Date.now()

  // 全局速率窗
  if (now - errorCountWindowStart > 60_000) {
    errorCountWindowStart = now
    errorCountInWindow = 0
  }
  if (++errorCountInWindow > ERROR_RATE_LIMIT.maxPerMinute) {
    // 超过整体速率限制，丢弃
    return false
  }

  // 去重
  const last = recentErrors.get(key)
  if (last && now - last < ERROR_DEDUP_MS) return false
  recentErrors.set(key, now)

  // 清理旧条目（避免泄漏）
  if (recentErrors.size > 1000) {
    // 简单清理：移除最旧的 100 条
    const keys = Array.from(recentErrors.keys()).slice(0, 100)
    keys.forEach(k => recentErrors.delete(k))
  }
  return true
}

function normalizeStack(stack) {
  try {
    if (!stack) return null
    // 可扩展：做简单截断避免 payload 过大
    return (typeof stack === 'string' ? stack : JSON.stringify(stack)).slice(0, 2000)
  } catch {
    return null
  }
}

function buildErrorPayload(base) {
  return {
    timestamp: Date.now(),
    requestId: getRequestId(),
    ...base
  }
}

/**
 * 手动上报入口（可在 catch 块或业务判断时调用）
 * @param {Error|Object|string} err
 * @param {Object} meta - 额外字段（url、component、info、requestData...）
 * @param jsErrorSchema
 */
export function reportJsError(err, meta = {}, jsErrorSchema) {
  try {
    const message = err?.message || (typeof err === 'string' ? err : JSON.stringify(err))
    const stack = normalizeStack(err?.stack || err?.stackTrace || null)
    const key = `${message}|${stack?.slice(0, 200)}` // 用于去重
    if (!shouldSendError(key)) return

    const payload = buildErrorPayload({
      type: 'manual',
      message,
      stack,
      ...meta
    })
    trackSelfDescribingEvent({
      event: {
        schema: jsErrorSchema || 'no-schema',
        data: payload
      }
    })

    // 在开发环境也打印
    console.error('[reportJsError]', payload)
  } catch (e) {
    // 上报失败不能抛出
    console.error('reportJsError failed', e)
  }
}

/**
 * 内部统一处理 ErrorEvent 或资源错误
 */
function handleWindowErrorEvent(e) {
  try {
    // 资源加载错误：target 存在 src/href
    const target = e?.target || null
    if (target && (target.src || target.href)) {
      const url = target.src || target.href
      const tag = target.tagName
      const message = `ResourceError: ${tag} ${url}`
      const key = `resource|${tag}|${url}`

      if (!shouldSendError(key)) return
      const payload = buildErrorPayload({
        type: 'resource',
        message,
        resourceUrl: url,
        tagName: tag
      })
      trackSelfDescribingEvent({
        event: {
          // schema: _resourceErrorSchema || 'no-schema',
          data: payload
        }
      })
      return
    }

    // 普通 JS ErrorEvent
    const message = e?.message || (e?.error && e.error.message) || String(e)
    const stack = normalizeStack(e?.error?.stack || null)
    const key = `error|${message}|${stack?.slice(0, 200)}`

    if (!shouldSendError(key)) return
    const payload = buildErrorPayload({
      type: 'js',
      message,
      filename: e?.filename || (e?.error && e.error?.fileName) || null,
      lineno: e?.lineno || null,
      colno: e?.colno || null,
      stack
    })

    trackSelfDescribingEvent({
      event: {
        // schema: _jsErrorSchema ||  'no-schema',
        data: payload
      }
    })

    console.error('[window.error捕获]', payload)
  } catch (err) {
    console.error('handleWindowErrorEvent failed', err)
  }
}

function handleUnhandledRejection(e) {
  try {
    const reason = e?.reason
    const message = (reason && (reason.message || JSON.stringify(reason))) || String(reason) || 'UnhandledRejection'
    const stack = normalizeStack(reason?.stack || null)
    const key = `unhandledrejection|${message}|${stack?.slice(0, 200)}`

    if (!shouldSendError(key)) return
    const payload = buildErrorPayload({
      type: 'unhandledrejection',
      message,
      stack
    })

    trackSelfDescribingEvent({
      event: {
        // schema: _jsErrorSchema ||  'no-schema',
        data: payload
      }
    })

    if (process.env.NODE_ENV !== 'production') {
      console.error('[unhandledrejection 捕获]', payload)
    }
  } catch (err) {
    console.error('handleUnhandledRejection failed', err)
  }
}

/**
 * 在 init 后调用，挂载 window level 的错误监听（包括资源错误）
 * 使用 capture=true 捕获资源加载错误
 */
export function setupGlobalErrorHandlers(jsErrorSchema, resourceErrorSchema) {
  _jsErrorSchema = jsErrorSchema
  _resourceErrorSchema = resourceErrorSchema
  // 捕获 DOM 资源加载错误需要捕获阶段
  window.addEventListener('error', handleWindowErrorEvent, true)
  window.addEventListener('unhandledrejection', handleUnhandledRejection)

  // 兼容老式 window.onerror（某些场景会触发）
  window.onerror = function(message, source, lineno, colno, error) {
    // 将参数封成一个对象，交给上面的处理函数复用逻辑
    handleWindowErrorEvent({ message, filename: source, lineno, colno, error })
  }
}

/**
 * 返回一个可以挂到 Vue 的全局错误处理器
 * Vue3: app.config.errorHandler = getVueErrorHandler();
 * Vue2: Vue.config.errorHandler = getVueErrorHandler();
 */
export function getErrorHandler(jsErrorSchema) {
  return function(err, vm, info) {
    // vm 可能为空，info 是字符串（如生命周期）
    reportJsError(err, {
      source: 'vue',
      vm: vm && (vm.$options?.name || vm.$options?._componentTag || vm?.name) || null,
      info
    }, jsErrorSchema)
    // 不阻止 Vue 的默认行为（如 console 报错），由调用方决定是否吃掉
  }
}
