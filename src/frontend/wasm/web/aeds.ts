import { AEDS_HEADER_LENGTH, AEDS_MAGIC, AEDS_VERSION, FrameType } from './protocol/frame';
import {
  AEDS_RUNTIME_MANIFEST_URL,
  resolveAedsAsset,
  type AedsAssetKind
} from './runtime/assets';
import { loadEmscriptenModule, type EmscriptenLoadMetrics } from './runtime/emscripten';
import { AppErrorCode, createAppError } from '@/utils/appError';

export const AEDS_WASM_ABI = 'fsusblog.aeds.v4';
export const AEDS_MAX_FRAME_BYTES = 8 * 1024 * 1024;

type WasmAddress = number | bigint;
type WasmHandleToken = bigint;

interface AedsWasmExports {
  memory: WebAssembly.Memory;
  reserve_io_buffer(size: number): WasmHandleToken;
  get_io_buffer_ptr(token: WasmHandleToken): WasmAddress;
  decode_io_buffer(token: WasmHandleToken, len: number): number;
  clear_io_buffer(releaseMemory: number): void;
  get_io_buffer_capacity(): number;
  get_arena_reallocation_count(): number;
  get_arena_clear_count(): number;
  get_last_payload_token(): WasmHandleToken;
  get_last_payload_ptr(token: WasmHandleToken): WasmAddress;
  get_last_payload_len(token: WasmHandleToken): number;
  get_last_frame_type(token: WasmHandleToken): number;
  get_last_error_ptr(): WasmAddress;
  get_last_error_len(): number;
}

type AedsModuleInstance = {
  HEAPU8: Uint8Array;
  _reserve_io_buffer: (size: number) => WasmHandleToken;
  _get_io_buffer_ptr: (token: WasmHandleToken) => WasmAddress;
  _decode_io_buffer: (token: WasmHandleToken, len: number) => number;
  _clear_io_buffer: (releaseMemory: number) => void;
  _get_io_buffer_capacity: () => number;
  _get_arena_reallocation_count: () => number;
  _get_arena_clear_count: () => number;
  _get_last_payload_token: () => WasmHandleToken;
  _get_last_payload_ptr: (token: WasmHandleToken) => WasmAddress;
  _get_last_payload_len: (token: WasmHandleToken) => number;
  _get_last_frame_type: (token: WasmHandleToken) => number;
  _get_last_error_ptr: () => WasmAddress;
  _get_last_error_len: () => number;
};

export type AedsTierManifest = {
  module: string;
  wasm: string;
  moduleSha256: string;
  wasmSha256: string;
  simd: boolean;
  lto: boolean;
  wasmOptValidated: boolean;
  initialMemoryBytes: number;
  maximumMemoryBytes: number;
  memoryGrowth: 'bounded' | 'disabled';
};

export type AedsToolchainManifest = {
  emscriptenVersion: string;
  binaryenVersion: string;
  cmakeVersion: string;
  vcpkgCommit: string;
  emsdkImage: string;
};

export type AedsRuntimeManifest = {
  schema: 'fsusblog.aeds-runtime.v1';
  abi: string;
  maxFrameBytes: number;
  workerModel: {
    instancesPerPage: 1;
    activeRequests: {
      source: 'runtime-logical-processors';
      minimum: number;
      maximum: number;
      logicalProcessorsPerRequest: number;
    };
  };
  toolchain: AedsToolchainManifest;
  tiers: Record<AedsAssetKind, AedsTierManifest>;
};

export type AedsResolvedWorkerModel = {
  resourceSource: 'navigator.hardwareConcurrency' | 'fallback';
  logicalProcessors: number;
  instancesPerPage: 1;
  activeRequests: number;
  minimumActiveRequests: number;
  maximumActiveRequests: number;
};

export const AEDS_WORKER_MODEL = {
  instancesPerPage: 1,
  activeRequests: {
    source: 'runtime-logical-processors',
    minimum: 1,
    maximum: 8,
    logicalProcessorsPerRequest: 2
  }
} as const;

