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

import { getBinary } from './binaryClient'

export function getFontRegistry(): Promise<FontRegistryItem[]> {
    return getBinary('/api/binary/author/ops/fonts/registry')
}

export function getFontDetail(fontId: string): Promise<FontDetail> {
    return getBinary(`/api/binary/author/ops/fonts/registry/${encodeURIComponent(fontId)}`)
}

export function getFontActivations(): Promise<FontActivationItem[]> {
    return getBinary('/api/binary/author/ops/fonts/activations')
}
