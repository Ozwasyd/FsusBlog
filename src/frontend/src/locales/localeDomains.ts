import type { admin } from './zh-CN/admin';
import type { article } from './zh-CN/article';
import type { auth } from './zh-CN/auth';
import type { common } from './zh-CN/common';
import type { errors } from './zh-CN/errors';
import type { identity } from './zh-CN/identity';
import type { layout } from './zh-CN/layout';
import type { messages } from './zh-CN/messages';
import type { publicMessages } from './zh-CN/public';
import type { security } from './zh-CN/security';

export const LOCALE_DOMAINS = Object.freeze([
    'common',
    'public',
    'article',
    'auth',
    'identity',
    'layout',
    'messages',
    'security',
    'admin',
    'errors'
] as const);

export type LocaleDomain = typeof LOCALE_DOMAINS[number];

export type LocaleDomainIdentity<
    Locale extends string = string,
    Domain extends LocaleDomain = LocaleDomain
> = Readonly<{
    locale: Locale;
    domain: Domain;
}>;

export type LocaleDomainArtifactMap = Readonly<{
    common: typeof common;
    public: typeof publicMessages;
    article: typeof article;
    auth: typeof auth;
    identity: typeof identity;
    layout: typeof layout;
    messages: typeof messages;
    security: typeof security;
    admin: typeof admin;
    errors: typeof errors;
}>;

export type LocaleDomainArtifact<Domain extends LocaleDomain = LocaleDomain> =
    LocaleDomainArtifactMap[Domain];

export type LocaleMessages = LocaleDomainArtifactMap;

export function isLocaleDomain(value: unknown): value is LocaleDomain
{
    return typeof value === 'string' && (LOCALE_DOMAINS as readonly string[]).includes(value);
}
