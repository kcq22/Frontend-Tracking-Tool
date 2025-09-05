import {
  newTracker,
  trackPageView,
  trackStructEvent,
  trackSelfDescribingEvent,
  enableActivityTracking,
} from '@snowplow/browser-tracker'
import { enableLinkClickTracking } from '@snowplow/browser-plugin-link-click-tracking'
import { useErrorHandler } from './hooks/useErrorHandler'
import { useCustomFetch } from './hooks/useCustomFetch'
import { initRouterListener } from './utils/routerListener'
import { getRequestId } from './utils'

// 在文件顶部定义默认选项（中文注释）
const DEFAULT_OPTIONS = {
  appId: 'ft_1',
  trackerId: 'ft_1',
  platform: 'web',
  debug: false,
  encodeBase64: true,
  headers: undefined,
  formatInput: undefined,
  otherOptions: undefined,
  context: {
    requestId: getRequestId()
  },
  activityTrack: false,
  activityTrackingOptions: { minimumVisitLength: 10, heartbeatDelay: 10 },

  linkTrack: false,
  linkClickTrackingOptions: { trackContent: true },

  enablePageView: true,
  enableErrHandler: true,
  jsErrorSchema: null,
  resourceErrorSchema: null,

  // 不默认自动替换全局 fetch；若需要请传 customFetchOptions
  useCustomFetch: false,
}

/**
 * FrontendTracker 类
 *
 * - 每个实例维护独立的 errorHandler、router listener、配置
 * - 保留原始参数透传（formatInput, headers, otherOptions 等）
 * - 提供 stop() 完整卸载（解除 errorHandler、router listener 等）
 *
 * options（常用）:
 *  - trackerId
 *  - url (collector base)
 *  - appId
 *  - platform
 *  - debug
 *  - headers
 *  - formatInput
 *  - activityTrack (bool)
 *  - activityTrackingOptions
 *  - linkTrack (bool)
 *  - linkClickTrackingOptions
 *  - enableErrHandler (bool)
 *  - errorHandlerOptions (obj)
 *  - jsErrorSchema / resourceErrorSchema
 *  - customFetchOptions: { outboundUrl, collectorPath, formatInput, headers, debug }
 */
export class FrontendTracker {
  constructor(options = {}) {
    // 合并：用户传入的优先覆盖默认
    this.opts = { ...DEFAULT_OPTIONS, ...(options || {}) }
    // 允许深层合并部分对象（避免覆盖整个 activityTrackingOptions）
    this.opts.activityTrackingOptions = { ...DEFAULT_OPTIONS.activityTrackingOptions, ...(options.activityTrackingOptions || {}) }
    this.opts.linkClickTrackingOptions = { ...DEFAULT_OPTIONS.linkClickTrackingOptions, ...(options.linkClickTrackingOptions || {}) }

    // 内部状态
    this._inited = false
    this._routerOff = null
    this._vueErrorHandler = null
    this.errorHandler = null
  }

