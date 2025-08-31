import { v4 as uuidv4 } from 'uuid'

// 生成并保持全局 requestID
const REQUEST_ID_KEY = 'REQUEST_ID'

export function getRequestId() {
  let id = sessionStorage.getItem(REQUEST_ID_KEY)
  if (!id) {
    id = uuidv4()
    sessionStorage.setItem(REQUEST_ID_KEY, id)
  }
  return id
}

export function transformSnowplowPayload(raw) {
  // raw 可能是 array 或 object
  const event = Array.isArray(raw) ? raw[0] : raw;

  // 如果是 unstruct
  if (event && event.unstruct_event) {
    const schema = event.unstruct_event.schema || '';
    const data = event.unstruct_event.data || {};
    // schema like: iglu:com.yourcompany/js_error/jsonschema/1-0-0
    const parts = schema.split(':').pop().split('/');
    const vendor = parts[0]; // com.yourcompany
    const name = parts[1];   // js_error
    return {
      requestId: getRequestId(),
      eventType: name,
      schema,
      payload: data,
      ts: Date.now()
    };
  }

  // built-in page_view
  if (event && event.event === 'page_view') {
    return {
      requestId: getRequestId(),
      eventType: 'page_view',
      payload: {
        pageUrl: event.pageUrl || event.page_url || event.url || window.location.href,
        title: event.pageTitle || document.title,
        referrer: event.referrer || document.referrer
      },
      ts: Date.now()
    };
  }

  // fallback
  return { requestId: getRequestId(), eventType: 'unknown', payload: event, ts: Date.now() };
}
