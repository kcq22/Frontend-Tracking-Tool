/**
 * 通用路由监听器
 *  1. 优先订阅框架自带的路由事件（uni-app、Taro）
 *  2. 接着监听标准浏览器事件：popstate、hashchange
 *  3. 可选 patch pushState/replaceState → 派发 location change
 *  4. 拦截 <a> 点击 & <form> 提交
 *  5. beforeunload/visibilitychange 做最后一次硬导航埋点
 *
 * @param {(newUrl: string, oldUrl?: string|null) => void} onRouteChange
 * @returns {() => void} 取消所有监听
 */
export function initRouterListener(onRouteChange) {

  // 保存上一页的路径，首次为初始化时的页面
  let lastUrl = normalizePath(location.href)

  function notify() {
    const newUrl = normalizePath(location.href)
    const oldUrl = lastUrl
    if (newUrl === oldUrl) return
    // 🔥 先更新 lastUrl，再触发回调，确保回调里拿到的是 old/new
    lastUrl = newUrl
    // ⚡️ 在路由变化时，先把“上一页”数据上报
    onRouteChange(oldUrl)
  }

  // 1. 框架事件：uni-app
  let removeUniHook = () => {
  }
  if (typeof window.uni === 'object' && typeof uni.$once === 'function') {
    // uni-app 默认会在跳转后触发 'routeChange' 事件（不同版本可能不同，请确认）
    uni.$once('routeChange', notify)
    removeUniHook = () => uni.$off('routeChange', notify)
  }

  // 1b. 框架事件：Taro
  let removeTaroHook = () => {
  }
  if (typeof window.Taro === 'object' && Taro.eventCenter) {
    // Taro H5 端可通过 eventCenter 订阅路由变化
    const { on, off } = Taro.eventCenter
    on('routeChange', notify)
    removeTaroHook = () => off('routeChange', notify)
  }

  // 2. 浏览器原生事件
  window.addEventListener('popstate', notify)
  window.addEventListener('hashchange', notify)

  // 3. 可选 patch History API
  let removeMethodPatch = () => {
  }
  const _push = history.pushState
  const _replace = history.replaceState
  if (!_push._perfPatched) {
    history.pushState = function() {
      const result = _push.apply(this, arguments)
      window.dispatchEvent(new Event('locationchange'))
      return result
    }
    history.pushState._perfPatched = true
  }
  if (!_replace._perfPatched) {
    history.replaceState = function() {
      const result = _replace.apply(this, arguments)
      window.dispatchEvent(new Event('locationchange'))
      return result
    }
    history.replaceState._perfPatched = true
  }
  window.addEventListener('locationchange', notify)
  removeMethodPatch = () => {
    window.removeEventListener('locationchange', notify)
    history.pushState = _push
    history.replaceState = _replace
  }

  // 4. 拦截 <a> 点击 & <form> 提交
  const clickHandler = e => {
    const a = e.target.closest('a[href]')
    if (!a) return
    const href = a.getAttribute('href')
    // 只拦截同源并非下载链接
    if (!href.startsWith('http') || new URL(href, location.origin).origin === location.origin) {
      setTimeout(notify, 0)
    }
  }
  document.addEventListener('click', clickHandler, true)

  // 5. 硬导航前最后一次埋点
  const beforeUnloadHandler = () => onRouteChange(normalizePath(location.href), lastUrl)
  const visibilityHandler = () => {
    if (document.visibilityState === 'hidden') {
      onRouteChange(normalizePath(location.href), lastUrl)
    }
  }
  window.addEventListener('beforeunload', beforeUnloadHandler)
  document.addEventListener('visibilitychange', visibilityHandler)

  // 返回取消监听
  return () => {
    removeUniHook()
    removeTaroHook()
    window.removeEventListener('popstate', notify)
    window.removeEventListener('hashchange', notify)
    window.removeEventListener('beforeunload', beforeUnloadHandler)
    document.removeEventListener('visibilitychange', visibilityHandler)

    removeMethodPatch()
    document.removeEventListener('click', clickHandler, true)
  }
}


/**
 * 规范化 URL，只保留「路由部分」
 * - 若包含 hash（“#/...”），则返回 hash 里的路径部分
 * - 否则用 new URL 拿 pathname
 *
 * @param {string} fullUrl
 * @returns {string} 例如 "/sub_pages_boutique_mall/pages/detail/detail"
 */
export function normalizePath(fullUrl) {
  try {
    const url = new URL(fullUrl, window.location.origin)
    const hash = url.hash // 带 '#'
    if (hash && hash.startsWith('#/')) {
      // 去掉首个 '#'，然后再去掉查询参数
      return hash.slice(1).split('?')[0]
    }
    // 无 hash 或 hash 不是路由，则返回 pathname（不带查询）
    return url.pathname
  } catch (e) {
    // 兜底：手动拆
    const parts = fullUrl.split('#')
    if (parts[1] && parts[1].startsWith('/')) {
      return parts[1].split('?')[0]
    }
    return parts[0].split('?')[0]
  }
}