  /**
   * 初始化 tracker（可传 router，如果要启用 router.afterEach 自动 PV）
   * router: Vue Router 实例（可选）
   * 返回 this，链式友好
   */
  init(router = null) {
    if (this._inited) return this

    const o = this.opts

    // 必要参数校验（抛出让调用方感知）
    if (!o.url) throw new Error('[FrontendTracker]: url is required')
    if (!o.appId) throw new Error('[FrontendTracker]: appId is required')

    // 初始化 snowplow tracker（参数尽量透传）

    const configuration = {
      appId: o.appId,
      platform: o.platform,
      encodeBase64: o.encodeBase64,
      debug: !!o.debug,
      context: o.context, // 可选：调用方传入额外 context
      headers: o.headers,
      ...o.otherOptions
    }

    if (o.useCustomFetch) {
      configuration.customFetch = useCustomFetch({
        outboundUrl: o.url, // 你的接收端
        formatInput: o.formatInput, // 可选：对 transform 后的结果做最终格式化 由sdk外部传入
        debug: !!o.debug,
        encodeBase64: o.encodeBase64,
      })
    }

    try {
      newTracker(o.trackerId, o.url, configuration)
    } catch (e) {
      // 不要让初始化抛出的内部错误破坏宿主业务
      if (o.debug && console && console.error) console.error('[FrontendTracker] newTracker failed', e)
    }

    // 活动心跳（可选）
    if (o.activityTrack) {
      try {
        enableActivityTracking(o.activityTrackingOptions || { minimumVisitLength: 10, heartbeatDelay: 10 })
      } catch (e) {
        if (o.debug) console.warn('[FrontendTracker] enableActivityTracking failed', e)
      }
    }

    // 链接点击自动跟踪（可选）
    if (o.linkTrack) {
      try {
        enableLinkClickTracking(o.linkClickTrackingOptions || { trackContent: true })
      } catch (e) {
        if (o.debug) console.warn('[FrontendTracker] enableLinkClickTracking failed', e)
      }
    }

    // 错误处理（可选），使用可配置的 ErrorHandler 实例（避免全局冲突）
    if (o.enableErrHandler) {
      try {
        this.errorHandler = useErrorHandler({
          jsErrorSchema: o.jsErrorSchema,
          resourceErrorSchema: o.resourceErrorSchema,
          debug: !!o.debug,
          ...(o.errorHandlerOptions || {})
        })
        this.errorHandler.setup()
        // 暴露 Vue 全局 handler（如果外部需要挂到 app.config）
        this._vueErrorHandler = this.errorHandler.getVueErrorHandler()
      } catch (e) {
        if (o.debug) console.warn('[FrontendTracker] create/setup errorHandler failed', e)
      }
    }

    o.enablePageView && this.startPageTracking(router) // 启动 PV 监听
    this._inited = true
    return this
  }

  /**
   * 启动页面路由自动上报（PV）
   * 如果传入 router 优先使用 router.afterEach（若返回取消函数则保存），否则使用通用 initRouterListener
   */
  startPageTracking(router) {
    // 若已开启则忽略
    if (this._pageTrackingStarted) return true
    // 首次上报当前页
    this.trackPage()
    try {
      // 优先支持 Vue Router 的 router.afterEach（如果调用方传入）
      if (router && typeof router.afterEach === 'function') {
        // 保存 router 引用以便可能的卸载（但并非所有 router 提供移除 afterEach 的 API）
        this._routerInstance = router

        // 我们使用一个包装函数以便稍后可用同一引用进行移除（如果 router 返回取消函数则保存）
        this._routerHook = (to, from) => {
          const path = (to && (to.fullPath || to.path)) || window.location.href
          const ref = (from && (from.fullPath || from.path)) || document.referrer
          // 使用实例方法上报（保持 this 绑定）
          this.trackPage(path, ref)
        }

        // 某些 router 实现（如 Vue Router 4）会返回一个卸载函数；我们尝试保存它
        try {
          const maybeUnregister = this._routerInstance.afterEach(this._routerHook)
          // 如果没有返回取消函数，我们仍然记录已绑定，但无法自动移除（见 stopPageTracking 的说明）
          this._routerOff = typeof maybeUnregister === 'function' ? maybeUnregister : null
        } catch (e) {
          // 防御性降级：如果 router.afterEach 调用失败，回退到通用监听器
          if (this.opts.debug) console.warn('[FrontendTracker] router.afterEach failed, falling back to initRouterListener', e)
          this._routerOff = initRouterListener((newUrl, oldUrl) => this.trackPage(newUrl, oldUrl))
        }
        this._pageTrackingStarted = true
        return true
      }
      // 否则使用通用路由监听器 initRouterListener，它会返回一个取消函数
      // initRouterListener 回调接收 (newUrl, oldUrl)
      this._routerOff = initRouterListener((newUrl, oldUrl) => {
        this.trackPage(newUrl, oldUrl)
      })
      this._pageTrackingStarted = true
      return true
    } catch (err) {
      if (this.opts.debug) console.warn('[FrontendTracker] startPageTracking failed', err)
      return false
    }
  }

