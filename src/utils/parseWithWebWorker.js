/**
 * transformSnowplowPayload.js
 *
 * Usage:
 *   import transformSnowplowPayload from './transformSnowplowPayload'
 *   const events = await transformSnowplowPayload(rawBody, { debug: true })
 *
 * Exports:
 *  - default: async function transformSnowplowPayload(bodyText, options)
 *  - parseSync: synchronous parsing function (main-thread)
 *
 * Notes:
 *  - This file creates an inline worker (Blob URL) when needed.
 *  - Worker code is constructed from a stringified minimal parser (no imports).
 */

/* ======= Helper / Config defaults ======= */
const DEFAULTS = {
  useWorker: true,                // 是否允许使用 Worker（默认允许）
  workerThresholdEvents: 100,     // 大于多少事件数时考虑使用 Worker
  workerThresholdBytes: 50 * 1024,// 大于多少字节时考虑使用 Worker (50 KB)
  chunkSize: 50,                  // 主线程分批解析时每批大小（事件条数）
  workerTimeoutMs: 3000,          // Worker 超时时间（ms），超时则回退到主线程解析
  debug: false
}

/* ======= Lightweight parser (suitable for worker or main thread) ======= */
function base64DecodeToString(b64) {
  if (!b64) return null
  try {
    // URL-safe -> standard base64
    b64 = b64.replace(/-/g, '+').replace(/_/g, '/')
    // pad
    while (b64.length % 4) b64 += '='
    // atob returns binary string; decodeURIComponent(escape(...)) converts to utf-8 string
    // avoid escape/decodeURIComponent on very old browsers? keep as-is for modern web
    try {
      // Prefer robust utf-8 decoding
      const bin = atob(b64)
      // Convert binary string to UTF-8 by percent-encoding
      let escaped = ''
      for (let i = 0; i < bin.length; ++i) {
        escaped += '%' + ('00' + bin.charCodeAt(i).toString(16)).slice(-2)
      }
      return decodeURIComponent(escaped)
    } catch (e) {
      // fallback to plain atob result
      return atob(b64)
    }
  } catch (e) {
    return null
  }
}

function tryDecodeBase64Json(b64) {
  try {
    const txt = base64DecodeToString(b64)
    if (!txt) return null
    return JSON.parse(txt)
  } catch (e) {
    return null
  }
}

