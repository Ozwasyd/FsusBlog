const baseUrl = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

export const WASM_PUBLIC_BASE = `${baseUrl}wasm`;

export const AEDS_MODULE_URL = `${WASM_PUBLIC_BASE}/aeds_decoder.js`;
export const AEDS_WASM_URL = `${WASM_PUBLIC_BASE}/aeds_decoder.wasm`;

export const POW_SIMD_MODULE_URL = `${WASM_PUBLIC_BASE}/fsus_pow_simd.js`;
export const POW_SIMD_WASM_URL = `${WASM_PUBLIC_BASE}/fsus_pow_simd.wasm`;
export const POW_BASIC_MODULE_URL = `${WASM_PUBLIC_BASE}/fsus_pow_basic.js`;
export const POW_BASIC_WASM_URL = `${WASM_PUBLIC_BASE}/fsus_pow_basic.wasm`;

export type PowAssetKind = 'simd' | 'basic';

export const MARKDOWN_SIMD_MODULE_URL = `${WASM_PUBLIC_BASE}/markdown_simd.js`;
export const MARKDOWN_SIMD_WASM_URL = `${WASM_PUBLIC_BASE}/markdown_simd.wasm`;
export const MARKDOWN_BASIC_MODULE_URL = `${WASM_PUBLIC_BASE}/markdown_basic.js`;
export const MARKDOWN_BASIC_WASM_URL = `${WASM_PUBLIC_BASE}/markdown_basic.wasm`;

export type MarkdownAssetKind = 'simd' | 'basic';

export function resolvePowAsset(kind: PowAssetKind): { moduleUrl: string; wasmUrl: string } {
  return kind === 'simd'
    ? { moduleUrl: POW_SIMD_MODULE_URL, wasmUrl: POW_SIMD_WASM_URL }
    : { moduleUrl: POW_BASIC_MODULE_URL, wasmUrl: POW_BASIC_WASM_URL };
}

export function resolveMarkdownAsset(kind: MarkdownAssetKind): { moduleUrl: string; wasmUrl: string } {
  return kind === 'simd'
    ? { moduleUrl: MARKDOWN_SIMD_MODULE_URL, wasmUrl: MARKDOWN_SIMD_WASM_URL }
    : { moduleUrl: MARKDOWN_BASIC_MODULE_URL, wasmUrl: MARKDOWN_BASIC_WASM_URL };
}