  /**
   * 停止页面路由自动上报（撤销 startPageTracking 的绑定）
   * - 如果使用 initRouterListener 创建，会调用返回的取消函数
   * - 如果使用 router.afterEach 且 router.afterEach 返回了取消函数，会调用它
   * - 如果 router.afterEach 没有返回取消函数，则无法自动移除（因为路由库自身未提供移除句柄）
   *   —— 在这种情况下我们尽力清理能清理的引用，并打印 debug 提示
   */
  stopPageTracking() {
    try {
      if (!this._pageTrackingStarted) return
      if (typeof this._routerOff === 'function') {
        this._routerOff()
        this._routerOff = null
      } else if (this._routerHook && typeof this._routerInstance?.off === 'function') {
        // 尝试调用 router.off（若支持）
        try {
          this._routerInstance.off(this._routerHook)
        } catch (e) {
          if (this.opts.debug) console.warn('[FrontendTracker] router.off failed', e)
        }
      }
      // 清理我们在 start 中创建的本地引用
      this._routerHook = null
      this._routerInstance = null
      this._pageTrackingStarted = false
    } catch (e) {
      if (this.opts.debug) console.warn('[FrontendTracker] stopPageTracking failed', e)
    }
  }

  /**
   * 上报页面访问（PV）
   * path: 页面 URL 或 path
   * referrer: 来源 URL（可选）
   */
  trackPage(pageUrl = (typeof window !== 'undefined' && window.location.href), referrer = (typeof document !== 'undefined' && document.referrer)) {
    console.log('[FrontendTracker] 页面访问埋点', pageUrl, referrer)
    trackPageView({ pageUrl, referrer })
  }

  /**
   * 结构化事件上报（封装 snowplow 的 trackStructEvent）
   * 参数透传给原生函数（保持兼容）
   */
  trackEvent(category = '', action = '', label = '', property = '', value) {
    let _property = ''
    if (property != null) {
      _property = typeof property === 'string' ? property : (JSON.stringify(property) || String(property))
    }
    console.log('~ 🚀 自定义点击事件', category, action, label, _property, value)
    trackStructEvent({ category, action, label, property: _property, value })
  }

  /**
   * 自描述事件上报（封装 snowplow 的 trackSelfDescribingEvent）
   */
  trackCustomDescribingEvent(data, schema = 'no-schema') {
    if (!data || typeof data !== 'object') {
      console.warn('[FrontendTracker] trackCustomDescribingEvent data 必须是对象')
      return
    }
    // 自动补 timestamp
    const payload = {
      ...data,
      timestamp: new Date().toISOString()
    }
    console.log('[FrontendTracker] trackCustomDescribingEvent', schema, payload)
    trackSelfDescribingEvent({
      event: {
        schema,
        data: payload
      }
    })
  }

  /**
   * 手动上报 JS 错误（代理到实例的 errorHandler）
   */
  reportJsError(err, meta = {}, jsErrorSchema = null) {
    try {
      if (this.errorHandler && typeof this.errorHandler.reportJsError === 'function') {
        return this.errorHandler.reportJsError(err, meta, jsErrorSchema)
      }
      // fallback: 直接打一个 self-describing event 保证不会丢
      const payload = { timestamp: Date.now(), message: (err && err.message) || String(err), meta }
      trackSelfDescribingEvent({
        event: {
          schema: jsErrorSchema || (this.opts.jsErrorSchema || 'no-schema'),
          data: payload
        }
      })
    } catch (e) {
      if (this.opts.debug) console.warn('[FrontendTracker] reportJsError failed', e)
    }
  }

  /**
   * 获取 Vue 用的全局错误处理器（若初始化了 errorHandler）
   * Vue3: app.config.errorHandler = tracker.getVueErrorHandler()
   */
  getVueErrorHandler() {
    return this._vueErrorHandler || this.errorHandler.getVueErrorHandler?.()
  }

  /**
   * 停止并清理实例（解除 errorHandler、router listener 等）
   * - 注意：某些由 @snowplow/browser-tracker 启用的全局功能（例如 enableActivityTracking）可能无法被取消
   *   —— 取决于插件本身是否提供 disable/teardown 接口；这里尽量做可撤销的清理。
   */
  stop() {
    // 卸载 error handler
    this.errorHandler?.teardown?.()
    this.stopPageTracking()
    this._inited = false
  }
}

export default FrontendTracker
