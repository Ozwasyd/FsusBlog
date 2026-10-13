import { decodeBinaryFramePayload } from '@/composition/binaryDecoderRegistry';
import { BinaryTransportError, createBinaryTransport } from '@/services/binaryTransport';

export { BinaryTransportError };

export const { requestBinaryOnly, startBinaryOnly } = createBinaryTransport(decodeBinaryFramePayload);
