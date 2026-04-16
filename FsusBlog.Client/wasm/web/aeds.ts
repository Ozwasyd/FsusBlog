import { AEDS_HEADER_LENGTH, AEDS_MAGIC, AEDS_VERSION, FrameType } from './protocol/frame';
import { AEDS_MODULE_URL, AEDS_WASM_URL } from './runtime/assets';
import { loadEmscriptenModule } from './runtime/emscripten';
import { AppErrorCode, createAppError } from '@/utils/appError';

interface AedsWasmExports {
  memory: WebAssembly.Memory;
  decode_aeds(ptr: number, len: number): number;
  get_last_payload_ptr(): number;
  get_last_payload_len(): number;
  get_last_frame_type(): number;
  get_last_error_ptr(): number;
  get_last_error_len(): number;
  alloc_buffer(size: number): number;
  free_buffer(ptr: number): void;
}

let exportsRef: AedsWasmExports | null = null;
let initPromise: Promise<boolean> | null = null;
const textDecoder = new TextDecoder();

function pickExport<T>(raw: Record<string, unknown>, name: string): T {
  const direct = (raw as Record<string, unknown>)[name];
  if (direct) {
    return direct as T;
  }

  const underscored = (raw as Record<string, unknown>)[`_${name}`];
  if (underscored) {
    return underscored as T;
  }

  throw createAppError(AppErrorCode.InvariantViolation, `wasm_export_missing:${name}`);
}

export interface DecodeResultView {
  ok: boolean;
  frameType: FrameType;
  payloadView: Uint8Array;
  error?: string;
}

type AedsModuleInstance = {
  HEAPU8: Uint8Array;
  _decode_aeds: (ptr: number, len: number) => number;
  _get_last_payload_ptr: () => number;
  _get_last_payload_len: () => number;
  _get_last_frame_type: () => number;
  _get_last_error_ptr: () => number;
  _get_last_error_len: () => number;
  _alloc_buffer: (size: number) => number;
  _free_buffer: (ptr: number) => void;
};

function getModuleMemory(instance: AedsModuleInstance): WebAssembly.Memory {
  return {
    get buffer() {
      return instance.HEAPU8.buffer;
    }
  } as WebAssembly.Memory;
}

function readCString(memory: WebAssembly.Memory, ptr: number, len: number): string {
  if (ptr <= 0 || len <= 0) {
    return '';
  }

  const view = new Uint8Array(memory.buffer, ptr, len);
  return textDecoder.decode(view);
}

function decodeWithHeaderFallback(buffer: Uint8Array): DecodeResultView {
  if (buffer.byteLength < AEDS_HEADER_LENGTH) {
    return { ok: false, frameType: FrameType.Unknown, payloadView: new Uint8Array(0), error: 'frame_too_short' };
  }

  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== AEDS_MAGIC) {
    return { ok: false, frameType: FrameType.Unknown, payloadView: new Uint8Array(0), error: 'magic_mismatch' };
  }

  const frameType = dv.getUint16(6, true) as FrameType;
  const version = dv.getUint16(4, true);
  if (version !== AEDS_VERSION) {
    return { ok: false, frameType, payloadView: new Uint8Array(0), error: 'version_mismatch' };
  }
  const payloadLength = dv.getUint32(12, true);
  const payloadOffset = AEDS_HEADER_LENGTH;
  if (payloadOffset + payloadLength > buffer.byteLength) {
    return { ok: false, frameType, payloadView: new Uint8Array(0), error: 'payload_length_mismatch' };
  }

  return {
    ok: true,
    frameType,
    payloadView: buffer.subarray(payloadOffset, payloadOffset + payloadLength)
  };
}

export async function initWasm(wasmUrl = AEDS_WASM_URL): Promise<boolean> {
  if (exportsRef) {
    return true;
  }

  if (initPromise) {
    return await initPromise;
  }

  initPromise = (async () => {
    try {
      const instance = await loadEmscriptenModule<AedsModuleInstance>(
        AEDS_MODULE_URL,
        'createAedsModule',
        wasmUrl
      );
      if (!instance) {
        return false;
      }

      const raw = instance as unknown as Record<string, unknown>;
      exportsRef = {
        memory: getModuleMemory(instance),
        decode_aeds: pickExport<(ptr: number, len: number) => number>(raw, 'decode_aeds'),
        get_last_payload_ptr: pickExport<() => number>(raw, 'get_last_payload_ptr'),
        get_last_payload_len: pickExport<() => number>(raw, 'get_last_payload_len'),
        get_last_frame_type: pickExport<() => number>(raw, 'get_last_frame_type'),
        get_last_error_ptr: pickExport<() => number>(raw, 'get_last_error_ptr'),
        get_last_error_len: pickExport<() => number>(raw, 'get_last_error_len'),
        alloc_buffer: pickExport<(size: number) => number>(raw, 'alloc_buffer'),
        free_buffer: pickExport<(ptr: number) => void>(raw, 'free_buffer')
      };
      return true;
    } catch {
      return false;
    }
  })();

  const ready = await initPromise;
  if (!ready) {
    initPromise = null;
  }
  return ready;
}

export function decode(buffer: ArrayBuffer): DecodeResultView {
  const input = new Uint8Array(buffer);
  if (!exportsRef) {
    return decodeWithHeaderFallback(input);
  }

  const ptr = exportsRef.alloc_buffer(input.byteLength);
  if (ptr <= 0) {
    return { ok: false, frameType: FrameType.Unknown, payloadView: new Uint8Array(0), error: 'oom' };
  }

  try {
    const mem = new Uint8Array(exportsRef.memory.buffer, ptr, input.byteLength);
    mem.set(input);

    const ok = exportsRef.decode_aeds(ptr, input.byteLength) === 1;
    if (!ok) {
      const errPtr = exportsRef.get_last_error_ptr();
      const errLen = exportsRef.get_last_error_len();
      const error = readCString(exportsRef.memory, errPtr, errLen) || 'decode_failed';
      return { ok: false, frameType: FrameType.Unknown, payloadView: new Uint8Array(0), error };
    }

    const payloadPtr = exportsRef.get_last_payload_ptr();
    const payloadLen = exportsRef.get_last_payload_len();
    const frameType = exportsRef.get_last_frame_type() as FrameType;

    if (payloadPtr <= 0 || payloadLen < 0) {
      return { ok: false, frameType, payloadView: new Uint8Array(0), error: 'payload_ptr_invalid' };
    }

    const payload = new Uint8Array(exportsRef.memory.buffer, payloadPtr, payloadLen);
    return { ok: true, frameType, payloadView: new Uint8Array(payload), error: undefined };
  } finally {
    exportsRef.free_buffer(ptr);
  }
}
