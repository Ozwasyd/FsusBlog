import { decodeBinaryFramePayload } from '@/composition/binaryDecoderRegistry';
import { BinaryTransportError, createBinaryTransport } from '@/services/binaryTransport';

export { BinaryTransportError };

export const { requestBinaryOnly } = createBinaryTransport(decodeBinaryFramePayload);

/** JSON payloads still share the generated route, framing and generation authority. */
export const { requestBinaryOnly: requestBinaryJson } = createBinaryTransport(
    (_frameType, payload) => JSON.parse(new TextDecoder().decode(payload)) as unknown,
    // These existing management JSON payloads use this decoder, while the worker owns packed models.
    false
);
