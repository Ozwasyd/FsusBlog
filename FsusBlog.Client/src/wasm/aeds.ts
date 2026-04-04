import { AEDS_HEADER_LENGTH, AEDS_MAGIC, FrameType } from './types';

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

function pickExport<T>(raw: WebAssembly.Exports, name: string): T {
  const direct = (raw as Record<string, unknown>)[name];
  if (direct) {
    return direct as T;
  }

  const underscored = (raw as Record<string, unknown>)[`_${name}`];
  if (underscored) {
    return underscored as T;
  }

  throw new Error(`wasm_export_missing:${name}`);
}

export interface DecodeResultView {
  ok: boolean;
  frameType: FrameType;
  payloadView: Uint8Array;
  error?: string;
}

function readCString(memory: WebAssembly.Memory, ptr: number, len: number): string {
  if (ptr <= 0 || len <= 0) {
    return '';
  }

  const view = new Uint8Array(memory.buffer, ptr, len);
  return new TextDecoder().decode(view);
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

export async function initWasm(wasmUrl = '/wasm/aeds_decoder.wasm'): Promise<boolean> {
  if (exportsRef) {
    return true;
  }

  try {
    const response = await fetch(wasmUrl);
    if (!response.ok) {
      return false;
    }

    const bytes = await response.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const raw = instance.exports;
    exportsRef = {
      memory: pickExport<WebAssembly.Memory>(raw, 'memory'),
      decode_aeds: pickExport<(ptr: number, len: number) => number>(raw, 'decode_aeds'),
      get_last_payload_ptr: pickExport<() => number>(raw, 'get_last_payload_ptr'),
      get_last_payload_len: pickExport<() => number>(raw, 'get_last_payload_len'),
      get_last_frame_type: pickExport<() => number>(raw, 'get_last_frame_type'),
      get_last_error_ptr: pickExport<() => number>(raw, 'get_last_error_ptr'),
      get_last_error_len: pickExport<() => number>(raw, 'get_last_error_len'),
      alloc_buffer: pickExport<(size: number) => number>(raw, 'alloc_buffer'),
      free_buffer: pickExport<(ptr: number) => void>(raw, 'free_buffer')
    };
    return !!exportsRef;
  } catch {
    return false;
  }
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
