import { decodeSuccess, encodeFrame, ProtocolError } from './aeds.ts';
import { decodeUtf8 } from './binary.ts';
import { api, validSiteSessionId, type Session } from './client.ts';
import { post, readAvailability } from './internal/http.ts';
import { mfaAction, mfaStartData, readMfaProof } from './mfa.ts';
import { encodeSignIn, FrameType, WireHeader, WireHeaders, WireLayouts, WireLimits, WireRoutes } from './wire.generated.ts';

const encoder = new TextEncoder();
const transports = ['usb', 'nfc', 'ble', 'smart-card', 'hybrid', 'internal'];
const invalid = () => new ProtocolError('Invalid Passkey AEDS options.');

export async function passkeyAvailable(signal?: AbortSignal): Promise<boolean> {
  if (!globalThis.isSecureContext || typeof PublicKeyCredential !== 'function') return false;
  return readAvailability(WireRoutes.PasskeyAvailability, signal);
}

export type PasskeyLogin =
  | { status: 'signed-in'; role: 'reader'; session: Session }
  | { status: 'signed-in'; role: 'admin' }
  | { status: 'mfa'; token: string };

export async function loginWithPasskey(signal?: AbortSignal, rememberMe = false): Promise<PasskeyLogin> {
  const assertion = await requestPasskeyAssertion(WireRoutes.PasskeyLoginBegin, signal, undefined, false, rememberMe);
  const flow = await post(WireRoutes.PasskeyLoginComplete, FrameType.AuthLoginFlow, decodeLoginFlow, signal, assertion);
  if (flow.kind === 'admin') return { status: 'signed-in', role: 'admin' };
  return flow.pending ? { status: 'mfa', token: flow.pending } : { status: 'signed-in', role: 'reader', session: await api.session(signal) };
}

export async function requestPasskeyAssertion(beginPath: string, signal?: AbortSignal, body?: Uint8Array<ArrayBuffer>,
  restricted = false, rememberMe = false, headers?: HeadersInit) {
  const { token, options } = await post(beginPath, FrameType.PasskeyLoginBegin,
    payload => decodeLoginBegin(payload, restricted), signal, body, headers);
  return getAssertion(token, options, signal, rememberMe);
}

export async function proveMfaSetup(signal?: AbortSignal): Promise<string> {
  const assertion = await requestPasskeyAssertion(WireRoutes.PasskeyStepUpBegin, signal, mfaStartData(mfaAction.setup), true);
  return post(WireRoutes.PasskeyStepUpComplete, FrameType.MfaChallengeResult,
    payload => readMfaProof(payload, mfaAction.setup, true), signal, assertion);
}

async function getAssertion(token: string, options: PublicKeyCredentialRequestOptions, signal?: AbortSignal, rememberMe = false) {
  const result = await navigator.credentials.get({ publicKey: options, ...(signal ? { signal } : {}) });
  if (!(result instanceof PublicKeyCredential) || !(result.response instanceof AuthenticatorAssertionResponse))
    throw new ProtocolError('No Passkey assertion was returned.');
  const response = result.response;
  const handle = response.userHandle;
  if ((!handle && !options.allowCredentials?.length) || (handle && handle.byteLength !== WireLimits.PasskeyUserHandleBytes))
    throw new ProtocolError('Invalid Passkey user handle.');
  const payload = complete(WireLayouts.PasskeyLoginCompleteSize, token, [encoder.encode(result.id), new Uint8Array(result.rawId),
    new Uint8Array(response.clientDataJSON), new Uint8Array(response.authenticatorData), new Uint8Array(response.signature),
    handle ? new Uint8Array(handle) : new Uint8Array(0)], [], true);
  payload[0] = rememberMe ? 1 : 0;
  return encodeFrame(FrameType.PasskeyLoginCompleteRequest, payload);
}

