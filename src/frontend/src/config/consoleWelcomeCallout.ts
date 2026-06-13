export const CONSOLE_WELCOME_CALLOUT_CONFIG_KEYS = [
  'ConsoleWelcomeCallout.Enabled',
  'ConsoleWelcomeCallout.ShowOnFirstRun',
  'ConsoleWelcomeCallout.ContributeUrl',
  'ConsoleWelcomeCallout.IssueUrl',
  'ConsoleWelcomeCallout.CommunityUrl',
  'ConsoleWelcomeCallout.HideForPrivateDeployment'
] as const

export type ConsoleWelcomeCalloutConfigKey = (typeof CONSOLE_WELCOME_CALLOUT_CONFIG_KEYS)[number]

export interface ConsoleWelcomeCalloutConfig {
  enabled: boolean
  showOnFirstRun: boolean
  contributeUrl: string
  issueUrl: string
  communityUrl: string
  hideForPrivateDeployment: boolean
  externalLinksEnabled: boolean
  privateDeployment: boolean
}

export interface ConsoleWelcomeCalloutLink {
  key: 'contribute' | 'issue' | 'community'
  label: string
  href: string
}

export type ConsoleWelcomeCalloutRuntimeOverride = Partial<ConsoleWelcomeCalloutConfig>

const DEFAULT_CONFIG: ConsoleWelcomeCalloutConfig = {
  enabled: true,
  showOnFirstRun: true,
  contributeUrl: '',
  issueUrl: 'https://github.com/Ozwasyd/FsusBlog/issues/new/choose',
  communityUrl: '',
  hideForPrivateDeployment: true,
  externalLinksEnabled: true,
  privateDeployment: false
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value !== 'string') {
    return fallback
  }

  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false
  }
  return fallback
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function normalizeUrl(value: unknown): string {
  const raw = readString(value)
  if (!raw) {
    return ''
  }

  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : ''
  } catch {
    return ''
  }
}

function readRuntimeOverride(): ConsoleWelcomeCalloutRuntimeOverride {
  if (typeof window === 'undefined') {
    return {}
  }

  return window.__FSUSBLOG_CONSOLE_WELCOME_CALLOUT__ ?? {}
}

function readEnvConfig(): Partial<ConsoleWelcomeCalloutConfig> {
  const env = import.meta.env
  const deploymentMode = readString(env.VITE_FSUSBLOG_DEPLOYMENT_MODE).toLowerCase()
  return {
    enabled: readBoolean(env.VITE_FSUSBLOG_CONSOLE_WELCOME_ENABLED, DEFAULT_CONFIG.enabled),
    showOnFirstRun: readBoolean(env.VITE_FSUSBLOG_CONSOLE_WELCOME_SHOW_ON_FIRST_RUN, DEFAULT_CONFIG.showOnFirstRun),
    contributeUrl: normalizeUrl(env.VITE_FSUSBLOG_CONSOLE_WELCOME_CONTRIBUTE_URL),
    issueUrl: normalizeUrl(env.VITE_FSUSBLOG_CONSOLE_WELCOME_ISSUE_URL) || DEFAULT_CONFIG.issueUrl,
    communityUrl: normalizeUrl(env.VITE_FSUSBLOG_CONSOLE_WELCOME_COMMUNITY_URL),
    hideForPrivateDeployment: readBoolean(
      env.VITE_FSUSBLOG_CONSOLE_WELCOME_HIDE_FOR_PRIVATE_DEPLOYMENT,
      DEFAULT_CONFIG.hideForPrivateDeployment
    ),
    externalLinksEnabled: readBoolean(env.VITE_FSUSBLOG_EXTERNAL_LINKS_ENABLED, DEFAULT_CONFIG.externalLinksEnabled),
    privateDeployment: readBoolean(
      env.VITE_FSUSBLOG_PRIVATE_DEPLOYMENT,
      deploymentMode === 'private' || deploymentMode === 'internal'
    )
  }
}

export function resolveConsoleWelcomeCalloutConfig(
  override: ConsoleWelcomeCalloutRuntimeOverride = {}
): ConsoleWelcomeCalloutConfig {
  const runtimeOverride = readRuntimeOverride()
  const merged = {
    ...DEFAULT_CONFIG,
    ...readEnvConfig(),
    ...runtimeOverride,
    ...override
  }

  return {
    enabled: readBoolean(merged.enabled, DEFAULT_CONFIG.enabled),
    showOnFirstRun: readBoolean(merged.showOnFirstRun, DEFAULT_CONFIG.showOnFirstRun),
    contributeUrl: normalizeUrl(merged.contributeUrl),
    issueUrl: normalizeUrl(merged.issueUrl),
    communityUrl: normalizeUrl(merged.communityUrl),
    hideForPrivateDeployment: readBoolean(merged.hideForPrivateDeployment, DEFAULT_CONFIG.hideForPrivateDeployment),
    externalLinksEnabled: readBoolean(merged.externalLinksEnabled, DEFAULT_CONFIG.externalLinksEnabled),
    privateDeployment: readBoolean(merged.privateDeployment, DEFAULT_CONFIG.privateDeployment)
  }
}

export function shouldShowConsoleWelcomeCallout(config: ConsoleWelcomeCalloutConfig): boolean {
  if (!config.enabled || !config.showOnFirstRun) {
    return false
  }

  if (!config.externalLinksEnabled) {
    return false
  }

  return !(config.privateDeployment && config.hideForPrivateDeployment)
}

export function buildConsoleWelcomeCalloutLinks(
  config: ConsoleWelcomeCalloutConfig
): ConsoleWelcomeCalloutLink[] {
  if (!shouldShowConsoleWelcomeCallout(config)) {
    return []
  }

  return [
    { key: 'contribute', label: '维护说明', href: config.contributeUrl },
    { key: 'issue', label: '新建 Issue', href: config.issueUrl },
    { key: 'community', label: '讨论区', href: config.communityUrl }
  ].filter((link): link is ConsoleWelcomeCalloutLink => Boolean(link.href))
}
