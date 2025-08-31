export const JS_ERROR_SCHEMA = {
  title: 'JavaScript Error',
  description: 'Schema for tracking JavaScript errors via Snowplow',
  type: 'object',
  properties: {
    errorMessage: { type: 'string' },
    errorName: { type: 'string' },
    stackTrace: { type: 'string' },
    fileName: { type: 'string' },
    lineNumber: { type: 'integer' },
    columnNumber: { type: 'integer' },
    userAgent: { type: 'string' },
    url: { type: 'string', format: 'uri' },
    timestamp: { type: 'string', format: 'date-time' }
  },
  required: ['errorMessage', 'errorName', 'timestamp']
}

export const RESOURCE_ERROR_SCHEMA = {
  title: 'Resource Loading Error',
  description: 'Schema for tracking resource loading errors via Snowplow',
  type: 'object',
  properties: {
    resourceUrl: { type: 'string', format: 'uri' },
    statusCode: { type: 'integer' },
    method: { type: 'string' },
    errorMessage: { type: 'string' },
    initiatorType: { type: 'string' },
    pageUrl: { type: 'string', format: 'uri' },
    userAgent: { type: 'string' },
    timestamp: { type: 'string', format: 'date-time' }
  },
  required: ['resourceUrl', 'initiatorType', 'timestamp']
}

// 通用默认 schema，只保证最小字段 timestamp
export const DEFAULT_SCHEMA = {
  title: "Generic Event",
  description: "通用自定义事件 schema",
  type: "object",
  properties: {
    timestamp: { type: "string", format: "date-time" }
  },
  required: ["timestamp"]
}