export type AedsRuntimeDiagnostics = {
  abi: string;
  selectedTier: AedsAssetKind | 'none';
  simdSupported: boolean | null;
  fallbackReason: string | null;
  selectionCount: Record<AedsAssetKind, number>;
  fallbackCount: number;
  load: EmscriptenLoadMetrics | null;
  workerModel: AedsResolvedWorkerModel;
  decodeCount: number;
  decodedBytes: number;
  jsToWasmCopiedBytes: number;
  wasmToJsCopiedBytes: number;
  arenaCapacityBytes: number;
  arenaReallocationCount: number;
  arenaClearCount: number;
  initialPages: number;
  peakPages: number;
  growCount: number;
  decodeMsTotal: number;
  frameBuckets: Record<string, { count: number; p50Ms: number; p95Ms: number; p99Ms: number }>;
};

export interface DecodeResultView {
  ok: boolean;
  frameType: FrameType;
  payloadView: Uint8Array;
  flags?: number;
  error?: string;
}

const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10,
  1, 8, 0, 65, 0, 253, 15, 253, 98, 11
]);
const PUBLIC_FRAME_TYPES = new Set<number>([
  FrameType.ArticleList,
  FrameType.ArticleDetail,
  FrameType.ArticleHot,
  FrameType.ArticleSearch,
  FrameType.CommentArticleCursor,
  FrameType.CommentThreadReplyCursor,
  FrameType.CategoryList,
  FrameType.TagList,
  FrameType.RecentCommentStats,
  FrameType.RegionStats,
  FrameType.SeoConfig,
  FrameType.PageContent,
  FrameType.ArticleFeatured,
  FrameType.PublicAotBootstrap
]);
const decodeSamples = new Map<string, number[]>();
const diagnostics: AedsRuntimeDiagnostics = {
  abi: AEDS_WASM_ABI,
  selectedTier: 'none',
  simdSupported: null,
  fallbackReason: null,
  selectionCount: { basic: 0, speed: 0 },
  fallbackCount: 0,
  load: null,
  workerModel: resolveAedsWorkerRuntimeModel(),
  decodeCount: 0,
  decodedBytes: 0,
  jsToWasmCopiedBytes: 0,
  wasmToJsCopiedBytes: 0,
  arenaCapacityBytes: 0,
  arenaReallocationCount: 0,
  arenaClearCount: 0,
  initialPages: 0,
  peakPages: 0,
  growCount: 0,
  decodeMsTotal: 0,
  frameBuckets: {}
};

let exportsRef: AedsWasmExports | null = null;
let initPromise: Promise<boolean> | null = null;
let manifestPromise: Promise<AedsRuntimeManifest> | null = null;
const textDecoder = new TextDecoder();

function pickExport<T>(raw: Record<string, unknown>, name: string): T {
  const direct = raw[name];
  if (direct) return direct as T;
  const underscored = raw[`_${name}`];
  if (underscored) return underscored as T;
  throw createAppError(AppErrorCode.InvariantViolation, `wasm_export_missing:${name}`);
}

function getModuleMemory(instance: AedsModuleInstance): WebAssembly.Memory {
  return {
    get buffer() {
      return instance.HEAPU8.buffer;
    }
  } as WebAssembly.Memory;
}

function toMemoryOffset(address: WasmAddress): number | null {
  const value = typeof address === 'bigint'
    ? address <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(address) : Number.NaN
    : address;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readCString(memory: WebAssembly.Memory, address: WasmAddress, len: number): string {
  const ptr = toMemoryOffset(address);
  if (ptr === null || ptr <= 0 || len <= 0 || ptr + len > memory.buffer.byteLength) return '';
  return textDecoder.decode(new Uint8Array(memory.buffer, ptr, len));
}

export function supportsAedsSimd(): boolean {
  try {
    return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE as BufferSource);
  } catch {
    return false;
  }
}

