import transformSnowplowPayload from '../utils/transformSnowplowPayload'

export function useCustomFetch(options = {}) {
  const {
    outboundUrl = null, // e.g. 'https://wh-obervability.mychery.com/v1/logs'
    collectorPath = '/com.snowplowanalytics.snowplow/tp2',
    formatInput = null, // (optional) fn(transformedEvents) => finalPayload (sync/async)
    debug = false,
    headers = {
      'Content-Type': 'application/json'
    },
    encodeBase64
  } = options
  return async function customFetch(input, init = {}) {
    // 1. 读出原始请求 URL & 原始 bodyText（兼容 Request / (url, init)）
    let originalUrl = typeof input === 'string' ? input : (input && input.url)
    let rawBody = null
    try {
      if (input instanceof Request) {
        // clone 读取 body（Request 可能只能读一次）
        const clone = input.clone()
        try {
          rawBody = await clone.text()
        } catch {
          rawBody = null
        }
      } else {
        rawBody = init?.body ?? null
        // 若 body 是对象（非 FormData/Blob），尽量序列化供解析使用
        if (rawBody && typeof rawBody === 'object' && !(rawBody instanceof FormData) && !(rawBody instanceof Blob) && !(rawBody instanceof ArrayBuffer)) {
          try {
            rawBody = JSON.stringify(rawBody)
          } catch { /* keep as-is */
          }
        }
      }
    } catch (e) {
      if (debug) console.warn('[customFetch] read original body failed', e)
    }

    // 2. 仅处理匹配 collectorPath 的请求（避免误拦截其它 fetch）
    if (!originalUrl || !originalUrl.includes(collectorPath)) {
      if (debug) console.debug('[customFetch] not a snowplow request, pass through:', originalUrl)
      return fetch(input, init)
    }

    // 3. 解析并 transform（你的 transformSnowplowPayload 应该接受 string/object）
    let transformed = null
    try {
      transformed = await transformSnowplowPayload(rawBody, encodeBase64) // 用户实现的解析函数
    } catch (e) {
      if (debug) console.error('[customFetch] transformSnowplowPayload failed', e)
      // 如果 transform 失败，把原始 body 发出去
      transformed = rawBody
    }

    // 4. 把 transformed 交给 formatInput（如果有），formatInput 可以是 sync 或 async
    let finalPayload = transformed
    try {
      if (formatInput && typeof formatInput === 'function') {
        const maybe = formatInput(transformed)
        finalPayload = (maybe instanceof Promise) ? await maybe : maybe
      }
    } catch (e) {
      if (debug) console.error('[customFetch] formatInput failed', e)
      // fallback 使用 transformed
      finalPayload = transformed
    }

    // 5. 序列化 finalPayload（容错）
    let bodyToSend
    try {
      if (typeof finalPayload === 'string') {
        bodyToSend = finalPayload
      } else {
        bodyToSend = JSON.stringify(finalPayload === undefined ? transformed : finalPayload)
      }
    } catch (e) {
      if (debug) console.error('[customFetch] JSON.stringify failed', e)
      // fallback 转发原始文本（若有），否则发送一个 minimal envelope
      bodyToSend = rawBody ? String(rawBody) : JSON.stringify({
        error: 'serialization_failed',
        originalUrl,
        ts: Date.now()
      })
    }

    // 6. 决定目标 URL：优先使用 outboundUrl（完整目标）
    let targetUrl = outboundUrl

    if (debug) {
      console.debug('[customFetch] forward to', targetUrl)
      // 不在生产暴露过多 payload 日志，开发可打开
      console.debug('[customFetch] bodyToSend preview:', bodyToSend && bodyToSend.slice && bodyToSend.slice(0, 1000))
    }

    // options.headers 即外部传入的 headers
    const _headers = buildMergedHeaders(init?.headers, headers)
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: _headers,
      body: bodyToSend,
      // keepalive 可提高在 page unload 时发送成功率（有限）
      keepalive: true,
      // credentials 按需透传
      credentials: init?.credentials
    })


    // 8. 你可以自定义：如果你想要 SDK 觉得“发送成功”，就返回后端的真实 Response；
    //    如果你希望屏蔽后端失败不影响 SDK，可返回一个模拟 200 Response：
    if (!res.ok && debug) {
      console.warn('[customFetch] target responded not ok', res.status)
    }
    return res
  }
}

// 合并 headers，优先级： init.headers <- options.headers
function buildMergedHeaders(initHeaders, optionHeaders = {}) {
  const merged = Object.assign({}, initHeaders || {})
  merged['Content-Type'] = merged['Content-Type'] || 'application/json'
  Object.assign(merged, optionHeaders)
  return merged
}

