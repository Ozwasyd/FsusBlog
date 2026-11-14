import { deepStrictEqual, equal, throws } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { decodePowChallenge, encodePowProof } from '../../src/Contracts/pow.ts';
import { FrameType } from '../../src/Contracts/wire.generated.ts';

test('decodes pinned AEDS PowChallenge and writes the exact FPOW v1 envelope', () => {
  const fixture = readFileSync(new URL('./fixtures/pow-challenge-v1.hex', import.meta.url), 'utf8').replace(/\s/g, '');
  const { payload } = decodeFrame(Uint8Array.from(Buffer.from(fixture, 'hex')), FrameType.PowChallenge);
  const value = decodePowChallenge(payload);
  deepStrictEqual(value, { salt: 'salt-value', signature: 'signature-value', difficulty: 4, timestamp: 1778290000 });
  const proof = encodePowProof(value, '123', 'abcd');
  const expected = Buffer.from('46504f570104000000508dfe69000000000a0073616c742d76616c756503003132330f007369676e61747572652d76616c7565040061626364', 'hex');
  equal(proof, expected.toString('base64'));
  throws(() => decodePowChallenge(payload.subarray(0, -1)), ProtocolError);
  throws(() => encodePowProof(value, '123', 'x'.repeat(512)), ProtocolError);
});