export async function beginPasskeyProvision(ticket: string, signal?: AbortSignal) {
  return post(WireRoutes.PasskeyProvisionBegin, FrameType.PasskeyRegisterBegin, decodeProvisionBegin, signal,
    encodeFrame(FrameType.OperatorSignIn, encodeSignIn({ ticket })));
}

export async function completePasskeyProvision(begin: { token: string; options: PublicKeyCredentialCreationOptions }, signal?: AbortSignal): Promise<void> {
  const attestation = await getAttestation(begin.token, begin.options, signal);
  await post(WireRoutes.PasskeyProvisionComplete, FrameType.EmptySuccess, decodeSuccess, signal, attestation);
}

export async function provisionPasskey(ticket: string, signal?: AbortSignal): Promise<void> {
  const started = await beginPasskeyProvision(ticket, signal);
  await completePasskeyProvision(started, signal);
}

export async function enrollSitePasskey(expectedSession: string, signal?: AbortSignal): Promise<void> {
  if (!validSiteSessionId(expectedSession)) throw invalid();
  const headers = { [WireHeaders.CurrentSession]: expectedSession };
  const assertion = await requestPasskeyAssertion(WireRoutes.SitePasskeyEnrollBegin, signal, undefined, true, false, headers);
  const { token, options } = await post(WireRoutes.SitePasskeyEnrollApprove, FrameType.PasskeyRegisterBegin,
    decodeEnrollmentBegin, signal, assertion, headers);
  const attestation = await getAttestation(token, options, signal);
  await post(WireRoutes.SitePasskeyEnrollComplete, FrameType.EmptySuccess, decodeSuccess, signal, attestation, headers);
}

export async function requestPasskeyAttestation(beginPath: string, signal?: AbortSignal,
  body?: Uint8Array<ArrayBuffer>, headers?: HeadersInit) {
  const { token, options } = await post(beginPath, FrameType.PasskeyRegisterBegin,
    decodeProvisionBegin, signal, body, headers);
  return getAttestation(token, options, signal);
}

async function getAttestation(token: string, options: PublicKeyCredentialCreationOptions, signal?: AbortSignal) {
  const result = await navigator.credentials.create({ publicKey: options, ...(signal ? { signal } : {}) });
  if (!(result instanceof PublicKeyCredential) || !(result.response instanceof AuthenticatorAttestationResponse))
    throw new ProtocolError('No Passkey attestation was returned.');
  const response = result.response;
  const hints = [...new Set(response.getTransports().map(hint => transports.indexOf(hint)).filter(hint => hint >= 0))];
  const payload = complete(WireLayouts.PasskeyRegisterCompleteSize, token, [encoder.encode(result.id), new Uint8Array(result.rawId),
    new Uint8Array(response.clientDataJSON), new Uint8Array(response.attestationObject), new Uint8Array(0), new Uint8Array(0)], hints, false);
  return encodeFrame(FrameType.PasskeyRegisterCompleteRequest, payload);
}

function decodeLoginBegin(payload: Uint8Array, restricted: boolean): { token: string; options: PublicKeyCredentialRequestOptions } {
  if (payload.length < WireLayouts.PasskeyLoginBeginSize) throw invalid();
  const count = view(payload).getInt32(8, true);
  if (restricted ? count < 1 || count > 16 : count !== 0) throw invalid();
  const descriptorSize = WireLayouts.PasskeyCredentialDescriptorSize;
  const data = begin(payload, WireLayouts.PasskeyLoginBeginSize, count * descriptorSize, WireLayouts.PasskeyLoginBeginTokenOffset);
  if (data.pod.getInt32(12, true) !== 0 || data.pod.getInt32(16, true) !== 0) throw invalid();
  const rpId = data.text(0, 253);
  const challenge = data.field(1, WireLimits.PasskeyChallengeBytes);
  const allowCredentials = readDescriptors(data, WireLayouts.PasskeyLoginBeginSize, count);
  data.finish(challenge);
  return { token: data.token, options: { rpId, challenge, timeout: data.timeout, userVerification: 'required', allowCredentials } };
}

