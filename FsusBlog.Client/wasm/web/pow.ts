import { loadEmscriptenModule } from './runtime/emscripten';
import { resolvePowAsset, type PowAssetKind } from './runtime/assets';

export type PowModule = {
  solve_pow: (salt: string, browserFp: string, difficulty: number) => string;
};

export type PowEngineKind = 'SIMD-128' | 'SCALAR-BASIC';

const powModulePromises = new Map<PowAssetKind, Promise<PowModule | null>>();

export function supportsSimdPow(): boolean {
  try {
    const simdProbe = new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0,
      1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10,
      1, 8, 0, 65, 0, 253, 15, 253, 98, 11
    ]);
    return WebAssembly.validate(simdProbe);
  } catch {
    return false;
  }
}

export function resolvePowEngineKind(): PowEngineKind {
  return supportsSimdPow() ? 'SIMD-128' : 'SCALAR-BASIC';
}

function resolvePowAssetKind(): PowAssetKind {
  return supportsSimdPow() ? 'simd' : 'basic';
}

export async function initPowModule(): Promise<{ module: PowModule | null; engine: PowEngineKind }> {
  const assetKind = resolvePowAssetKind();
  const engine = assetKind === 'simd' ? 'SIMD-128' : 'SCALAR-BASIC';
  const cached = powModulePromises.get(assetKind);
  if (cached) {
    return { module: await cached, engine };
  }

  const asset = resolvePowAsset(assetKind);
  const loadPromise = loadEmscriptenModule<PowModule>(
    asset.moduleUrl,
    'createPowModule',
    asset.wasmUrl
  );

  powModulePromises.set(assetKind, loadPromise);
  const module = await loadPromise;
  if (!module) {
    powModulePromises.delete(assetKind);
  }

  return { module, engine };
}
