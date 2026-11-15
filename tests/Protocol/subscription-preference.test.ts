import assert from 'node:assert/strict';
import { hexFixture } from './fixture-source.ts';
import { test } from 'node:test';
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { cancelSubscription, enrollSubscription } from '../../src/Contracts/subscription-preference.ts';
import { decodeSubscriptionPreferenceRequest, FrameType, WireHeaders, WireLimits, WireRoutes } from '../../src/Contracts/wire.generated.ts';

const email = 'news+brief@example.test';
const proof = 'ab'.repeat(32);
const fixture = hexFixture('subscription-preference.hex');

test('subscription uses an anonymous AEDS preference and puts cancellation proof only in the header', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (path: string, options: RequestInit) => {
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(new Headers(options.headers).get(WireHeaders.SubscriptionProof), path === WireRoutes.SubscriptionCancel ? proof : null);
    assert.equal(new Headers(options.headers).get('Content-Type'), 'application/octet-stream');
    assert.equal(new Headers(options.headers).get('Accept'), 'application/octet-stream');
    assert.equal(path.includes(email) || path.includes(proof), false);
    assert.ok(options.body instanceof Uint8Array);
    assert.deepEqual(Buffer.from(options.body), fixture);
    const payload = decodeFrame(options.body, FrameType.SubscriptionPreferenceRequest).payload;
    assert.deepEqual(decodeSubscriptionPreferenceRequest(payload), { email, channel: 2 });
    return new Response(encodeFrame(FrameType.EmptySuccess, Uint8Array.of(1, 0, 0, 0)), {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  });
  assert.equal(await enrollSubscription(email, 'email'), undefined);
  assert.equal(await cancelSubscription(email, 'email', proof), undefined);
  assert.deepEqual(fetch.mock.calls.map(call => call.arguments[0]), [WireRoutes.SubscriptionEnroll, WireRoutes.SubscriptionCancel]);
});

test('invalid preferences or noncanonical proofs never leave the client', t => {
  const fetch = t.mock.method(globalThis, 'fetch');
  for (const address of ['', 'bad\r@example.test', 'bad\n', '国际@example.test', 'x'.repeat(WireLimits.SubscriptionEmailBytes + 1)])
    assert.throws(() => enrollSubscription(address, 'rss'), ProtocolError);
  for (const candidate of [proof.toUpperCase(), proof.slice(0, -1), proof.slice(0, -1) + '\n'])
    assert.throws(() => cancelSubscription(email, 'email', candidate), ProtocolError);
  assert.equal(fetch.mock.callCount(), 0);
});

test('a nonempty or membership-bearing response is rejected', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(encodeFrame(FrameType.EmptySuccess, Uint8Array.of(1, 0, 0, 0, 1)), {
    headers: { 'Content-Type': 'application/octet-stream' },
  }));
  await assert.rejects(enrollSubscription(email, 'rss'), ProtocolError);
});
