import { getErrorHandler, reportJsError } from './utils/ErrorHandler'
import { initFrontendTracker, trackClick, trackCustomEvent } from './initSnowplow'

export {
  initFrontendTracker,
  trackClick,
  trackCustomEvent,
  getErrorHandler,
  reportJsError
}
