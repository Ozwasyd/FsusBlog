export interface ThemeRegistryItem {
    themeId: string;
    name: string;
    version: string;
    author: string;
    description: string;
    type: string;
    installState: string;
    enabled: boolean;
    packageHash: string;
    packageLocation: string;
    installedAtUtc: string;
    updatedAtUtc: string;
}

export interface ThemeDetail extends ThemeRegistryItem {
    manifestJson: string;
    configSchemaJson: string;
    modes: string[];
    supports: Record<string, boolean>;
    budgets: Record<string, number>;
    permissions: Record<string, boolean>;
}

export interface ThemeActivationItem {
    scope: string;
    activeThemeId: string | null;
    mode: string | null;
    activationId: string | null;
    assetVersion: string | null;
    configVersion: number | null;
    updatedAtUtc: string | null;
}

export interface ThemeActivationHistoryItem {
    id: string;
    scope: string;
    themeId: string | null;
    previousThemeId: string | null;
    assetVersion: string | null;
    previousAssetVersion: string | null;
    configVersion: number | null;
    previousConfigVersion: number | null;
    mode: string | null;
    previousMode: string | null;
    status: string;
    failureReason: string | null;
    startedAtUtc: string;
    completedAtUtc: string;
    activatedBy: string;
}

import { getBinary } from './binaryClient';

export function getThemeRegistry(): Promise<ThemeRegistryItem[]>
{
    return getBinary('/api/binary/author/ops/themes/registry');
}

export function getThemeDetail(themeId: string): Promise<ThemeDetail>
{
    return getBinary(`/api/binary/author/ops/themes/registry/${encodeURIComponent(themeId)}`);
}

export function getThemeActivations(): Promise<ThemeActivationItem[]>
{
    return getBinary('/api/binary/author/ops/themes/activations');
}

export function getThemeActivation(scope: string): Promise<ThemeActivationItem>
{
    return getBinary(`/api/binary/author/ops/themes/activations/${encodeURIComponent(scope)}`);
}

export function getThemeActivationHistory(scope: string): Promise<ThemeActivationHistoryItem[]>
{
    return getBinary(`/api/binary/author/ops/themes/activations/${encodeURIComponent(scope)}/history`);
}
