import { isCanonicalReleaseId } from '../../../src/generated/releaseIdContract';

const baseUrl = (import.meta.env?.BASE_URL || '/').replace(/\/?$/, '/');
const frontendBuildId = import.meta.env?.VITE_FSUSBLOG_BUILD_ID?.trim() || '';
const releaseAssetBase = isCanonicalReleaseId(frontendBuildId)
  ? `${baseUrl}release-assets/${frontendBuildId}/`
  : baseUrl;

export const WASM_PUBLIC_BASE = `${releaseAssetBase}wasm`;

export const AEDS_RUNTIME_MANIFEST_URL = `${WASM_PUBLIC_BASE}/aeds-runtime-manifest.json`;
export const AEDS_BASIC_MODULE_URL = `${WASM_PUBLIC_BASE}/aeds_decoder_basic.js`;
export const AEDS_BASIC_WASM_URL = `${WASM_PUBLIC_BASE}/aeds_decoder_basic.wasm`;
export const AEDS_SPEED_MODULE_URL = `${WASM_PUBLIC_BASE}/aeds_decoder_speed.js`;
export const AEDS_SPEED_WASM_URL = `${WASM_PUBLIC_BASE}/aeds_decoder_speed.wasm`;

export type AedsAssetKind = 'basic' | 'speed';

export function resolveAedsAsset(kind: AedsAssetKind): { moduleUrl: string; wasmUrl: string } {
  return kind === 'speed'
    ? { moduleUrl: AEDS_SPEED_MODULE_URL, wasmUrl: AEDS_SPEED_WASM_URL }
    : { moduleUrl: AEDS_BASIC_MODULE_URL, wasmUrl: AEDS_BASIC_WASM_URL };
}

export const POW_SIMD_MODULE_URL = `${WASM_PUBLIC_BASE}/fsus_pow_simd.js`;
export const POW_SIMD_WASM_URL = `${WASM_PUBLIC_BASE}/fsus_pow_simd.wasm`;
export const POW_RELAXED_MODULE_URL = `${WASM_PUBLIC_BASE}/fsus_pow_relaxed.js`;
export const POW_RELAXED_WASM_URL = `${WASM_PUBLIC_BASE}/fsus_pow_relaxed.wasm`;
export const POW_THREADS_MODULE_URL = `${WASM_PUBLIC_BASE}/fsus_pow_threads.js`;
export const POW_THREADS_WASM_URL = `${WASM_PUBLIC_BASE}/fsus_pow_threads.wasm`;
export const POW_BASIC_MODULE_URL = `${WASM_PUBLIC_BASE}/fsus_pow_basic.js`;
export const POW_BASIC_WASM_URL = `${WASM_PUBLIC_BASE}/fsus_pow_basic.wasm`;

export type PowAssetKind = 'threads' | 'relaxed' | 'simd' | 'basic';

export const IMAGE_CODEC_SIMD_MODULE_URL = `${WASM_PUBLIC_BASE}/image_codec_simd.js`;
export const IMAGE_CODEC_SIMD_WASM_URL = `${WASM_PUBLIC_BASE}/image_codec_simd.wasm`;
export const IMAGE_CODEC_BASIC_MODULE_URL = `${WASM_PUBLIC_BASE}/image_codec_basic.js`;
export const IMAGE_CODEC_BASIC_WASM_URL = `${WASM_PUBLIC_BASE}/image_codec_basic.wasm`;
export const SEARCH_SIMD_MODULE_URL = `${WASM_PUBLIC_BASE}/search_simd.js`;
export const SEARCH_SIMD_WASM_URL = `${WASM_PUBLIC_BASE}/search_simd.wasm`;
export const SEARCH_BASIC_MODULE_URL = `${WASM_PUBLIC_BASE}/search_basic.js`;
export const SEARCH_BASIC_WASM_URL = `${WASM_PUBLIC_BASE}/search_basic.wasm`;

export type ImageCodecAssetKind = 'simd' | 'basic';
export type SearchAssetKind = 'simd' | 'basic';

export function resolvePowAsset(kind: PowAssetKind): { moduleUrl: string; wasmUrl: string } {
  switch (kind) {
    case 'threads':
      return { moduleUrl: POW_THREADS_MODULE_URL, wasmUrl: POW_THREADS_WASM_URL };
    case 'relaxed':
      return { moduleUrl: POW_RELAXED_MODULE_URL, wasmUrl: POW_RELAXED_WASM_URL };
    case 'simd':
      return { moduleUrl: POW_SIMD_MODULE_URL, wasmUrl: POW_SIMD_WASM_URL };
    default:
      return { moduleUrl: POW_BASIC_MODULE_URL, wasmUrl: POW_BASIC_WASM_URL };
  }
}

export function resolveImageCodecAsset(kind: ImageCodecAssetKind): { moduleUrl: string; wasmUrl: string } {
  return kind === 'simd'
    ? { moduleUrl: IMAGE_CODEC_SIMD_MODULE_URL, wasmUrl: IMAGE_CODEC_SIMD_WASM_URL }
    : { moduleUrl: IMAGE_CODEC_BASIC_MODULE_URL, wasmUrl: IMAGE_CODEC_BASIC_WASM_URL };
}

export function resolveSearchAsset(kind: SearchAssetKind): { moduleUrl: string; wasmUrl: string } {
  return kind === 'simd'
    ? { moduleUrl: SEARCH_SIMD_MODULE_URL, wasmUrl: SEARCH_SIMD_WASM_URL }
    : { moduleUrl: SEARCH_BASIC_MODULE_URL, wasmUrl: SEARCH_BASIC_WASM_URL };
}
