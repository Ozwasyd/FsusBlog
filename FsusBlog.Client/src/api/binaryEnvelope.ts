import { decode } from '@wasm/aeds';
import { FrameType } from '@wasm/protocol/frame';
import { AppErrorCode, createAppError, err, ok, type AppResult, unwrapResult } from '@/utils/appError';
import { decodeUtf8 } from '@/utils/utf8';

type BinaryEnvelope = {
  frameType: FrameType;
  statusCode: number;
  contentType: string;
  bodyBytes: Uint8Array;
  bodyText: string;
  bodyJson: unknown;
};

function readInt32(view: DataView, offset: number): number {
  return view.getInt32(offset, true);
}

function readUInt16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

export function tryDecodeBinaryEnvelope(buffer: ArrayBuffer): AppResult<BinaryEnvelope> {
  const frame = decode(buffer, false);
  if (!frame.ok) {
    return err(createAppError(AppErrorCode.ProtocolFailure, frame.error ?? 'binary_frame_decode_failed'));
  }

  if (frame.frameType !== FrameType.ApiEnvelope && frame.frameType !== FrameType.ApiError) {
    return err(createAppError(AppErrorCode.ProtocolFailure, `binary_frame_unsupported:${frame.frameType}`));
  }

  const payload = frame.payloadView;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let offset = 0;

  if (payload.byteLength < 10) {
    return err(createAppError(AppErrorCode.ProtocolFailure, 'binary_envelope_payload_too_short'));
  }

  const statusCode = readInt32(view, offset);
  offset += 4;

  const contentTypeLength = readUInt16(view, offset);
  offset += 2;

  if (offset + contentTypeLength > payload.byteLength) {
    return err(createAppError(AppErrorCode.ProtocolFailure, 'binary_envelope_content_type_out_of_range'));
  }

  const contentType = decodeUtf8(payload.subarray(offset, offset + contentTypeLength));
  offset += contentTypeLength;

  if (offset + 4 > payload.byteLength) {
    return err(createAppError(AppErrorCode.ProtocolFailure, 'binary_envelope_body_length_missing'));
  }

  const bodyLength = readInt32(view, offset);
  offset += 4;

  if (bodyLength < 0 || offset + bodyLength > payload.byteLength) {
    return err(createAppError(AppErrorCode.ProtocolFailure, 'binary_envelope_body_out_of_range'));
  }

  const bodyBytes = payload.subarray(offset, offset + bodyLength);
  const bodyText = bodyBytes.length > 0 ? decodeUtf8(bodyBytes) : '';

  let bodyJson: unknown = null;
  if (bodyText.length > 0 && contentType.toLowerCase().includes('application/json')) {
    try {
      bodyJson = JSON.parse(bodyText);
    } catch {
      bodyJson = null;
    }
  }

  return ok({
    frameType: frame.frameType,
    statusCode,
    contentType,
    bodyBytes,
    bodyText,
    bodyJson
  });
}

export function decodeBinaryEnvelope(buffer: ArrayBuffer): BinaryEnvelope {
  return unwrapResult(tryDecodeBinaryEnvelope(buffer));
}
