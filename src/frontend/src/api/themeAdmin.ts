import type { ThemeActivationHistoryItem, ThemeActivationItem, ThemeDetail, ThemeRegistryItem } from '@/adapters/binary/fontThemeAdminAdapter';
import { requestBinaryOnly } from '@/composition/binaryTransport';

import { FrameType } from '@wasm/protocol/frame';

export type { ThemeActivationHistoryItem, ThemeActivationItem, ThemeDetail, ThemeRegistryItem } from '@/adapters/binary/fontThemeAdminAdapter';

export function getThemeRegistry(): Promise<ThemeRegistryItem[]>
{
    return requestBinaryOnly<ThemeRegistryItem[]>({
        binaryRoute: { operationId: 'binary_get_author_ops_themes_registry' },
        frameType: FrameType.ThemeRegistryList
    });
}

export function getThemeDetail(themeId: string): Promise<ThemeDetail>
{
    return requestBinaryOnly<ThemeDetail>({
        binaryRoute: { operationId: 'binary_get_author_ops_themes_registry_themeId', params: { themeId } },
        frameType: FrameType.ThemeRegistryDetail
    });
}

export function getThemeActivations(): Promise<ThemeActivationItem[]>
{
    return requestBinaryOnly<ThemeActivationItem[]>({
        binaryRoute: { operationId: 'binary_get_author_ops_themes_activations' },
        frameType: FrameType.ThemeActivationList
    });
}

export function getThemeActivation(scope: string): Promise<ThemeActivationItem>
{
    return requestBinaryOnly<ThemeActivationItem>({
        binaryRoute: { operationId: 'binary_get_author_ops_themes_activations_scope', params: { scope } },
        frameType: FrameType.ThemeActivation
    });
}

export function getThemeActivationHistory(scope: string): Promise<ThemeActivationHistoryItem[]>
{
    return requestBinaryOnly<ThemeActivationHistoryItem[]>({
        binaryRoute: { operationId: 'binary_get_author_ops_themes_activations_scope_history', params: { scope } },
        frameType: FrameType.ThemeActivationHistory
    });
}