export function resolveAedsTierCandidates(simdSupported = supportsAedsSimd()): AedsAssetKind[] {
  return simdSupported ? ['speed', 'basic'] : ['basic'];
}

export async function initializeAedsTierSequentially(
  candidates: readonly AedsAssetKind[],
  attempt: (tier: AedsAssetKind) => Promise<boolean>
): Promise<{ tier: AedsAssetKind | null; fallbackReason: string | null }> {
  let fallbackReason: string | null = null;
  for (const tier of candidates) {
    try {
      if (await attempt(tier)) return { tier, fallbackReason };
      if (tier === 'speed') fallbackReason = 'speed_init_returned_false';
    } catch (error) {
      if (tier !== 'speed') throw error;
      fallbackReason = error instanceof Error ? error.message : 'speed_init_failed';
    }
  }
  return { tier: null, fallbackReason };
}

export function decodeAedsEnvelopeNoCopy(buffer: Uint8Array): DecodeResultView {
  if (buffer.byteLength < AEDS_HEADER_LENGTH) {
    return { ok: false, frameType: FrameType.Unknown, payloadView: new Uint8Array(0), error: 'frame_too_short' };
  }
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== AEDS_MAGIC) {
    return { ok: false, frameType: FrameType.Unknown, payloadView: new Uint8Array(0), error: 'magic_mismatch' };
  }
  const frameType = dv.getUint16(8, true) as FrameType;
  if (dv.getUint8(4) !== AEDS_VERSION) {
    return { ok: false, frameType, payloadView: new Uint8Array(0), error: 'version_mismatch' };
  }
  if (dv.getUint8(5) !== AEDS_HEADER_LENGTH) {
    return { ok: false, frameType, payloadView: new Uint8Array(0), error: 'header_length_mismatch' };
  }
  const flags = dv.getUint16(6, true);
  const payloadLength = dv.getUint32(10, true);
  const payloadCrc = dv.getUint16(14, true);
  if (AEDS_HEADER_LENGTH + payloadLength !== buffer.byteLength) {
    return { ok: false, frameType, payloadView: new Uint8Array(0), error: 'payload_length_mismatch' };
  }
  const payloadView = buffer.subarray(AEDS_HEADER_LENGTH);
  if (crc16(payloadView) !== payloadCrc) {
    return { ok: false, frameType, payloadView: new Uint8Array(0), error: 'payload_crc_mismatch' };
  }
  return { ok: true, frameType, flags, payloadView };
}

const CRC16_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let crc = i;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1);
    }
    table[i] = crc & 0xffff;
  }
  return table;
})();

export function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    crc = (crc >>> 8) ^ CRC16_TABLE[(crc ^ (bytes[i] ?? 0)) & 0xff];
  }
  return crc & 0xffff;
}

async function loadRuntimeManifest(): Promise<AedsRuntimeManifest> {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      const response = await fetch(AEDS_RUNTIME_MANIFEST_URL, { credentials: 'same-origin', cache: 'force-cache' });
      if (!response.ok) {
        throw createAppError(AppErrorCode.InfraFailure, `aeds_manifest_fetch_failed:${response.status}`, {
          status: response.status
        });
      }
      const value = await response.json() as AedsRuntimeManifest;
      validateAedsRuntimeManifest(value);
      return value;
    })();
    manifestPromise.catch(() => { manifestPromise = null; });
  }
  return await manifestPromise;
}

