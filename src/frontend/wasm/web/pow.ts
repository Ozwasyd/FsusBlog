import { loadEmscriptenModule } from './runtime/emscripten';
import { resolvePowAsset, type PowAssetKind } from './runtime/assets';

export type PowModule = {
  solve_pow: (salt: string, browserFp: string, difficulty: number) => string;
  solve_pow_range: (salt: string, browserFp: string, difficulty: number, startNonce: number, step: number) => string;
};

type PowRuntimeModule = {
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  _solve_pow_c: (
    saltPtr: number,
    browserFpPtr: number,
    difficulty: number,
    outputPtr: number,
    outputLength: number
  ) => number;
  _solve_pow_range_c: (
    saltPtr: number,
    browserFpPtr: number,
    difficulty: number,
    startNonce: number,
    step: number,
    outputPtr: number,
    outputLength: number
  ) => number;
  HEAPU8: Uint8Array;
};

export type PowEngineKind = 'THREADS-SIMD' | 'RELAXED-SIMD' | 'SIMD-128' | 'SCALAR-BASIC';

type PowInitOptions = {
  assetKinds?: PowAssetKind[];
  disableThreadsTier?: boolean;
};

const powModulePromises = new Map<PowAssetKind, Promise<PowModule | null>>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const maxPowOutputBytes = 2048;

const simdProbe = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10,
  1, 8, 0, 65, 0, 253, 15, 253, 98, 11
]);

const relaxedSimdProbe = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96,
  0, 1, 123, 3, 2, 1, 0, 10, 43, 1, 41, 0,
  253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 253, 12, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 253, 128, 2, 11
]);

const threadsProbe = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96,
  0, 1, 127, 3, 2, 1, 0, 5, 4, 1, 3, 1,
  1, 10, 10, 1, 8, 0, 65, 0, 254, 16, 2, 0, 11
]);

export function supportsSimdPow(): boolean {
  return validateWasmFeature(simdProbe);
}

export function supportsRelaxedSimdPow(): boolean {
  return supportsSimdPow() && validateWasmFeature(relaxedSimdProbe);
}

export function supportsThreadedPow(): boolean {
  const scope = globalThis as { crossOriginIsolated?: boolean; SharedArrayBuffer?: typeof SharedArrayBuffer };
  return Boolean(scope.crossOriginIsolated && scope.SharedArrayBuffer) && validateWasmFeature(threadsProbe);
}

export function resolvePowEngineKind(): PowEngineKind {
  return resolvePowAssetCandidates()[0]?.engine ?? 'SCALAR-BASIC';
}

export function resolvePowAssetCandidates(options?: PowInitOptions): Array<{ kind: PowAssetKind; engine: PowEngineKind }> {
  const candidates: Array<{ kind: PowAssetKind; engine: PowEngineKind }> = [];
  const explicitKinds = options?.assetKinds;

  if (explicitKinds?.length) {
    return explicitKinds.map((kind) => ({ kind, engine: engineForAsset(kind) }));
  }

  if (!options?.disableThreadsTier && supportsThreadedPow()) {
    candidates.push({ kind: 'threads', engine: 'THREADS-SIMD' });
  }
  if (supportsRelaxedSimdPow()) {
    candidates.push({ kind: 'relaxed', engine: 'RELAXED-SIMD' });
  }
  if (supportsSimdPow()) {
    candidates.push({ kind: 'simd', engine: 'SIMD-128' });
  }
  candidates.push({ kind: 'basic', engine: 'SCALAR-BASIC' });
  return candidates;
}

function validateWasmFeature(bytes: Uint8Array): boolean {
  try {
    return typeof WebAssembly === 'object' && WebAssembly.validate(bytes as unknown as BufferSource);
  } catch {
    return false;
  }
}

function engineForAsset(kind: PowAssetKind): PowEngineKind {
  switch (kind) {
    case 'threads':
      return 'THREADS-SIMD';
    case 'relaxed':
      return 'RELAXED-SIMD';
    case 'simd':
      return 'SIMD-128';
    default:
      return 'SCALAR-BASIC';
  }
}

function writeCString(module: PowRuntimeModule, value: string): number {
  const bytes = encoder.encode(value);
  const ptr = module._malloc(bytes.length + 1);
  module.HEAPU8.set(bytes, ptr);
  module.HEAPU8[ptr + bytes.length] = 0;
  return ptr;
}

function readCString(module: PowRuntimeModule, ptr: number, maxLength: number): string {
  const heap = module.HEAPU8;
  let end = ptr;
  const limit = ptr + maxLength;
  while (end < limit && heap[end] !== 0) {
    end += 1;
  }
  return decoder.decode(heap.subarray(ptr, end));
}

function createPowFacade(module: PowRuntimeModule): PowModule {
  const callSolver = (
    salt: string,
    browserFp: string,
    difficulty: number,
    startNonce?: number,
    step?: number
  ): string => {
    const saltPtr = writeCString(module, salt);
    const fpPtr = writeCString(module, browserFp);
    const outputPtr = module._malloc(maxPowOutputBytes);

    try {
      const normalizedDifficulty = Number(difficulty) || 0;
      const resultLength = startNonce === undefined || step === undefined
        ? module._solve_pow_c(saltPtr, fpPtr, normalizedDifficulty, outputPtr, maxPowOutputBytes)
        : module._solve_pow_range_c(
          saltPtr,
          fpPtr,
          normalizedDifficulty,
          startNonce >>> 0,
          step >>> 0,
          outputPtr,
          maxPowOutputBytes
        );

      if (resultLength < 0) {
        return resultLength === -2 ? 'failed_overflow' : 'error_input_invalid';
      }

      return readCString(module, outputPtr, Math.min(resultLength + 1, maxPowOutputBytes));
    } finally {
      module._free(outputPtr);
      module._free(fpPtr);
      module._free(saltPtr);
    }
  };

  return {
    solve_pow(salt: string, browserFp: string, difficulty: number): string {
      return callSolver(salt, browserFp, difficulty);
    },
    solve_pow_range(salt: string, browserFp: string, difficulty: number, startNonce: number, step: number): string {
      return callSolver(salt, browserFp, difficulty, startNonce, Math.max(1, step >>> 0));
    }
  };
}

async function loadPowModule(assetKind: PowAssetKind): Promise<PowModule | null> {
  const cached = powModulePromises.get(assetKind);
  if (cached) {
    return cached;
  }

  const asset = resolvePowAsset(assetKind);
  const loadPromise = loadEmscriptenModule<PowRuntimeModule>(
    asset.moduleUrl,
    'createPowModule',
    asset.wasmUrl
  ).then((module) => module ? createPowFacade(module) : null);

  powModulePromises.set(assetKind, loadPromise);

  try {
    return await loadPromise;
  } catch {
    powModulePromises.delete(assetKind);
    return null;
  }
}

export async function initPowModule(options?: PowInitOptions): Promise<{ module: PowModule | null; engine: PowEngineKind; assetKind: PowAssetKind }> {
  for (const candidate of resolvePowAssetCandidates(options)) {
    const module = await loadPowModule(candidate.kind);
    if (module) {
      return { module, engine: candidate.engine, assetKind: candidate.kind };
    }
  }

  return { module: null, engine: 'SCALAR-BASIC', assetKind: 'basic' };
}
