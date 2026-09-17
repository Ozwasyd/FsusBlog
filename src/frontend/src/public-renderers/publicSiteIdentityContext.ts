import { computed, inject, provide, type ComputedRef, type InjectionKey } from 'vue';

import type { SiteComplianceConfigPublic } from '@/api/system';
import {
    normalizePublicComplianceConfig,
    normalizePublicSiteDescription,
    normalizePublicSiteTitle
} from '@/public-renderers/publicSiteIdentity';

export type PublicSiteIdentity = Readonly<{
    siteTitle: string;
    siteDescription: string;
    siteLogoUrl: string;
    siteLogoDarkUrl: string;
    siteWordmarkUrl: string;
    compliance: SiteComplianceConfigPublic | null;
    renderYear: number | null;
}>;

const PUBLIC_SITE_IDENTITY_KEY: InjectionKey<ComputedRef<PublicSiteIdentity>> = Symbol('PublicSiteIdentity');

export function createPublicSiteIdentity(input: Partial<PublicSiteIdentity> = {}): PublicSiteIdentity
{
    return {
        siteTitle: normalizePublicSiteTitle(input.siteTitle),
        siteDescription: normalizePublicSiteDescription(input.siteDescription),
        siteLogoUrl: input.siteLogoUrl?.trim() || '',
        siteLogoDarkUrl: input.siteLogoDarkUrl?.trim() || '',
        siteWordmarkUrl: input.siteWordmarkUrl?.trim() || '',
        compliance: normalizePublicComplianceConfig(input.compliance),
        renderYear: Number.isInteger(input.renderYear) ? Number(input.renderYear) : null
    };
}

export function providePublicSiteIdentity(identity: ComputedRef<PublicSiteIdentity>): void
{
    provide(PUBLIC_SITE_IDENTITY_KEY, identity);
}

export function usePublicSiteIdentity(): ComputedRef<PublicSiteIdentity>
{
    return inject(PUBLIC_SITE_IDENTITY_KEY, computed(() => createPublicSiteIdentity()));
}

export function usePublicSiteTitle(): ComputedRef<string>
{
    const identity = usePublicSiteIdentity();
    return computed(() => identity.value.siteTitle);
}

export function usePublicSiteDescription(): ComputedRef<string>
{
    const identity = usePublicSiteIdentity();
    return computed(() => identity.value.siteDescription);
}
