import {
  newTracker,
  trackPageView,
  trackStructEvent,
  trackSelfDescribingEvent,
  enableActivityTracking,
} from '@snowplow/browser-tracker'
import { enableLinkClickTracking } from '@snowplow/browser-plugin-link-click-tracking'
// import { setupSnowplowMock } from './utils/mockSnowplow'
import { startPageTracking } from './utils/RouterTracker'
import { getRequestId } from './utils'
import { setupGlobalErrorHandlers } from './utils/ErrorHandler'
import { useCustomFetch } from './utils/useCustomFetch'

export const initFrontendTracker = (opts = {}, router) => {
  let stopTracking
  // if (opts.localDebug) {
  //   setupSnowplowMock()
  // }
  if (router) { // 路由切换时自动埋点 PV
    router.afterEach((to, from) => {
      trackPage(to.fullPath, from.fullPath)
    })
  } else {
    stopTracking = startPageTracking()
  }
  initSnowplow({
    url: opts.url,
    trackerId: opts.trackerId,
    formatInput: opts.formatInput,
    encodeBase64: opts.encodeBase64,
    appId: opts.appId,
    debug: opts.debug,
    headers: opts.headers,
    platform: opts.platform,
    enableErrHandler: opts.enableErrHandler,
    activityTrack: opts.activityTrack,
    linkTrack: opts.linkTrack,
    activityTrackingOptions: opts.activityTrackingOptions,
    linkClickTrackingOptions: opts.linkClickTrackingOptions,
    jsErrorSchema: opts.jsErrorSchema,
    resourceErrorSchema: opts.resourceErrorSchema,
    otherOptions: opts.otherOptions,
  })
  return {
    stopTracking
  }
}

// 初始化 Tracker
export function initSnowplow(
  {
    url,
    trackerId = 'sp1',
    appId,
    encodeBase64 = true,
    platform = 'web',
    headers,
    formatInput,
    otherOptions,
    debug = false,
    activityTrack,
    linkTrack,
    enableErrHandler = true,
    activityTrackingOptions = {
      minimumVisitLength: 10, heartbeatDelay: 10
    },
    linkClickTrackingOptions = {
      trackContent: true
    },
    jsErrorSchema,
    resourceErrorSchema,
  }) {
  // 校验 url
  if (!url) {
    throw new Error('url is required')
  }
  // 校验 appId
  if (!appId) {
    throw new Error('appId is required')
  }

  newTracker(trackerId, url, {
    appId,
    platform,
    encodeBase64,
    debug, // 打开调试模式，可在控制台查看
    context: { requestId: getRequestId() },
    headers,
    customFetch: useCustomFetch({
      outboundUrl: url, // 你的接收端
      formatInput, // 可选：对 transform 后的结果做最终格式化 由sdk外部传入
      debug,
      // headers: { 'x-sdk': 'frontend-tracker-sdk/1.0.0' }
    }),
    ...otherOptions
  })

  // 启用页面心跳（停留时长）
  // minimumVisitLength 页面加载后，等待至少多少秒才上报第一次心跳。防止用户一进来就离开也算一次。
  // heartbeatDelay 首次心跳后，每隔多少秒上报一次心跳，直到页面卸载。
  activityTrack && enableActivityTracking(activityTrackingOptions)
  // 自动跟踪链接点击
  linkTrack && enableLinkClickTracking(linkClickTrackingOptions)
  // 全局错误 监听
  enableErrHandler && setupGlobalErrorHandlers(jsErrorSchema, resourceErrorSchema)
}

// 页面访问埋点
export function trackPage(path = window.location.pathname, referrer = document.referrer) {
  console.log('~ 🚀 页面访问埋点', path, referrer)
  trackPageView({ pageUrl: path, referrer })
}

/**
 *
 * @param category string 事件分类，例如 "button", "form", "nav"。用来把事件分组。
 * @param action  string 用户执行的动作，例如 "click", "submit", "hover"。表示事件的行为。
 * @param label string 可选标签，例如 "signup-button"，用来区分同一 category/action 下的不同元素。
 * @param property string 可选属性，例如 "color:red" 或 "size:large"，用于补充事件的上下文信息。
 * @param value string 可选数值，如果有数值意义记录事件的权重、价格、数量，否则留空。
 */
// const params = {
//   params1: 'value1',
//   params2: 'value2'
// }
// trackClick('button', 'click', '事件123', JSON.stringify(params), undefined)
export function trackClick(category = '', action = '', label = '', property = '', value) {
  let _property = ''
  if (property != null) {
    if (typeof property === 'string') {
      _property = property
    } else {
      try {
        _property = JSON.stringify(property)
      } catch (e) {
        console.error('trackClick property 序列化失败', e)
        _property = String(property) // 强制转成字符串，保证不会 undefined
      }
    }
  }

  console.log('~ 🚀 结构化点击事件', category, action, label, _property, value)
  trackStructEvent({ category, action, label, property: _property, value })
}


/**
 * 对外暴露的通用自定义事件上报方法
 * @param {string} [schema] - 可选 schema URI
 * @param {object} data - 上报的数据对象
 */
export function trackCustomEvent(schema, data) {
  const eventSchema = schema || 'no-schema'
  if (!data || typeof data !== 'object') {
    console.warn('[trackCustomEvent] data 必须是对象')
    return
  }
  // 自动补 timestamp
  const payload = {
    ...data,
    timestamp: new Date().toISOString()
  }
  console.log('~ 🚀 自定义事件上报', eventSchema, payload)
  trackSelfDescribingEvent({
    event: {
      schema: eventSchema,
      data: payload
    }
  })
}


// Axios 拦截埋点
export function setupAxiosInterceptor(axiosInstance) {
  axiosInstance.interceptors.request.use(config => {
    config.metadata = { startTime: Date.now() }
    return config
  })
  axiosInstance.interceptors.response.use(res => {
    const { config, status } = res
    const duration = Date.now() - config.metadata.startTime
    trackSelfDescribingEvent({
      event: {
        schema: 'iglu:com.yourcompany/api_call/jsonschema/1-0-0',
        data: {
          url: config.url,
          method: config.method,
          status,
          duration,
          requestData: config.data || config.params,
          responseData: res.data
        }
      }
    })
    return res
  }, err => {
    const { config, response } = err
    trackSelfDescribingEvent({
      event: {
        schema: 'iglu:com.yourcompany/api_call/jsonschema/1-0-0',
        data: {
          url: config.url,
          method: config.method,
          status: response?.status,
          duration: Date.now() - config.metadata.startTime,
          message: err.message
        }
      }
    })
    return Promise.reject(err)
  })
}
