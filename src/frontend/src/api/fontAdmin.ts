import type { FontActivationItem, FontDetail, FontRegistryItem } from '@/adapters/binary/fontThemeAdminAdapter';
import { requestBinaryOnly } from '@/composition/binaryTransport';

import { FrameType } from '@wasm/protocol/frame';

export type { FontActivationItem, FontDetail, FontFaceItem, FontRegistryItem } from '@/adapters/binary/fontThemeAdminAdapter';

export function getFontRegistry(): Promise<FontRegistryItem[]>
{
    return requestBinaryOnly<FontRegistryItem[]>({
        binaryRoute: { operationId: 'binary_get_author_ops_fonts_registry' },
        frameType: FrameType.FontRegistryList
    });
}

export function getFontDetail(fontId: string): Promise<FontDetail>
{
    return requestBinaryOnly<FontDetail>({
        binaryRoute: { operationId: 'binary_get_author_ops_fonts_registry_fontId', params: { fontId } },
        frameType: FrameType.FontRegistryDetail
    });
}

export function getFontActivations(): Promise<FontActivationItem[]>
{
    return requestBinaryOnly<FontActivationItem[]>({
        binaryRoute: { operationId: 'binary_get_author_ops_fonts_activations' },
        frameType: FrameType.FontActivationList
    });
}