function parseSnowplowEvent(ev) {
  if (!ev || typeof ev !== 'object') return null

  const common = {
    // keep some useful identifiers
    eid: ev.eid || null,
    ts: ev.dtm ? Number(ev.dtm) : (ev.timestamp ? Number(ev.timestamp) : Date.now()),
    vid: ev.vid || null,
    sid: ev.sid || null,
    p: ev.p || null,
    url: ev.url || ev.pageUrl || null,
    raw: ev
  }

  // structured event
  if (ev.e === 'se' || ev.e === 'structured_event') {
    let se_pr = ev.se_pr
    if (typeof se_pr === 'string') {
      try { se_pr = JSON.parse(se_pr) } catch (e) { /* keep string */ }
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

  // unstruct / self-describing
  if (ev.e === 'ue' || ev.e === 'unstruct' || ev.e === 'ue_px' || ev.unstruct_event) {
    // try common fields
    const ue_px = ev.ue_px || ev.unstruct_event || ev.unstruct || null
    // ue_px might be base64, object, or nested structure
    let decoded = null
    if (typeof ue_px === 'string') {
      decoded = tryDecodeBase64Json(ue_px) || tryParseJSONSafe(ue_px)
    } else if (typeof ue_px === 'object') {
      decoded = ue_px
    }
    // normalized schema & data
    let schema = null, data = null
    if (decoded) {
      // decoded may be { schema, data } or { self: { schema, data } } or the data itself
      schema = decoded.schema || (decoded.self && decoded.self.schema) || null
      data = decoded.data || (decoded.self && decoded.self.data) || decoded
    } else {
      // try some other slots
      schema = ev.schema || null
      data = ev.data || ev.payload || ev
    }
    return {
      eventType: 'unstruct',
      schema,
      payload: data,
      ...common
    }
  }

  // page view
  if (ev.event === 'page_view' || ev.e === 'pv') {
    return {
      eventType: 'page_view',
      title: ev.pageTitle || ev.dt || null,
      url: ev.pageUrl || ev.url || null,
      referrer: ev.refr || ev.referrer || null,
      ...common
    }
  }

  // fallback
  return { eventType: ev.e || ev.event || 'unknown', payload: ev, ...common }
}

function tryParseJSONSafe(s) {
  try {
    return JSON.parse(s)
  } catch (e) {
    return null
  }
}

/* ======= Sync parse function that works on object / string input ======= */
export function parseSync(bodyText) {
  // Accept string / object / array
  let parsed = bodyText
  if (!parsed) return []

  // If it's a string, try parse JSON first
  if (typeof parsed === 'string') {
    // Trim whitespace
    const t = parsed.trim()
    // If looks like JSON array/object, parse directly
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        parsed = JSON.parse(t)
      } catch (e) {
        // Maybe it's base64 encoded JSON
        const decoded = tryDecodeBase64Json(t)
        if (decoded) parsed = decoded
        else {
          // Not JSON: return raw_text event
          return [{ eventType: 'raw_text', payload: t }]
        }
      }
    } else {
      // Not starting with { or [, try base64 decode then parse
      const decoded = tryDecodeBase64Json(t)
      if (decoded) parsed = decoded
      else {
        // fallback raw text
        return [{ eventType: 'raw_text', payload: t }]
      }
    }
  }

  // parsed now could be:
  //  - { schema, data: [...] }  (payload_data style)
  //  - Array of events
  //  - Single event object (with ev.* fields)
  if (parsed && typeof parsed === 'object') {
    // payload_data style: { schema, data: [...] }
    if (parsed.schema && Array.isArray(parsed.data)) {
      return parsed.data.map(parseSnowplowEvent).filter(Boolean)
    }
    // array of events
    if (Array.isArray(parsed)) {
      return parsed.map(parseSnowplowEvent).filter(Boolean)
    }
    // single unstruct wrapper: { unstruct_event: { schema, data } } or similar
    if (parsed.unstruct_event) {
      const ud = parsed.unstruct_event
      let decoded = ud.data || tryDecodeBase64Json(parsed.ue_px || (ud.data && ud.data))
      return [{ eventType: 'unstruct', schema: ud.schema || null, payload: decoded || ud.data || ud, raw: parsed }]
    }
    // object that looks like a single event
    return [parseSnowplowEvent(parsed)]
  }

  // fallback
  return [{ eventType: 'unknown', payload: parsed }]
}

/* ======= Utility: estimate byte length of a string (utf-8) ======= */
function estimateUtf8Bytes(str) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).length
  }
  // fallback simple approx (may undercount for non-ascii)
  let s = str.length
  // rough: assume avg 1.5 bytes per char for non-ASCII content
  return Math.ceil(s * 1.5)
}

/* ======= Parse in chunks on main thread (async) ======= */
async function parseInChunks(bodyText, opts) {
  const { chunkSize = DEFAULTS.chunkSize, debug = false } = opts || {}
  // First do a synchronous parse to get top-level structure quickly
  // but avoid fully decoding huge arrays synchronously — if it's string and looks like a huge array, do lightweight parse first.
  // We'll try to parse to JS object; if it's array and longer than chunkSize, handle in batches.
  let parsed = bodyText
  if (typeof parsed === 'string') {
    // be conservative: parse to object (may be heavy) — but we need top-level array length
    try {
      parsed = JSON.parse(parsed)
    } catch (e) {
      // maybe base64
      const dec = tryDecodeBase64Json(parsed)
      if (dec) parsed = dec
      else {
        // not JSON -> return parseSync fallback
        return parseSync(parsed)
      }
    }
  }

  if (Array.isArray(parsed) && parsed.length > chunkSize) {
    const out = []
    for (let i = 0; i < parsed.length; i += chunkSize) {
      const slice = parsed.slice(i, i + chunkSize)
      for (let j = 0; j < slice.length; ++j) {
        const ev = parseSnowplowEvent(slice[j])
        if (ev) out.push(ev)
      }
      // yield to event loop so UI can update
      // small delay (0) yields control
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, 0))
    }
    if (debug) console.debug(`[parseInChunks] parsed ${out.length} events in ${Math.ceil(parsed.length / chunkSize)} batches`)
    return out
  }

  // not a big array -> simple sync parse
  return parseSync(parsed)
}

/* ======= Create inline worker code string ======= */
function buildWorkerScript() {
  // Note: avoid closing </script> sequences in template strings
  return `
    // Worker scope
    (${base64DecodeToString.toString()})();
    (${tryDecodeBase64Json.toString()})();
    (${tryParseJSONSafe.toString()})();
    (${parseSnowplowEvent.toString()})();
    (${parseSync.toString()})();
    self.onmessage = async function(ev) {
      try {
        const { bodyText } = ev.data || {}
        // run parseSync (it's self-contained above)
        const parsed = parseSync(bodyText)
        self.postMessage({ ok: true, result: parsed })
      } catch (err) {
        self.postMessage({ ok: false, error: String(err) })
      }
    }
  `
}