export function decodeProvisionBegin(payload: Uint8Array) {
  return decodeRegistrationBegin(payload, false);
}

export function decodeEnrollmentBegin(payload: Uint8Array) {
  return decodeRegistrationBegin(payload, true);
}

function decodeRegistrationBegin(payload: Uint8Array, enrollment: boolean): { token: string; options: PublicKeyCredentialCreationOptions } {
  if (payload.length < WireLayouts.PasskeyRegisterBeginSize) throw invalid();
  const pod = view(payload);
  const count = pod.getInt32(8, true);
  const excludes = pod.getInt32(12, true);
  if (count < 1 || count > 16 || (enrollment ? excludes < 1 || excludes >= WireLimits.SitePasskeyListSize : excludes !== 0))
    throw invalid();
  const descriptorBase = WireLayouts.PasskeyRegisterBeginSize + count * 8;
  const extra = count * 8 + excludes * WireLayouts.PasskeyCredentialDescriptorSize;
  const data = begin(payload, WireLayouts.PasskeyRegisterBeginSize, extra, WireLayouts.PasskeyRegisterBeginTokenOffset);
  for (let offset = 16; offset <= 28; offset += 4) if (data.pod.getInt32(offset, true) !== 0) throw invalid();
  if (data.pod.getUint8(32) !== 0 || data.pod.getUint8(33) !== 1 || data.pod.getUint16(34, true) !== 0)
    throw invalid();
  const pubKeyCredParams: PublicKeyCredentialParameters[] = [];
  for (let i = 0; i < count; i++) {
    if (data.pod.getInt32(WireLayouts.PasskeyRegisterBeginSize + i * 8, true) !== 0) throw invalid();
    pubKeyCredParams.push({ type: 'public-key', alg: data.pod.getInt32(WireLayouts.PasskeyRegisterBeginSize + i * 8 + 4, true) });
  }
  const rp = { id: data.text(0, 253), name: data.text(1, 128) };
  const name = data.text(2, 128);
  const displayName = data.text(3, 128);
  const id = data.field(4, WireLimits.PasskeyUserHandleBytes);
  const challenge = data.field(5, WireLimits.PasskeyChallengeBytes);
  if (id.length !== WireLimits.PasskeyUserHandleBytes) throw invalid();
  const excludeCredentials = readDescriptors(data, descriptorBase, excludes, enrollment);
  data.finish(challenge);
  return { token: data.token, options: { rp, user: { name, displayName, id }, challenge, pubKeyCredParams, timeout: data.timeout,
    attestation: 'none', authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    excludeCredentials } };
}

function readDescriptors(data: ReturnType<typeof begin>, start: number, count: number, requireUnique = false): PublicKeyCredentialDescriptor[] {
  const credentials: PublicKeyCredentialDescriptor[] = [];
  const seen: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const record = start + i * WireLayouts.PasskeyCredentialDescriptorSize;
    if (data.pod.getInt32(record, true) !== 0 || data.pod.getInt32(record + 4, true) !== 0 ||
        data.pod.getInt32(record + 16, true) !== 0) throw invalid();
    const id = data.slice(record + 8, WireLimits.PasskeyCredentialIdBytes);
    if (requireUnique && seen.some(other => other.length === id.length && id.every((byte, index) => other[index] === byte))) throw invalid();
    seen.push(id);
    credentials.push({ type: 'public-key', id });
  }
  return credentials;
}

