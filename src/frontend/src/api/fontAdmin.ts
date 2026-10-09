import { requestBinaryOnly } from '@/composition/binaryTransport';
import type { FontActivationItem, FontDetail, FontRegistryItem } from '@/contracts/fontThemeAdmin';

import { FrameType } from '@wasm/protocol/frame';

export type { FontActivationItem, FontDetail, FontFaceItem, FontRegistryItem } from '@/contracts/fontThemeAdmin';

export function getFontRegistry(): Promise<FontRegistryItem[]>
{
    return requestBinaryOnly<FontRegistryItem[]>({
        binaryRoute: { operationId: 'binary_get_author_ops_fonts_registry' },
        privateScope: 'admin',
        frameType: FrameType.FontRegistryList
    });
}

export function getFontDetail(fontId: string): Promise<FontDetail>
{
    return requestBinaryOnly<FontDetail>({
        binaryRoute: { operationId: 'binary_get_author_ops_fonts_registry_fontId', params: { fontId } },
        privateScope: 'admin',
        frameType: FrameType.FontRegistryDetail
    });
}

export function getFontActivations(): Promise<FontActivationItem[]>
{
    return requestBinaryOnly<FontActivationItem[]>({
        binaryRoute: { operationId: 'binary_get_author_ops_fonts_activations' },
        privateScope: 'admin',
        frameType: FrameType.FontActivationList
    });
}
