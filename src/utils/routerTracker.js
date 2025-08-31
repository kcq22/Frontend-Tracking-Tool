import { initRouterListener } from './RouterListener'
import { trackPage } from '../initSnowplow'

/**
 * 启动全路由埋点
 * @returns {() => void} 取消所有监听
 */
export function startPageTracking() {
  // 第一次上报当前页
  trackPage(window.location.href)
  // 当路由变化时，上报新的页面访问（只用 newUrl）
  const off = initRouterListener((newUrl, oldUrl) => {
    trackPage(newUrl, oldUrl)
  })

  return off
}
