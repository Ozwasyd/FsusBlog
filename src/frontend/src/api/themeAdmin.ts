export interface ThemeRegistryItem {
    themeId: string
    name: string
    version: string
    author: string
    description: string
    type: string
    installState: string
    enabled: boolean
    packageHash: string
    packageLocation: string
    installedAtUtc: string
    updatedAtUtc: string
}

export interface ThemeDetail extends ThemeRegistryItem {
    manifestJson: string
    configSchemaJson: string
    modes: string[]
    supports: Record<string, boolean>
    budgets: Record<string, number>
    permissions: Record<string, boolean>
}

export interface ThemeActivationItem {
    scope: string
    activeThemeId: string | null
    mode: string | null
    activationId: string | null
    assetVersion: string | null
    configVersion: number | null
    updatedAtUtc: string | null
}

export interface ThemeActivationHistoryItem {
    id: string
    scope: string
    themeId: string | null
    previousThemeId: string | null
    assetVersion: string | null
    previousAssetVersion: string | null
    configVersion: number | null
    previousConfigVersion: number | null
    mode: string | null
    previousMode: string | null
    status: string
    failureReason: string | null
    startedAtUtc: string
    completedAtUtc: string
    activatedBy: string
}

import { FrameType } from '@wasm/protocol/frame';

import { requestAuthoringBinary } from './authoring';

import type { ApiRequestConfig } from './requestConfig';

export function getThemeRegistry(config?: ApiRequestConfig): Promise<ThemeRegistryItem[]>
{
    return requestAuthoringBinary<ThemeRegistryItem[]>('/ops/themes/registry', FrameType.ThemeAdminSnapshot, config);
}

export function getThemeDetail(themeId: string, config?: ApiRequestConfig): Promise<ThemeDetail>
{
    return requestAuthoringBinary<ThemeDetail>(
        `/ops/themes/registry/${encodeURIComponent(themeId)}`,
        FrameType.ThemeAdminSnapshot,
        config
    );
}

export function getThemeActivations(config?: ApiRequestConfig): Promise<ThemeActivationItem[]>
{
    return requestAuthoringBinary<ThemeActivationItem[]>('/ops/themes/activations', FrameType.ThemeAdminSnapshot, config);
}

export function getThemeActivation(scope: string, config?: ApiRequestConfig): Promise<ThemeActivationItem>
{
    return requestAuthoringBinary<ThemeActivationItem>(
        `/ops/themes/activations/${encodeURIComponent(scope)}`,
        FrameType.ThemeAdminSnapshot,
        config
    );
}

export function getThemeActivationHistory(scope: string, config?: ApiRequestConfig): Promise<ThemeActivationHistoryItem[]>
{
    return requestAuthoringBinary<ThemeActivationHistoryItem[]>(
        `/ops/themes/activations/${encodeURIComponent(scope)}/history`,
        FrameType.ThemeAdminSnapshot,
        config
    );
}