export function validateAedsRuntimeManifest(value: AedsRuntimeManifest): void {
  const worker = value?.workerModel;
  const active = worker?.activeRequests;
  if (value?.schema !== 'fsusblog.aeds-runtime.v1'
    || value.abi !== AEDS_WASM_ABI
    || value.maxFrameBytes !== AEDS_MAX_FRAME_BYTES
    || worker?.instancesPerPage !== 1
    || active?.source !== 'runtime-logical-processors'
    || !Number.isSafeInteger(active.minimum) || active.minimum < 1
    || !Number.isSafeInteger(active.maximum) || active.maximum < active.minimum || active.maximum > 32
    || !Number.isSafeInteger(active.logicalProcessorsPerRequest) || active.logicalProcessorsPerRequest < 1
    || active.minimum !== AEDS_WORKER_MODEL.activeRequests.minimum
    || active.maximum !== AEDS_WORKER_MODEL.activeRequests.maximum
    || active.logicalProcessorsPerRequest !== AEDS_WORKER_MODEL.activeRequests.logicalProcessorsPerRequest) {
    throw createAppError(AppErrorCode.InvariantViolation, 'aeds_manifest_contract_invalid');
  }
  const toolchain = value.toolchain;
  if (!toolchain
    || !/^\d+\.\d+\.\d+$/u.test(toolchain.emscriptenVersion)
    || toolchain.binaryenVersion !== '123'
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(toolchain.cmakeVersion)
    || !/^[0-9a-f]{40}$/u.test(toolchain.vcpkgCommit)
    || !/^emscripten\/emsdk:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/u.test(toolchain.emsdkImage)) {
    throw createAppError(AppErrorCode.InvariantViolation, 'aeds_manifest_toolchain_invalid');
  }
  for (const tier of ['basic', 'speed'] as const) {
    const entry = value.tiers?.[tier];
    const expected = resolveAedsAsset(tier);
    if (!entry
      || !/^[0-9a-f]{64}$/u.test(entry.moduleSha256)
      || !/^[0-9a-f]{64}$/u.test(entry.wasmSha256)
      || !expected.moduleUrl.endsWith(`/${entry.module}`) || !expected.wasmUrl.endsWith(`/${entry.wasm}`)) {
      throw createAppError(AppErrorCode.InvariantViolation, `aeds_manifest_tier_invalid:${tier}`);
    }
  }
  const basic = value.tiers.basic;
  if (basic.simd || basic.lto || basic.wasmOptValidated
    || basic.initialMemoryBytes !== 16 * 1024 * 1024
    || basic.maximumMemoryBytes !== 256 * 1024 * 1024
    || basic.memoryGrowth !== 'bounded') {
    throw createAppError(AppErrorCode.InvariantViolation, 'aeds_manifest_basic_identity_invalid');
  }
  const speed = value.tiers.speed;
  if (!speed.simd || !speed.lto || !speed.wasmOptValidated
    || speed.initialMemoryBytes !== 64 * 1024 * 1024
    || speed.maximumMemoryBytes !== 64 * 1024 * 1024
    || speed.memoryGrowth !== 'disabled') {
    throw createAppError(AppErrorCode.InvariantViolation, 'aeds_manifest_speed_identity_invalid');
  }
}

export function resolveAedsWorkerRuntimeModel(
  policy: AedsRuntimeManifest['workerModel'] = AEDS_WORKER_MODEL,
  logicalProcessorHint?: number
): AedsResolvedWorkerModel {
  const reported = logicalProcessorHint ?? globalThis.navigator?.hardwareConcurrency;
  const hasRuntimeValue = Number.isFinite(reported) && Number(reported) >= 1;
  const logicalProcessors = hasRuntimeValue ? Math.max(1, Math.floor(Number(reported))) : 1;
  const active = policy.activeRequests;
  const requested = Math.ceil(logicalProcessors / active.logicalProcessorsPerRequest);
  return {
    resourceSource: hasRuntimeValue ? 'navigator.hardwareConcurrency' : 'fallback',
    logicalProcessors,
    instancesPerPage: policy.instancesPerPage,
    activeRequests: Math.max(active.minimum, Math.min(active.maximum, requested)),
    minimumActiveRequests: active.minimum,
    maximumActiveRequests: active.maximum
  };
}

