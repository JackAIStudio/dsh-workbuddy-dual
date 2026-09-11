declare const __DSH_WORKBUDDY_DUAL_VERSION__: string | undefined

export const WORKBUDDY_DUAL_VERSION = typeof __DSH_WORKBUDDY_DUAL_VERSION__ === 'string'
  ? __DSH_WORKBUDDY_DUAL_VERSION__
  : '0.1.0'
