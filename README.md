# Frontend Tracking Tool

基于 [Snowplow JS Tracker](https://github.com/snowplow/snowplow-javascript-tracker) 的增强型前端埋点 SDK，提供简洁的 API 封装和扩展能力，适合在 Vue / React / 原生 Web 项目中快速集成。

## ✨ 特性

- 封装 Snowplow Tracker，开箱即用
- 可与自有后台日志服务对接，支持自定义上报接口和参数（`formatInput`）
- 提供事件追踪（页面曝光、点击数据等）
- 捕获并上报 `JavaScript` 运行时错误 以及 资源错误

## 📦 安装

```bash
npm install frontend-tracking-tool
# 或
yarn add frontend-tracking-tool

```

## 🚀 使用
```javascript
// main.js 
// 初始化埋点 SDK（调用一次即可）
import { createApp } from 'vue'
import { initFrontendTracker, getErrorHandler } from 'frontend-tracking-tool'

...
const app = createApp(App)

initFrontendTracker({
  trackerId: 'your_tracker_id',
  appId: 'your_app_id',
  url: 'your_app_url',
  platform: 'web', // web | app
  debug: true, // 是否开启调试模式 默认false
  activityTrack: true, // 是否开启页面心跳 默认false 关闭
  activityTrackingOptions: { // 页面心跳配置 需要开启页面心跳 
    minimumVisitLength: 10, // 页面心跳最小时长
    heartbeatDelay: 10 // 页面心跳间隔
  },
  linkTrack: true, // 是否开启链接点击事件 默认关闭
  linkClickTrackingOptions: { // 链接点击事件配置 需要开启链接点击事件
    trackContent: true
  },
  enableErrHandler: true, // 是否捕获错误信息 默认开启
  headers: { // 自定义请求头 可以不传 默认 'Content-Type': 'application/json'
    'Content-Type': 'application/json'
  },
  formatInput: (data) => { // 自定义数据格式
    return {
      customData: data
    }
  }
})

// 挂 Vue 全局错误处理器
app.config.errorHandler = getErrorHandler()
  
...
app.mount('#app')

```

## 🚀 手动上报
```javascript

import { trackClick } from 'frontend-tracker-sdk'

// 参数说明
/**
 * @param category string 事件分类，例如 "button", "form", "nav"。用于分组。
 * @param action   string 用户行为，例如 "click", "submit", "hover"。
 * @param label    string 可选标签，例如 "signup-button"，区分同类事件。
 * @param property string|object 可选属性，如 "color:red" 或 { color: "red" }。
 * @param value    string|number 可选数值，表示权重、价格、数量。
 */

// 示例
const extraParams = {
  params1: 'value1',
  params2: 'value2'
}

trackClick(
  'button',                // category
  'click',                 // action
  '注册按钮',               // label
  JSON.stringify(extraParams), // property
  1                        // value
)
```

## 🚀 手动上报js错误信息
```javascript
import { reportJsError } from 'frontend-tracker-sdk'

try {
  // 模拟一个业务逻辑错误
  throw new Error('用户数据加载失败')
} catch (e) {
  reportJsError(e, {
    url: window.location.href,
    component: 'UserProfile',
    requestData: { userId: 12345 }
  })
}

// 也可以直接传字符串
reportJsError('后端返回非法数据')

// 或者传一个对象
reportJsError(
  { code: 500, message: 'Internal Server Error' },
  { api: '/user/info', method: 'GET' }
)
```