function begin(payload: Uint8Array, size: number, extra: number, tokenOffset: number) {
  const blobOffset = size + extra + 4;
  if (payload.length < blobOffset || payload.length + WireHeader.HeaderSize > WireLimits.MaxPasskeyFrameBytes) throw invalid();
  const pod = view(payload);
  if (pod.getInt32(blobOffset - 4, true) !== payload.length - blobOffset) throw invalid();
  const tokenBytes = payload.subarray(tokenOffset, tokenOffset + WireLayouts.PasskeyTokenSize);
  const length = tokenBytes.indexOf(0);
  const token = decodeUtf8(tokenBytes.subarray(0, length));
  if (length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(token) || tokenBytes.subarray(length).some(Boolean)) throw invalid();
  const timeout = Number(pod.getBigUint64(0, true));
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000) throw invalid();
  let position = 0;
  const slice = (reference: number, limit: number): Uint8Array<ArrayBuffer> => {
    const offset = pod.getInt32(reference, true);
    const length = pod.getInt32(reference + 4, true);
    if (offset !== position || length < 1 || length > limit || length > payload.length - blobOffset - offset)
      throw invalid();
    position += length;
    return new Uint8Array(payload.subarray(blobOffset + offset, blobOffset + position));
  };
  const field = (index: number, limit: number) => slice(tokenOffset + WireLayouts.PasskeyTokenSize + index * WireLayouts.PasskeySliceSize, limit);
  return { pod, token, timeout, field, slice, text: (index: number, limit: number) => decodeUtf8(field(index, limit)),
    finish(challenge: Uint8Array) {
      if (position + blobOffset !== payload.length || challenge.length !== WireLimits.PasskeyChallengeBytes) throw invalid();
    } };
}

export type DecodedPasskeyLoginFlow =
  | { kind: 'reader'; pending: string | null }
  | { kind: 'admin' };

export function decodeLoginFlow(payload: Uint8Array): DecodedPasskeyLoginFlow {
  if (payload.length !== WireLayouts.PasskeyAuthLoginFlowSize || view(payload).getInt32(0, true) <= 0 || payload[7] !== 1)
    throw invalid();
  if (decodeUtf8(payload.subarray(8, 21)) === 'administrator') {
    if (payload[4] !== 1 || payload[5] !== 0 || payload[6] !== 0 || payload.subarray(21).some(Boolean))
      throw invalid();
    return { kind: 'admin' };
  }
  if (decodeUtf8(payload.subarray(8, 25)) !== 'anonymous_account' || payload.subarray(25, 104).some(Boolean))
    throw invalid();
  if (payload[4] === 1 && payload[5] === 0 && payload[6] === 0 && !payload.subarray(104).some(Boolean))
    return { kind: 'reader', pending: null };
  if (payload[4] !== 2 || payload[5] !== 2 || payload[6] !== 1 || payload.subarray(147).some(Boolean))
    throw invalid();
  const token = decodeUtf8(payload.subarray(104, 147));
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
  return { kind: 'reader', pending: token };
}

function complete(size: number, token: string, fields: Uint8Array[], hints: number[], login: boolean) {
  const blobStart = size + hints.length * 4 + 4;
  const blobSize = fields.reduce((sum, field) => sum + field.length, 0);
  if (blobStart + blobSize + WireHeader.HeaderSize > WireLimits.MaxPasskeyFrameBytes) throw invalid();
  const payload = new Uint8Array(blobStart + blobSize);
  const data = view(payload);
  if (login) payload[1] = fields[5].length > 0 ? 1 : 0;
  else data.setInt32(4, hints.length, true);
  payload.set(encoder.encode(token), WireLayouts.PasskeyCompleteTokenOffset);
  hints.forEach((hint, index) => data.setInt32(size + index * 4, hint, true));
  data.setInt32(blobStart - 4, blobSize, true);
  let offset = 0;
  fields.forEach((field, index) => {
    const reference = WireLayouts.PasskeyCompleteBlobRefsOffset + index * WireLayouts.PasskeySliceSize;
    data.setInt32(reference, offset, true);
    data.setInt32(reference + 4, field.length, true);
    payload.set(field, blobStart + offset);
    offset += field.length;
  });
  return payload;
}

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}
