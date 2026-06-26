const regionDisplayNames: Record<string, string> = {
  GLOBAL: '全局',
  UNKNOWN: '未知地区',
  APAC: '亚太',
  COMMONWEALTH: '英联邦地区',
  GREATER_CHINA: '大中华区',
  NORTH_AMERICA: '北美',
  EUROPE_NON_EU: '欧洲非欧盟地区',
  SEA: '东南亚',
  AU: '澳大利亚',
  CA: '加拿大',
  'CN-MAINLAND': '中国大陆',
  'CN-HK': '中国香港',
  'CN-MO': '中国澳门',
  'CN-TW': '中国台湾',
  EU: '欧盟',
  'EU-DE': '德国',
  'EU-FR': '法国',
  'EU-NL': '荷兰',
  JP: '日本',
  KR: '韩国',
  NZ: '新西兰',
  SG: '新加坡',
  UK: '英国',
  US: '美国',
  'US-CA': '加利福尼亚',
  'US-TX': '得克萨斯'
}

const policyTemplateDisplayNames: Record<string, string> = {
  'global-baseline': '全局基线',
  'cn-mainland-strict': '中国大陆严格策略',
  'eu-illegal-content-baseline': '欧盟非法内容基线',
  'SEAsg-public-harmony-baseline': '新加坡公共秩序基线',
  'sg-public-harmony-baseline': '新加坡公共秩序基线',
  'us-platform-policy-baseline': '美国平台策略基线',
  'uk-online-safety-baseline': '英国网络安全基线'
}

const sourceTypeLabels: Record<string, string> = {
  GLOBAL: '全局',
  REGION: '地区',
  GROUP: '大区',
  POLICY_TEMPLATE: '策略模板',
  DICTIONARY: '词库',
  BUILTIN: '内置',
  CUSTOM: '自定义',
  template: '策略模板',
  dictionary: '词库',
  region: '地区',
  group: '大区',
  global: '全局'
}

const riskCategoryLabels: Record<string, string> = {
  child_safety: '儿童安全',
  contact_lead: '联系方式引导',
  gambling: '赌博',
  harassment: '骚扰',
  hate_speech: '仇恨言论',
  html_risk: 'HTML 风险',
  malicious_link: '恶意链接',
  national_security_risk: '国家安全风险',
  political_sensitive: '政治敏感',
  pornographic: '色情内容',
  public_order_risk: '公共秩序风险',
  scam: '欺诈',
  sexual_explicit: '露骨性内容',
  sexual_suggestion: '性暗示',
  sexual_suggestion_high: '高风险性暗示',
  spam_repeat: '重复垃圾内容',
  terrorism_extremism: '恐怖主义与极端主义',
  violence_extreme: '极端暴力'
}

const moderationActionLabels: Record<string, string> = {
  allow: '允许',
  manual_review: '人工审核',
  manual_review_no_public_display: '人工审核；审核前不公开',
  reject_submit: '拒绝提交',
  geo_block: '按地区屏蔽'
}

export const formatModerationRegionName = (region?: string | null): string => {
  if (!region) return '无'
  return regionDisplayNames[region] ?? region
}

export const formatModerationRegionVersion = (version?: string | null): string => {
  if (!version) return '无'

  if (policyTemplateDisplayNames[version]) {
    return policyTemplateDisplayNames[version]
  }

  const regionPrefix = Object.keys(regionDisplayNames)
    .sort((left, right) => right.length - left.length)
    .find((region) => version.startsWith(`${region}-`))

  if (!regionPrefix) {
    return version
  }

  return version.slice(regionPrefix.length + 1).replace(/^v/i, '')
}

export const formatModerationSourceType = (sourceType?: string | null): string => {
  if (!sourceType) return '无'
  return sourceTypeLabels[sourceType] ?? sourceType
}

export const formatModerationRiskCategory = (category?: string | null): string => {
  if (!category) return '无'
  return riskCategoryLabels[category] ?? category
}

export const formatModerationAction = (action?: string | null): string => {
  if (!action) return '无'
  return moderationActionLabels[action] ?? action
}
