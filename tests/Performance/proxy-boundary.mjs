import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts';
import { decodeSession, encodeSignIn, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts';
import { launchChrome } from '../EndToEnd/isolated-browser-fixture.mjs';
import { signInFreshSite } from '../EndToEnd/webauthn-fixture.mjs';

const [publicOrigin, upstream, authority, certificate] = process.argv.slice(2);
const ticket = readFileSync(0, 'utf8').trim();
const ca = readFileSync(authority);
const binary = 'application/octet-stream';

function send(origin, path, { headers = {}, body, method = 'GET', trustFixture = true } = {}) {
  const address = new URL(path, origin);
  const secure = address.protocol === 'https:';
  const request = secure ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const call = request(address, {
      method, headers, timeout: 2000, agent: false,
      ...(secure && trustFixture ? { ca } : {}),
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks),
      }));
      response.on('error', reject);
    });
    call.on('timeout', () => call.destroy(new Error('fixture request timed out')));
    call.on('error', reject);
    call.end(body);
  });
}

await assert.rejects(send(publicOrigin, '/health/ready', { trustFixture: false }),
  error => ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error.code));
assert.equal((await send(upstream, '/health/ready')).status, 400);
assert.equal((await send(publicOrigin, '/health/ready')).status, 204);
const spoofed = {
  'X-Forwarded-For': 'definitely-not-an-ip',
  'X-Forwarded-Proto': 'http, ftp',
  'X-Forwarded-Host': 'example.invalid',
};
const passkey = await send(publicOrigin, WireRoutes.PasskeyAvailability, { headers: spoofed });
assert.equal(passkey.status, 200);
decodeFrame(passkey.body, FrameType.EmptySuccess);
const body = encodeFrame(FrameType.OperatorSignIn, encodeSignIn({ ticket }));
const blocked = await send(publicOrigin, WireRoutes.SignIn, {
  method: 'POST', headers: { 'Content-Type': binary, Origin: 'https://example.invalid' }, body,
});
assert.equal(blocked.status, 403);
decodeFrame(blocked.body, FrameType.ApiError);
const denied = await send(publicOrigin, WireRoutes.SignIn, {
  method: 'POST', headers: { ...spoofed, 'Content-Type': binary, Origin: publicOrigin }, body,
});
assert.equal(denied.status, 401);
assert.equal(denied.headers['set-cookie'], undefined);
decodeFrame(denied.body, FrameType.ApiError);

const leaf = new X509Certificate(readFileSync(certificate));
const pin = createHash('sha256').update(leaf.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
const browser = await launchChrome([`--ignore-certificate-errors-spki-list=${pin}`]);
let cookie;
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Exercise Caddy's replacement of spoofed forwarding headers on the real Passkey assertion.
  await page.route(new URL(WireRoutes.PasskeyLoginComplete, publicOrigin).href, route =>
    route.continue({ headers: { ...route.request().headers(), ...spoofed } }));
  await signInFreshSite(page, publicOrigin, ticket);
  const session = (await context.cookies(publicOrigin)).find(({ name }) => name === 'fsus-v2-session');
  assert(session?.secure && session.httpOnly && session.sameSite === 'Strict', 'Missing securely scoped reader session.');
  cookie = `${session.name}=${session.value}`;
} finally {
  await browser.close();
}
assert.equal((await send(upstream, WireRoutes.Session, { headers: { Cookie: cookie } })).status, 400);
const session = await send(publicOrigin, WireRoutes.Session, { headers: { Cookie: cookie } });
assert.equal(session.status, 200);
assert.equal(decodeSession(decodeFrame(session.body, FrameType.OperatorSession).payload).name, 'proxy-check');
assert.equal((await send(publicOrigin, WireRoutes.SignOut, {
  method: 'POST', headers: { Cookie: cookie, Origin: publicOrigin },
})).status, 200);
assert.equal((await send(publicOrigin, WireRoutes.Session, { headers: { Cookie: cookie } })).status, 401);
console.log('Verified isolated CA, proxy header replacement, TLS origin, Passkey login, Secure session, private upstream, and logout.');
