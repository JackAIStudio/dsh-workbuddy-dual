export const en = {
  title: 'DSH WorkBuddy Dual',
  intro: 'Simultaneously connect WorkBuddy CN and Global models into DeepSeek Harness — dual-track, zero configuration.',
  expand: 'Expand',
  collapse: 'Collapse',
  loading: 'Loading accounts…',
  cnSection: '🇨🇳 WorkBuddy CN',
  globalSection: '🌍 WorkBuddy Global',
  signedOut: 'Not signed in',
  signedInAs: 'Signed in as {nickname}',
  accessTokenExpires: 'Expires {time}',
  creditsTotal: 'Credits: {total}',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  requestFailed: 'Request failed',
  freeModel: 'Free',
} as const

export type WorkBuddyDualSettingsKey = keyof typeof en

export const zh: Record<WorkBuddyDualSettingsKey, string> = {
  title: 'DSH WorkBuddy Dual (双轨版)',
  intro: '同时接入 WorkBuddy 国内版与海外版模型，双轨并发、免配置使用。',
  expand: '展开',
  collapse: '收起',
  loading: '正在读取双端账号…',
  cnSection: '🇨🇳 WorkBuddy 国内版',
  globalSection: '🌍 WorkBuddy 海外版',
  signedOut: '未登录',
  signedInAs: '已登录：{nickname}',
  accessTokenExpires: '到期时间：{time}',
  creditsTotal: '剩余积分：{total}',
  refresh: '刷新状态',
  refreshing: '正在刷新…',
  requestFailed: '请求失败',
  freeModel: '免费',
}
