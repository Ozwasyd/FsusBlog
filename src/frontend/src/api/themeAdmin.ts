import { requestBinaryOnly } from '@/composition/binaryTransport';
import type { ThemeActivationHistoryItem, ThemeActivationItem, ThemeDetail, ThemeRegistryItem } from '@/contracts/fontThemeAdmin';

import { FrameType } from '@wasm/protocol/frame';

export type { ThemeActivationHistoryItem, ThemeActivationItem, ThemeDetail, ThemeRegistryItem } from '@/contracts/fontThemeAdmin';

export function getThemeRegistry(): Promise<ThemeRegistryItem[]>
{
    return requestBinaryOnly<ThemeRegistryItem[]>({
        binaryRoute: { operationId: 'binary_get_author_ops_themes_registry' },
        privateScope: 'admin',
        frameType: FrameType.ThemeRegistryList
    });
}

export function getThemeDetail(themeId: string): Promise<ThemeDetail>
{
    return requestBinaryOnly<ThemeDetail>({
        binaryRoute: { operationId: 'binary_get_author_ops_themes_registry_themeId', params: { themeId } },
        privateScope: 'admin',
        frameType: FrameType.ThemeRegistryDetail
    });
}

export function getThemeActivations(): Promise<ThemeActivationItem[]>
{
    return requestBinaryOnly<ThemeActivationItem[]>({
        binaryRoute: { operationId: 'binary_get_author_ops_themes_activations' },
        privateScope: 'admin',
        frameType: FrameType.ThemeActivationList
    });
}

export function getThemeActivation(scope: string): Promise<ThemeActivationItem>
{
    return requestBinaryOnly<ThemeActivationItem>({
        binaryRoute: { operationId: 'binary_get_author_ops_themes_activations_scope', params: { scope } },
        privateScope: 'admin',
        frameType: FrameType.ThemeActivation
    });
}

export function getThemeActivationHistory(scope: string): Promise<ThemeActivationHistoryItem[]>
{
    return requestBinaryOnly<ThemeActivationHistoryItem[]>({
        binaryRoute: { operationId: 'binary_get_author_ops_themes_activations_scope_history', params: { scope } },
        privateScope: 'admin',
        frameType: FrameType.ThemeActivationHistory
    });
}
