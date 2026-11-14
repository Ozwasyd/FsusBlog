import { equal, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFrame } from '../../src/Contracts/aeds.ts';
import { api, ProtocolError } from '../../src/Contracts/client.ts';
import { encodeSession, FrameType, WireHeaders } from '../../src/Contracts/wire.generated.ts';

const session = encodeFrame(FrameType.OperatorSession, encodeSession({
  name: 'operator',
  generation: 3n,
  canAuthor: true,
}));

function frame(expiry?: string) {
  const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
  if (expiry !== undefined) headers.set(WireHeaders.AccessExpiresAtUtc, expiry);
  return new Response(session, { headers });
}

test('operator session reads the server expiry without changing the payload', async t => {
  t.mock.method(globalThis, 'fetch', async () => frame('2026-11-15T12:45:09.1234567Z'));
  const admitted = await api.session();
  equal(admitted.name, 'operator');
  equal(admitted.generation, 3n);
  equal(admitted.expiresAt, Date.UTC(2026, 10, 15, 12, 45, 9, 123));
});

test('operator session requires a valid explicit UTC expiry', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () => frame());
  await rejects(api.session(), { name: ProtocolError.name, message: 'Invalid operator session' });
  request.mock.mockImplementation(async () => frame('2026-11-15T12:45:09'));
  await rejects(api.session(), { name: ProtocolError.name, message: 'Invalid operator session' });
});
