// 判断字符串是否像 base64（URL-safe 也算）
function isLikelyBase64(s) {
  if (typeof s !== 'string') return false
  const t = s.trim()
  if (t.length < 8) return false
  // 允许 URL-safe base64 的 '-' 和 '_', 以及尾部的 '=' 填充
  return /^[A-Za-z0-9\-_]+=*$/.test(t)
}

// 判断是否像 JSON 字符串（以 { 或 [ 开头）
function isLikelyJsonString(s) {
  if (typeof s !== 'string') return false
  const t = s.trim()
  return t.startsWith('{') || t.startsWith('[')
}

// 尝试 JSON.parse，但不抛异常，失败返回 null
function tryParseJsonSafe(s) {
  try {
    return JSON.parse(s)
  } catch (e) {
    return null
  }
}

function binaryStringToUtf8(bin) {
  // 优先：现代浏览器 / 环境支持 TextDecoder
  if (typeof TextDecoder !== 'undefined') {
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  }

  // 回退：手动把每个字节转成 %HH，然后 decodeURIComponent
  // 注意：这里不会使用 escape()，而是显式构造百分号编码
  let percentEncoded = ''
  for (let i = 0; i < bin.length; i++) {
    const code = bin.charCodeAt(i)
    percentEncoded += '%' + ('00' + code.toString(16)).slice(-2)
  }
  return decodeURIComponent(percentEncoded)
}

// 尝试 base64 解码并解析为 JSON，失败返回 null
function tryDecodeBase64JsonSafe(b64) {
  if (typeof b64 !== 'string' || b64.length === 0) return null
  try {
    let t = b64.replace(/-/g, '+').replace(/_/g, '/')
    while (t.length % 4) t += '='
    const bin = (typeof atob === 'function') ? atob(t) : null
    if (!bin) return null
    try {
      const txt = binaryStringToUtf8(bin)
      return tryParseJsonSafe(txt)
    } catch (e) {
      return null
    }
  } catch (e) {
    return null
  }
}

// 解析函数：对 candidate 做最小安全解析
const tryNormalize = (cand) => {
  if (cand == null) return null
  if (typeof cand === 'object') return cand
  if (typeof cand !== 'string') return null

  // 先判断是 JSON-like 还是 base64-like；优先尝试最可能的解析方式
  if (isLikelyJsonString(cand)) {
    const p = tryParseJsonSafe(cand)
    if (p) return p
    // parse 失败再尝试 base64 decode（某些场景字符串看起来像 JSON 但被 base64 包裹）
    const p2 = tryDecodeBase64JsonSafe(cand)
    if (p2) return p2
    return null
  }

  if (isLikelyBase64(cand)) {
    const p = tryDecodeBase64JsonSafe(cand)
    if (p) return p
    // 再尝试 JSON.parse（极不常见）
    return tryParseJsonSafe(cand)
  }

  // 最后尝试 JSON.parse（保险但可能失败）
  return tryParseJsonSafe(cand)
}


// 解析单个 Snowplow 原始事件对象（data[] 中的一项）
function parseSnowplowEvent(ev, encodeBase64) {
  if (!ev || typeof ev !== 'object') return null

  const common = {
    eid: ev.eid || null,
    ts: ev.dtm ? Number(ev.dtm) : (ev.timestamp ? Number(ev.timestamp) : Date.now()),
    vid: ev.vid || null,
    sid: ev.sid || null,
    p: ev.p || null,    // platform
    url: ev.url || ev.pageUrl || null,
    raw: ev
  }

  // 1) 结构化事件 (se)
  if (ev.e === 'se' || ev.e === 'structured_event') {
    let se_pr = ev.se_pr
    if (typeof se_pr === 'string') {
      se_pr = tryParseJsonSafe(se_pr) || se_pr
    }
    return {
      eventType: 'structured_event',
      category: ev.se_ca || ev.category || null,
      action: ev.se_ac || ev.action || null,
      label: ev.se_la || null,
      property: se_pr || null,
      ...common
    }
  }

  // 2) 自描述事件 (ue)
  if (ev.e === 'ue' || ev.e === 'unstruct') {
    // 候选字段
    const uePx = ev.ue_px
    const uePr = ev.ue_pr
    const unstruct = ev.unstruct_event || ev.unstruct || ev.ue

    // 决定尝试顺序（这里只决定顺序，不做昂贵操作）
    let ordered = []
    if (encodeBase64 === true) {
      ordered = [uePx, uePr, unstruct]
    } else if (!encodeBase64 === false) {
      ordered = [uePr, uePx, unstruct]
    } else {
      // 自动轻量检测：优先 JSON-like 的 ue_pr，否则看 ue_px 是否像 base64
      if (uePr && isLikelyJsonString(uePr)) ordered = [uePr, uePx, unstruct]
      else if (uePx && isLikelyBase64(uePx)) ordered = [uePx, uePr, unstruct]
      else ordered = [uePr, uePx, unstruct] // 最保守的默认顺序
    }

    // 依次尝试
    let normalized = null
    for (let i = 0; i < ordered.length; i++) {
      normalized = tryNormalize(ordered[i])
      if (normalized) break
    }

    // 最后兜底：若解析失败，但 unstruct 字段是非空对象/字符串，也尝试直接 parse
    if (!normalized && unstruct) {
      normalized = tryNormalize(unstruct) || null
    }

    // 抽取 schema / payload，并处理常见的 double-wrap（{ schema, data: { schema, data: {...} } }）
    let schema = null
    let payload = null
    if (normalized) {
      schema = normalized.schema || (normalized.self && normalized.self.schema) || null
      payload = normalized.data || (normalized.self && normalized.self.data) || normalized
      // 如果 payload 有二次包装（payload.data），再拆一层
      if (payload && typeof payload === 'object' && payload.data !== undefined && typeof payload.data === 'object') {
        payload = payload.data
      }
    } else {
      // 无法解析：直接把原 ev 做 payload，避免丢失信息
      payload = ev
    }

    return {
      eventType: 'unstruct',
      schema,
      payload,
      ...common
    }
  }

  // 3) 页面 / 心跳 / 其他内置（pv, pp, etc）
  if (ev.event === 'page_view' || ev.e === 'pv') {
    return {
      eventType: 'page_view',
      title: ev.pageTitle || ev.dt || null,
      url: ev.pageUrl || ev.url || null,
      referrer: ev.refr || ev.referrer || null,
      ...common
    }
  }

  // 4) 资源或其他，默认 fallback
  return { eventType: ev.e || ev.event || 'unknown', payload: ev, ...common }
}

