export const CONSOLE_WELCOME_CALLOUT_CONFIG_KEYS = [
    'ConsoleWelcomeCallout.ContributeUrl',
    'ConsoleWelcomeCallout.IssueUrl',
    'ConsoleWelcomeCallout.CommunityUrl',
    'ConsoleWelcomeCallout.HideForPrivateDeployment'
] as const;

export type ConsoleWelcomeCalloutConfigKey = (typeof CONSOLE_WELCOME_CALLOUT_CONFIG_KEYS)[number];

export interface ConsoleWelcomeCalloutConfig {
    contributeUrl: string;
    issueUrl: string;
    communityUrl: string;
    hideForPrivateDeployment: boolean;
    externalLinksEnabled: boolean;
    privateDeployment: boolean;
}

export interface ConsoleSupportLink {
    key: 'contribute' | 'issue' | 'community';
    label: string;
    href: string;
}

export type ConsoleWelcomeCalloutRuntimeOverride = Partial<ConsoleWelcomeCalloutConfig>;

const DEFAULT_CONFIG: ConsoleWelcomeCalloutConfig = {
    contributeUrl: '',
    issueUrl: 'https://github.com/Ozwasyd/FsusBlog/issues/new/choose',
    communityUrl: '',
    hideForPrivateDeployment: true,
    externalLinksEnabled: true,
    privateDeployment: false
};

function readBoolean(value: unknown, fallback: boolean): boolean
{
    if (typeof value === 'boolean')
    {
        return value;
    }

    if (typeof value !== 'string')
    {
        return fallback;
    }

    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized))
    {
        return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized))
    {
        return false;
    }
    return fallback;
}

function readString(value: unknown, fallback = ''): string
{
    return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeUrl(value: unknown): string
{
    const raw = readString(value);
    if (!raw)
    {
        return '';
    }

    try
    {
        const url = new URL(raw);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
    }
    catch
    {
        return '';
    }
}

function readRuntimeOverride(): ConsoleWelcomeCalloutRuntimeOverride
{
    if (typeof window === 'undefined')
    {
        return {};
    }

    return window.__FSUSBLOG_CONSOLE_WELCOME_CALLOUT__ ?? {};
}

function readEnvConfig(): Partial<ConsoleWelcomeCalloutConfig>
{
    const env = import.meta.env;
    const deploymentMode = readString(env.VITE_FSUSBLOG_DEPLOYMENT_MODE).toLowerCase();
    return {
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
    };
}

export function resolveConsoleWelcomeCalloutConfig(
    override: ConsoleWelcomeCalloutRuntimeOverride = {}
): ConsoleWelcomeCalloutConfig
{
    const runtimeOverride = readRuntimeOverride();
    const merged = {
        ...DEFAULT_CONFIG,
        ...readEnvConfig(),
        ...runtimeOverride,
        ...override
    };

    return {
        contributeUrl: normalizeUrl(merged.contributeUrl),
        issueUrl: normalizeUrl(merged.issueUrl),
        communityUrl: normalizeUrl(merged.communityUrl),
        hideForPrivateDeployment: readBoolean(merged.hideForPrivateDeployment, DEFAULT_CONFIG.hideForPrivateDeployment),
        externalLinksEnabled: readBoolean(merged.externalLinksEnabled, DEFAULT_CONFIG.externalLinksEnabled),
        privateDeployment: readBoolean(merged.privateDeployment, DEFAULT_CONFIG.privateDeployment)
    };
}

export function buildConsoleSupportLinks(
    config: ConsoleWelcomeCalloutConfig
): ConsoleSupportLink[]
{
    if (!config.externalLinksEnabled)
    {
        return [];
    }

    if (config.privateDeployment && config.hideForPrivateDeployment)
    {
        return [];
    }

    return [
        { key: 'contribute', label: '查看维护说明', href: config.contributeUrl },
        { key: 'issue', label: '提交问题', href: config.issueUrl },
        { key: 'community', label: '参与讨论', href: config.communityUrl }
    ].filter((link): link is ConsoleSupportLink => Boolean(link.href));
}
