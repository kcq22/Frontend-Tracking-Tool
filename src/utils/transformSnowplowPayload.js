// utils/snowplowParser.js

// 兼容 URL-safe base64
function base64DecodeToString(b64) {
  if (!b64) return null;
  try {
    // make URL-safe base64 compatible
    b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
    // pad
    while (b64.length % 4) b64 += '=';
    return decodeURIComponent(escape(atob(b64)));
  } catch (e) {
    try { return atob(b64); } catch { return null; }
  }
}

// 尝试把 base64->JSON -> Object
function tryDecodeBase64Json(b64) {
  try {
    const txt = base64DecodeToString(b64);
    if (!txt) return null;
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

// 解析单个 Snowplow 原始事件对象（data[] 中的一项）
function parseSnowplowEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;

  const common = {
    eid: ev.eid || null,
    ts: ev.dtm ? Number(ev.dtm) : (ev.timestamp ? Number(ev.timestamp) : Date.now()),
    vid: ev.vid || null,
    sid: ev.sid || null,
    p: ev.p || null,    // platform
    url: ev.url || ev.pageUrl || null,
    raw: ev
  };

  // 1) 结构化事件 (se)
  if (ev.e === 'se' || ev.e === 'structured_event') {
    let se_pr = ev.se_pr;
    // se_pr 有时是字符串化 JSON
    if (typeof se_pr === 'string') {
      try { se_pr = JSON.parse(se_pr); } catch (e) { /* keep string */ }
    }
    return {
      eventType: 'structured_event',
      category: ev.se_ca || ev.category || null,
      action: ev.se_ac || ev.action || null,
      label: ev.se_la || ev.se_la || null,
      property: se_pr || ev.se_pr || ev.se_pr,
      ...common
    };
  }

  // 2) 自描述事件 (ue)
  if (ev.e === 'ue' || ev.e === 'unstruct') {
    // ue_px 常包含 base64 的 self-describing event (schema + data)
    const decoded = tryDecodeBase64Json(ev.ue_px) || tryDecodeBase64Json(ev.unstruct_event) || null;
    if (decoded && decoded.self) {
      // Snowplow sometimes nests as { "schema": "...", "data": {...} } or { self: {...} }
      const schema = decoded.schema || (decoded.self && (decoded.self.vendor + '/' + decoded.self.name)) || null;
      const data = decoded.data || (decoded.self && decoded.self.data) || decoded;
      return {
        eventType: 'unstruct',
        schema,
        payload: data,
        ...common
      };
    }
    // fallback: try parse ue_px as plain JSON
    try {
      const maybe = JSON.parse(ev.ue_px);
      return { eventType: 'unstruct', payload: maybe, ...common };
    } catch {}
    return { eventType: 'unstruct', payload: ev, ...common };
  }

  // 3) 页面 / 心跳 / 其他内置（pv, pp, etc）
  if (ev.event === 'page_view' || ev.e === 'pv') {
    return {
      eventType: 'page_view',
      title: ev.pageTitle || ev.dt || null,
      url: ev.pageUrl || ev.url || null,
      referrer: ev.refr || ev.referrer || null,
      ...common
    };
  }

  // 4) 资源或其他，默认 fallback
  return { eventType: ev.e || ev.event || 'unknown', payload: ev, ...common };
}

// 主转换函数：接受 bodyText（string 或 object），返回数组 of normalized events
export async function transformSnowplowPayload(bodyText) {
  let parsed = bodyText;
  if (!parsed) return [];

  // 1) 如果是字符串，尝试 JSON.parse
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch (e) {
      // 如果是 base64 encoded JSON (某些场景)，尝试解码
      try {
        const decoded = base64DecodeToString(parsed);
        parsed = JSON.parse(decoded);
      } catch (e2) {
        // 最后退回原始文本
        return [{ eventType: 'raw_text', payload: parsed }];
      }
    }
  }

  // 2) 如果符合 payload_data schema（schema + data[]）
  if (parsed && parsed.schema && Array.isArray(parsed.data)) {
    const out = parsed.data.map(ev => parseSnowplowEvent(ev)).filter(Boolean);
    return out;
  }

  // 3) 如果传进来就是 array of events
  if (Array.isArray(parsed)) {
    return parsed.map(ev => parseSnowplowEvent(ev)).filter(Boolean);
  }

  // 4) 如果是单个 unstruct 包装（unstruct_event）
  if (parsed && parsed.unstruct_event) {
    const ud = parsed.unstruct_event;
    // ud might have schema+data or be base64; try to normalize
    const decoded = ud.data || tryDecodeBase64Json(parsed.ue_px || ud.data);
    return [ { eventType: 'unstruct', schema: ud.schema, payload: decoded || ud.data, raw: parsed } ];
  }

  // fallback: return object as a single unknown event
  return [{ eventType: 'unknown', payload: parsed }];
}
