import { dataView, decodeFixedText, PodWriter, ProtocolError, writePod } from './binary.ts';
import { FrameType, WireHeader, WireLayouts, WireLimits } from './wire.generated.ts';

export { ProtocolError } from './binary.ts';

const knownTypes: ReadonlySet<number> = new Set(Object.values(FrameType));
const crcTable = Uint16Array.from({ length: 256 }, (_, index) => {
  for (let bit = 0; bit < 8; bit++) {
    index = (index >> 1) ^ ((index & 1) === 0 ? 0 : WireHeader.CrcPolynomial);
  }
  return index;
});

function crc16(payload: Uint8Array): number {
  let crc: number = WireHeader.CrcInitial;
  for (const byte of payload) crc = (crc >> 8) ^ crcTable[(crc ^ byte) & 255];
  return crc;
}

function isKnownType(value: number): value is FrameType {
  return knownTypes.has(value);
}

export function encodeFrame(type: FrameType, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!isKnownType(type) || payload.length > WireLimits.MaxPayloadBytes)
    throw new ProtocolError('Unsupported AEDS type or payload size');

  const frame = new Uint8Array(WireHeader.HeaderSize + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, WireHeader.Magic, true);
  view.setUint8(WireHeader.VersionOffset, WireHeader.Version);
  view.setUint8(WireHeader.LengthOffset, WireHeader.HeaderSize);
  view.setUint16(WireHeader.TypeOffset, type, true);
  view.setUint32(WireHeader.PayloadLengthOffset, payload.length, true);
  view.setUint16(WireHeader.CrcOffset, crc16(payload), true);
  frame.set(payload, WireHeader.HeaderSize);
  return frame;
}

export function encodePod(type: FrameType, write: (writer: PodWriter) => void): Uint8Array<ArrayBuffer> {
  return encodeFrame(type, writePod(write));
}

export function decodeFrame(
  frame: Uint8Array,
  expected?: FrameType,
): { type: FrameType; payload: Uint8Array } {
  const view = dataView(frame);
  if (
    frame.length < WireHeader.HeaderSize || frame.length > WireHeader.HeaderSize + WireLimits.MaxPayloadBytes ||
    view.getUint32(0, true) !== WireHeader.Magic ||
    view.getUint8(WireHeader.VersionOffset) !== WireHeader.Version ||
    view.getUint8(WireHeader.LengthOffset) !== WireHeader.HeaderSize ||
    view.getUint16(WireHeader.FlagsOffset, true) !== 0
  ) throw new ProtocolError('Invalid AEDS header');

  const type = view.getUint16(WireHeader.TypeOffset, true);
  const payload = frame.subarray(WireHeader.HeaderSize);
  if (
    !isKnownType(type) || (expected !== undefined && expected !== type) ||
    view.getUint32(WireHeader.PayloadLengthOffset, true) !== payload.length ||
    view.getUint16(WireHeader.CrcOffset, true) !== crc16(payload)
  ) throw new ProtocolError('Invalid AEDS type, length, or checksum');
  return { type, payload };
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly code: number;
  readonly category: number;
  readonly status: number;
  readonly details: string;
  readonly traceId: string;

  constructor(
    message: string,
    status: number,
    details = '',
    traceId = '',
    code = 0,
    category = 0,
  ) {
    super(message);
    this.code = code;
    this.category = category;
    this.status = status;
    this.details = details;
    this.traceId = traceId;
  }
}

export function decodeApiError(payload: Uint8Array, httpStatus: number): ApiError {
  if (payload.length !== WireLayouts.ErrorBytes || payload[2] !== 0 || payload[3] !== 0)
    throw new ProtocolError('Invalid AEDS error record');
  const [code, category] = payload;
  const status = dataView(payload).getInt32(WireLayouts.ErrorStatusOffset, true);
  if (code < 1 || code > 7 || category < 1 || category > 13 || status !== httpStatus ||
      status < 400 || status > 599)
    throw new ProtocolError('Invalid AEDS error semantics');

  const message = decodeFixedText(payload.subarray(WireLayouts.ErrorMessageOffset, WireLayouts.ErrorDetailsOffset));
  const details = decodeFixedText(payload.subarray(WireLayouts.ErrorDetailsOffset, WireLayouts.ErrorTraceIdOffset));
  const trace = decodeFixedText(payload.subarray(WireLayouts.ErrorTraceIdOffset));
  return new ApiError(message, status, details, trace, code, category);
}

export function decodeSuccess(payload: Uint8Array): void {
  if (payload.length !== WireLayouts.SuccessBytes || payload[0] !== 1 || payload.subarray(1).some(Boolean))
    throw new ProtocolError('Invalid AEDS success record');
}
