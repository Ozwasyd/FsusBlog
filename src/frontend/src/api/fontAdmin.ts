export interface FontRegistryItem {
    fontId: string
    name: string
    family: string
    category: string
    version: string
    installState: string
    enabled: boolean
    builtIn: boolean
    faceCount: number
    criticalFaceCount: number
    totalSizeBytes: number
    installedAt: string
    updatedAt: string
}

export interface FontDetail extends FontRegistryItem {
    licenseText: string
    licenseSourceJson: string
    manifestJson: string
    faces: FontFaceItem[]
}

export interface FontFaceItem {
    weight: number
    style: string
    filePath: string
    contentHash: string
    sizeBytes: number
    unicodeRange: string | null
    critical: boolean
    fontDisplay: string
}

export interface FontActivationItem {
    scope: string
    uiFontId: string
    proseFontId: string
    codeFontId: string
    cjkFontId: string
    emojiFontId: string
    configVersion: number
    updatedAt: string
}

import { FrameType } from '@wasm/protocol/frame';

import { requestAuthoringBinary } from './authoring';

import type { ApiRequestConfig } from './requestConfig';

export function getFontRegistry(config?: ApiRequestConfig): Promise<FontRegistryItem[]>
{
    return requestAuthoringBinary<FontRegistryItem[]>('/ops/fonts/registry', FrameType.FontAdminSnapshot, config);
}

export function getFontDetail(fontId: string, config?: ApiRequestConfig): Promise<FontDetail>
{
    return requestAuthoringBinary<FontDetail>(
        `/ops/fonts/registry/${encodeURIComponent(fontId)}`,
        FrameType.FontAdminSnapshot,
        config
    );
}

export function getFontActivations(config?: ApiRequestConfig): Promise<FontActivationItem[]>
{
    return requestAuthoringBinary<FontActivationItem[]>('/ops/fonts/activations', FrameType.FontAdminSnapshot, config);
}