async function loadTier(manifest: AedsRuntimeManifest, tier: AedsAssetKind): Promise<boolean> {
  const asset = resolveAedsAsset(tier);
  const tierManifest = manifest.tiers[tier];
  let loadMetrics: EmscriptenLoadMetrics | null = null;
  const instance = await loadEmscriptenModule<AedsModuleInstance>(
    asset.moduleUrl,
    'createAedsModule',
    asset.wasmUrl,
    {
      compiledModuleCacheKey: `${asset.wasmUrl}|${manifest.abi}|${tierManifest.wasmSha256}`,
      expectedModuleSha256: tierManifest.moduleSha256,
      expectedWasmSha256: tierManifest.wasmSha256,
      requireCompiledModule: true,
      onMetrics: (metrics) => { loadMetrics = metrics; }
    }
  );
  if (!instance) return false;
  const raw = instance as unknown as Record<string, unknown>;
  exportsRef = {
    memory: getModuleMemory(instance),
    reserve_io_buffer: pickExport(raw, 'reserve_io_buffer'),
    get_io_buffer_ptr: pickExport(raw, 'get_io_buffer_ptr'),
    decode_io_buffer: pickExport(raw, 'decode_io_buffer'),
    clear_io_buffer: pickExport(raw, 'clear_io_buffer'),
    get_io_buffer_capacity: pickExport(raw, 'get_io_buffer_capacity'),
    get_arena_reallocation_count: pickExport(raw, 'get_arena_reallocation_count'),
    get_arena_clear_count: pickExport(raw, 'get_arena_clear_count'),
    get_last_payload_token: pickExport(raw, 'get_last_payload_token'),
    get_last_payload_ptr: pickExport(raw, 'get_last_payload_ptr'),
    get_last_payload_len: pickExport(raw, 'get_last_payload_len'),
    get_last_frame_type: pickExport(raw, 'get_last_frame_type'),
    get_last_error_ptr: pickExport(raw, 'get_last_error_ptr'),
    get_last_error_len: pickExport(raw, 'get_last_error_len')
  };
  diagnostics.selectedTier = tier;
  diagnostics.selectionCount[tier] += 1;
  diagnostics.load = loadMetrics;
  const pages = Math.ceil(exportsRef.memory.buffer.byteLength / 65536);
  diagnostics.initialPages = pages;
  diagnostics.peakPages = pages;
  return true;
}

export async function initWasm(): Promise<boolean> {
  if (exportsRef) return true;
  if (initPromise) return await initPromise;
  initPromise = (async () => {
    try {
      const manifest = await loadRuntimeManifest();
      diagnostics.workerModel = resolveAedsWorkerRuntimeModel(manifest.workerModel);
      const simdSupported = supportsAedsSimd();
      diagnostics.simdSupported = simdSupported;
      const candidates = resolveAedsTierCandidates(simdSupported);
      const selected = await initializeAedsTierSequentially(candidates, tier => loadTier(manifest, tier));
      if (selected.fallbackReason) {
        diagnostics.fallbackCount += 1;
        diagnostics.fallbackReason = selected.fallbackReason;
      }
      return selected.tier !== null;
    } catch (error) {
      diagnostics.fallbackReason = error instanceof Error ? error.message : 'aeds_init_failed';
      return false;
    }
  })();
  const ready = await initPromise;
  if (!ready) initPromise = null;
  return ready;
}