/////////////////////// 主解析函数 ///////////////////////

/**
 * 同步解析入口（供内部或单元测试使用）
 * bodyText 可以是 string / object / array
 * encodeBase64 同 transformSnowplowPayload 的 encodeBase64（会传给 parseSnowplowEvent）
 */
export function parseSync(bodyText, encodeBase64) {
  let parsed = bodyText
  if (parsed == null) return []

  // 字符串 -> 尝试 JSON.parse 或 base64 decode then parse
  if (typeof parsed === 'string') {
    const t = parsed.trim()
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      const p = tryParseJsonSafe(t)
      if (p !== null) parsed = p
      else {
        // 尝试 base64 解码后 parse
        const dec = tryDecodeBase64JsonSafe(t)
        if (dec !== null) parsed = dec
        else {
          // 最后兜底，返回 raw_text
          return [{ eventType: 'raw_text', payload: t }]
        }
      }
    } else {
      // 非明显 JSON 字符串，先尝试 base64 parse，再尝试 JSON.parse
      const dec = tryDecodeBase64JsonSafe(t)
      if (dec !== null) parsed = dec
      else {
        const p2 = tryParseJsonSafe(t)
        if (p2 !== null) parsed = p2
        else return [{ eventType: 'raw_text', payload: t }]
      }
    }
  }

  // 现在 parsed 是 object / array
  if (parsed && typeof parsed === 'object') {
    // payload_data style: { schema, data: [...] }
    if (parsed.schema && Array.isArray(parsed.data)) {
      return parsed.data.map(ev => parseSnowplowEvent(ev, encodeBase64)).filter(Boolean)
    }
    // array of events
    if (Array.isArray(parsed)) {
      return parsed.map(ev => parseSnowplowEvent(ev, encodeBase64)).filter(Boolean)
    }
    // single unstruct wrapper: { unstruct_event: { schema, data } } 或类似
    if (parsed.unstruct_event) {
      const ud = parsed.unstruct_event
      const normalized = ud.data || tryDecodeBase64JsonSafe(parsed.ue_px || '') || tryParseJsonSafe(parsed.ue_pr || '') || ud
      const schema = ud.schema || (normalized && normalized.schema) || null
      const payload = (normalized && (normalized.data || normalized)) || ud
      return [{ eventType: 'unstruct', schema, payload, raw: parsed }]
    }
    // single event object
    return [parseSnowplowEvent(parsed, encodeBase64)]
  }

  // 兜底
  return [{ eventType: 'unknown', payload: parsed }]
}

/**
 * 异步入口。当前实现轻量：对大 array 做分批（chunking）以避免一次性处理过多导致耗时。
 * encodeBase64
 */
export default async function transformSnowplowPayload(bodyText, encodeBase64) {
  const chunkSize = 50

  if (bodyText == null) return []

  // 若是字符串或对象，先做一次快速同步解析以判断顶层类型
  let top = bodyText
  if (typeof top === 'string') {
    // 仅尝试 JSON.parse（若失败不继续 heavy decode）
    const maybe = tryParseJsonSafe(top)
    if (maybe !== null) top = maybe
    else {
      // 若看起来像 base64，则尝试解 base64 -> JSON
      if (isLikelyBase64(top)) {
        const dec = tryDecodeBase64JsonSafe(top)
        if (dec !== null) top = dec
        // 否则保持为字符串（后续 parseSync 会处理）
      }
    }
  }

  // 若 top 是数组且长度较大，则分批解析，期间让出事件循环
  if (Array.isArray(top) && top.length > (chunkSize || 50)) {
    const out = []
    for (let i = 0; i < top.length; i += chunkSize) {
      const slice = top.slice(i, i + chunkSize)
      for (let j = 0; j < slice.length; ++j) {
        const ev = parseSnowplowEvent(slice[j], encodeBase64)
        if (ev) out.push(ev)
      }
      // 让出事件循环，避免阻塞 UI
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, 0))
    }
    return out
  }

  // 否则使用同步解析（数组或单对象）
  return parseSync(top, encodeBase64)
}
