// src/utils/mockSnowplow.js
export function setupSnowplowMock() {
  (function setupSnowplowMock() {
    // 1. Mock fetch
    const origFetch = window.fetch
    window.fetch = async function(input, init) {
      let url, body

      if (input instanceof Request) {
        // 当 fetch 只传 Request 对象
        url = input.url
        // clone 一份读取 body
        const cloneReq = input.clone()
        try {
          body = await cloneReq.json()
        } catch {
          body = null
        }
      } else {
        // 当 fetch 传 (url, init)
        url = input
        body = init?.body ?? null
      }

      if (url.includes('/com.snowplowanalytics.snowplow')) {
        console.log('[Mock Fetch] 拦截 Snowplow 上报', url, body)
        // 返回一个 200 的模拟响应
        return new Response('OK', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' }
        })
      }

      // 不是埋点请求，调用原生 fetch
      return origFetch.apply(this, arguments)
    }

    // 2. Mock sendBeacon
    const origBeacon = navigator.sendBeacon
    navigator.sendBeacon = function(url, data) {
      let payload = null

      try {
        // sendBeacon data 通常是字符串或 ArrayBuffer
        if (typeof data === 'string') {
          payload = data
        } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
          payload = new TextDecoder().decode(data)
        } else if (data instanceof Blob) {
          // Blob 需要异步读取才行，但 sendBeacon 是同步接口，这里简化打印大小
          payload = `[Blob size=${data.size}]`
        } else {
          payload = JSON.stringify(data)
        }
      } catch (e) {
        payload = '[无法读取数据]'
      }

      if (url.includes('/com.snowplowanalytics.snowplow')) {
        console.log('[Mock Beacon] 拦截 Snowplow 上报')
        console.log('  URL:', url)
        console.log('  Payload:', payload)
        // 返回 true 表示“已发送”，阻止真实请求
        return true
      }

      // 不是埋点请求，调用原生 sendBeacon
      return origBeacon.call(this, url, data)
    }
  })()

}