/* ======= Parse using a Worker with timeout & fallback ======= */
function parseWithWorker(bodyText, opts) {
  const { workerTimeoutMs = DEFAULTS.workerTimeoutMs, debug = false } = opts || {}
  return new Promise((resolve) => {
    let terminated = false
    let timer = null
    try {
      const script = buildWorkerScript()
      const blob = new Blob([script], { type: 'text/javascript' })
      const url = URL.createObjectURL(blob)
      const worker = new Worker(url)
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        try { worker.terminate() } catch (e) { /* ignore */ }
        try { URL.revokeObjectURL(url) } catch (e) { /* ignore */ }
      }

      worker.onmessage = function(e) {
        if (terminated) return
        terminated = true
        cleanup()
        const d = e.data
        if (d && d.ok) resolve(d.result)
        else resolve(parseSync(bodyText)) // fallback
      }

      worker.onerror = function(err) {
        if (terminated) return
        terminated = true
        cleanup()
        if (debug) console.warn('[transformWorker] error, fallback to main thread parse', err)
        resolve(parseSync(bodyText))
      }

      // timeout fallback
      timer = setTimeout(() => {
        if (terminated) return
        terminated = true
        try { worker.terminate() } catch (e) { /* ignore */ }
        if (debug) console.warn('[transformWorker] timeout, fallback to main thread')
        resolve(parseSync(bodyText))
      }, workerTimeoutMs)

      // post
      worker.postMessage({ bodyText })
    } catch (e) {
      // Worker creation failed (security or unsupported) -> fallback to main-thread parse
      if (debug) console.warn('[transformWorker] create failed, fallback', e)
      resolve(parseSync(bodyText))
    }
  })
}

/* ======= Main exported function (async) ======= */
export default async function transformSnowplowPayload(bodyText, options) {
  const opts = { ...DEFAULTS, ...(options || {}) }
  const { useWorker, workerThresholdEvents, workerThresholdBytes, debug } = opts

  // Quick bails
  if (!bodyText) return []

  // If bodyText is a Request/Blob/FormData, attempt to normalize to string early in caller.
  // Here we handle string/object/array.

  // Estimate size & event count heuristics
  let estimatedBytes = 0
  let topLevelCount = 0

  try {
    if (typeof bodyText === 'string') {
      estimatedBytes = estimateUtf8Bytes(bodyText)
      // try detect top-level array length without full parse: cheap check for leading '['
      const t = bodyText.trim()
      if (t.startsWith('[')) {
        // quick attempt to count commas + 1 (rough)
        const commaCount = (t.match(/,/g) || []).length
        topLevelCount = commaCount + 1
        // but this may overcount if items have nested commas; it's a heuristic
      }
    } else if (Array.isArray(bodyText)) {
      topLevelCount = bodyText.length
      try {
        // rough bytes via JSON
        estimatedBytes = estimateUtf8Bytes(JSON.stringify(bodyText))
      } catch (e) {
        estimatedBytes = 0
      }
    } else if (typeof bodyText === 'object') {
      // try to detect if it's payload_data { schema, data: [] }
      if (bodyText.data && Array.isArray(bodyText.data)) {
        topLevelCount = bodyText.data.length
      }
      try {
        estimatedBytes = estimateUtf8Bytes(JSON.stringify(bodyText))
      } catch (e) {
        estimatedBytes = 0
      }
    }
  } catch (e) {
    if (debug) console.warn('[transformSnowplowPayload] estimate failed', e)
  }

  if (debug) {
    console.debug('[transformSnowplowPayload] estimatedBytes=', estimatedBytes, 'topLevelCount=', topLevelCount)
  }

  // Decision: use Worker if allowed and heuristics pass
  const shouldUseWorker =
    useWorker &&
    ( (topLevelCount && topLevelCount >= workerThresholdEvents) || (estimatedBytes && estimatedBytes >= workerThresholdBytes) )

  if (shouldUseWorker && typeof Worker !== 'undefined') {
    if (debug) console.debug('[transformSnowplowPayload] using worker (heuristic matched)')
    return await parseWithWorker(bodyText, opts)
  }

  // else main-thread parse (with chunking support)
  return await parseInChunks(bodyText, opts)
}