export function decode(buffer: ArrayBuffer): DecodeResultView {
  const input = new Uint8Array(buffer);
  if (!exportsRef) return decodeAedsEnvelopeNoCopy(input);
  if (input.byteLength > AEDS_MAX_FRAME_BYTES) {
    return { ok: false, frameType: FrameType.Unknown, payloadView: new Uint8Array(0), error: 'frame_too_large' };
  }
  const headerFrameType = input.byteLength >= AEDS_HEADER_LENGTH
    ? new DataView(input.buffer, input.byteOffset, input.byteLength).getUint16(8, true) as FrameType
    : FrameType.Unknown;
  const flags = input.byteLength >= AEDS_HEADER_LENGTH
    ? new DataView(input.buffer, input.byteOffset, input.byteLength).getUint16(6, true)
    : 0;
  const sensitive = !PUBLIC_FRAME_TYPES.has(headerFrameType);
  const pagesBefore = Math.ceil(exportsRef.memory.buffer.byteLength / 65536);
  const startedAt = now();
  const inputToken = exportsRef.reserve_io_buffer(input.byteLength);
  if (inputToken === 0n) {
    return { ok: false, frameType: FrameType.Unknown, payloadView: new Uint8Array(0), error: 'oom' };
  }
  try {
    const ptr = toMemoryOffset(exportsRef.get_io_buffer_ptr(inputToken));
    if (ptr === null || ptr <= 0 || ptr + input.byteLength > exportsRef.memory.buffer.byteLength) {
      return { ok: false, frameType: FrameType.Unknown, payloadView: new Uint8Array(0), error: 'io_handle_expired' };
    }
    new Uint8Array(exportsRef.memory.buffer, ptr, input.byteLength).set(input);
    diagnostics.jsToWasmCopiedBytes += input.byteLength;
    const ok = exportsRef.decode_io_buffer(inputToken, input.byteLength) === 1;
    if (!ok) {
      const error = readCString(exportsRef.memory, exportsRef.get_last_error_ptr(), exportsRef.get_last_error_len()) || 'decode_failed';
      return { ok: false, frameType: headerFrameType, payloadView: new Uint8Array(0), error };
    }
    const payloadToken = exportsRef.get_last_payload_token();
    const payloadPtr = toMemoryOffset(exportsRef.get_last_payload_ptr(payloadToken));
    const payloadLen = exportsRef.get_last_payload_len(payloadToken);
    const frameType = exportsRef.get_last_frame_type(payloadToken) as FrameType;
    if (payloadToken === 0n || payloadPtr === null || payloadPtr <= 0 || payloadLen < 0 || payloadPtr + payloadLen > exportsRef.memory.buffer.byteLength) {
      return { ok: false, frameType, payloadView: new Uint8Array(0), error: 'payload_ptr_invalid' };
    }
    const payloadView = new Uint8Array(new Uint8Array(exportsRef.memory.buffer, payloadPtr, payloadLen));
    diagnostics.wasmToJsCopiedBytes += payloadLen;
    recordDecode(input.byteLength, now() - startedAt, pagesBefore);
    return { ok: true, frameType, flags, payloadView };
  } finally {
    if (sensitive) exportsRef.clear_io_buffer(0);
    diagnostics.arenaCapacityBytes = exportsRef.get_io_buffer_capacity();
    diagnostics.arenaReallocationCount = exportsRef.get_arena_reallocation_count();
    diagnostics.arenaClearCount = exportsRef.get_arena_clear_count();
  }
}

function recordDecode(frameBytes: number, elapsedMs: number, pagesBefore: number): void {
  if (!exportsRef) return;
  const pagesAfter = Math.ceil(exportsRef.memory.buffer.byteLength / 65536);
  if (pagesAfter > pagesBefore) diagnostics.growCount += 1;
  diagnostics.peakPages = Math.max(diagnostics.peakPages, pagesAfter);
  diagnostics.decodeCount += 1;
  diagnostics.decodedBytes += frameBytes;
  diagnostics.decodeMsTotal += elapsedMs;
  const bucket = frameBytes <= 4096 ? '0-4KiB'
    : frameBytes <= 65536 ? '4-64KiB'
    : frameBytes <= 1048576 ? '64KiB-1MiB'
    : '1-8MiB';
  const samples = decodeSamples.get(bucket) ?? [];
  samples.push(elapsedMs);
  if (samples.length > 256) samples.shift();
  decodeSamples.set(bucket, samples);
  diagnostics.frameBuckets[bucket] = {
    count: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99)
  };
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function getAedsRuntimeDiagnostics(): AedsRuntimeDiagnostics {
  return JSON.parse(JSON.stringify(diagnostics)) as AedsRuntimeDiagnostics;
}
