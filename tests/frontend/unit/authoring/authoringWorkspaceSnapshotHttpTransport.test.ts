import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decode } from '@wasm/aeds';
import { AEDS_HEADER_LENGTH, AEDS_MAGIC, AEDS_VERSION, FrameType } from '@wasm/protocol/frame';
import { encodeAedsFrame } from '@/api/binaryFrame';
import { FSUS_HEADERS } from '@/api/contracts';
import { defaultWorkspaceSnapshotLayout } from '@/api/authoringWorkspaceSnapshot';
import { createAuthoringWorkspaceSnapshotHttpTransport } from '@/api/authoringWorkspaceSnapshotHttpTransport';
import { decodeAuthoringWorkspaceSnapshotRequest, encodeAuthoringWorkspaceSnapshotResponse,
    type AuthoringWorkspaceSnapshotResponse } from '@/codecs/binary/authoringWorkspaceSnapshotWire.generated';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';

// Only network and unavailable native/worker boundaries are replaced. The actual
// HTTP client, private leases, binary transport, registry and payload codec run.
const boundary = vi.hoisted(() => ({ fetch: vi.fn(), solve: vi.fn() }));
vi.mock('@/composables/usePow', () => ({ usePow: () => ({ calculate: boundary.solve }) }));

const endpoint = '/api/binary/author/workspace/default';
const sourceDigest = 'a'.repeat(64);
const confirmationDigest = 'b'.repeat(64);
const transport = createAuthoringWorkspaceSnapshotHttpTransport(sourceDigest);
const layout = defaultWorkspaceSnapshotLayout();

function result(action: 'read' | 'write' | 'reset' = 'read'): AuthoringWorkspaceSnapshotResponse
{
    const status = action === 'read' ? 'missing' : 'blocked';
    return { status, revision: 0, snapshot: null, receipt: {
        schema: 'fsusblog.authoring-workspace-snapshot-receipt.v1', action, status,
        reason: action === 'read' ? null : 'diagnostic-unit-response',
        scope: { userId: 7, siteId: 'diagnostic-site' }, workspaceId: 'default', sourceDigest,
        revisionBefore: 0, revisionAfter: 0, tabCount: 0, byteCount: 0,
        inputDigest: 'c'.repeat(64), snapshotDigest: null, contentDigest: 'd'.repeat(64)
    } };
}

function responseFrame(value = result()): ArrayBuffer
{
    return encodeAedsFrame(FrameType.AuthoringWorkspaceSnapshotResponse,
        encodeAuthoringWorkspaceSnapshotResponse(value));
}

function powFrame(): ArrayBuffer
{
    const payload = new Uint8Array(204);
    const view = new DataView(payload.buffer);
    payload.set(new TextEncoder().encode('diagnostic-salt'));
    view.setInt32(64, 1, true);
    view.setBigInt64(68, 1700000000000n, true);
    payload.set(new TextEncoder().encode('diagnostic-signature'), 76);
    return encodeAedsFrame(FrameType.PowChallenge, payload);
}

// AEDS framing extraction stands in for native Wasm, never for typed payload
// validation. These controls make no claim about CRC/native qualification.
function decodeAtNativeBoundary(buffer: ArrayBuffer): ReturnType<typeof decode>
{
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    if (bytes.length < AEDS_HEADER_LENGTH || view.getUint32(0, true) !== AEDS_MAGIC
        || view.getUint8(4) !== AEDS_VERSION)
    {
        return { ok: false, frameType: FrameType.Unknown,
            payloadView: new Uint8Array(), error: 'diagnostic-invalid-outer-frame' };
    }
    const payloadView = bytes.subarray(view.getUint8(5));
    return { ok: true, frameType: view.getUint16(8, true) as FrameType,
        payloadView, error: '' };
}

function callsToWorkspace(): Array<[string, RequestInit]>
{
    return boundary.fetch.mock.calls.filter(([url]) => new URL(String(url)).pathname === endpoint)
        .map(([url, options]) => [String(url), options as RequestInit]);
}

beforeEach(() =>
{
    privateRequestRuntime.resetForTests();
    boundary.fetch.mockReset();
    boundary.solve.mockReset().mockResolvedValue({ nonce: 'diagnostic-nonce', duration: 1 });
    vi.mocked(decode).mockReset().mockImplementation(decodeAtNativeBoundary);
    vi.stubGlobal('fetch', boundary.fetch);
    document.head.insertAdjacentHTML('beforeend', '<meta name="fsus-csrf-token" content="diagnostic-csrf">');
    boundary.fetch.mockImplementation(async (url: string) =>
        new Response(new URL(String(url)).pathname === '/api/binary/auth/pow-challenge'
            ? powFrame() : responseFrame(), { status: 200 }));
});

afterEach(() =>
{
    privateRequestRuntime.resetForTests();
    document.querySelector('meta[name="fsus-csrf-token"]')?.remove();
    vi.unstubAllGlobals();
});

describe('workspace snapshot actual private HTTP / typed AEDS boundary', () =>
{
    it.each(['', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)])('rejects invalid source digest %s before any request', digest =>
    {
        expect(() => createAuthoringWorkspaceSnapshotHttpTransport(digest)).toThrow('workspace_snapshot_source_digest_invalid');
        expect(boundary.fetch).not.toHaveBeenCalled();
    });

    it('reads through the registered response codec with private credentials and binary Accept', async () =>
    {
        await expect(transport.read()).resolves.toEqual(result());
        const [url, options] = callsToWorkspace()[0];
        expect(new URL(url).pathname).toBe(endpoint);
        expect(options).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'include' });
        expect(new Headers(options.headers).get('Accept')).toBe('application/octet-stream');
        expect(options.body).toBeUndefined();
        expect(boundary.solve).not.toHaveBeenCalled();
    });

    it('preserves a populated typed current snapshot and its safe int64 revision through registry dispatch', async () =>
    {
        const current = result();
        current.status = 'current';
        current.revision = 9007199254740991;
        current.snapshot = { schemaVersion: 1, workspaceId: 'default', scope: current.receipt.scope,
            sourceContract: 'fsusblog.authoring-workspace-snapshot.v1', sourceDigest,
            revision: current.revision, updatedAt: 1700000000000, layout, contentDigest: 'e'.repeat(64) };
        Object.assign(current.receipt, { status: 'current', revisionBefore: current.revision,
            revisionAfter: current.revision, byteCount: 1, snapshotDigest: current.snapshot.contentDigest });
        boundary.fetch.mockResolvedValue(new Response(responseFrame(current)));
        await expect(transport.read()).resolves.toEqual(current);
    });

    it.each(['write', 'reset'] as const)('sends %s CAS intent in real AEDS v2 bytes and shared CSRF / PoW headers', async action =>
    {
        boundary.fetch.mockImplementation(async (url: string) => new Response(
            new URL(String(url)).pathname === '/api/binary/auth/pow-challenge' ? powFrame() : responseFrame(result(action))));
        if (action === 'write')
        {
            await expect(transport.write({ expectedRevision: 9007199254740990, layout })).resolves.toEqual(result(action));
        }
        else
        {
            await expect(transport.reset({ expectedRevision: 9007199254740990, confirmationDigest })).resolves.toEqual(result(action));
        }
        const [, options] = callsToWorkspace()[0];
        const headers = new Headers(options.headers);
        expect(options).toMatchObject({ method: 'POST', cache: 'no-store', credentials: 'include' });
        expect(headers.get('Content-Type')).toBe('application/octet-stream');
        expect(headers.get('Accept')).toBe('application/octet-stream');
        expect(headers.get(FSUS_HEADERS.csrfToken)).toBe('diagnostic-csrf');
        expect(headers.get(FSUS_HEADERS.powProof)).toBeTruthy();
        expect(headers.get(FSUS_HEADERS.deviceFingerprint)).toBeTruthy();
        expect(boundary.solve).toHaveBeenCalledWith('diagnostic-salt', expect.any(String), 1, 60000, expect.any(AbortSignal));
        expect(boundary.fetch.mock.calls.map(([url, init]) => [new URL(String(url)).pathname, init.method ?? 'GET']))
            .toEqual([['/api/binary/auth/pow-challenge', 'GET'], [endpoint, 'POST']]);
        expect(options.body).toBeInstanceOf(ArrayBuffer);
        const body = options.body as ArrayBuffer;
        const view = new DataView(body);
        expect(view.getUint32(0, true)).toBe(AEDS_MAGIC);
        expect(view.getUint8(4)).toBe(2);
        expect(view.getUint16(8, true)).toBe(FrameType.AuthoringWorkspaceSnapshotRequest);
        const actual = decodeAuthoringWorkspaceSnapshotRequest(new Uint8Array(body).subarray(view.getUint8(5)));
        expect(actual).toEqual({ action, expectedRevision: 9007199254740990, sourceDigest,
            layout: action === 'write' ? layout : null,
            resetConfirmationDigest: action === 'reset' ? confirmationDigest : null });
        expect(Object.keys(actual).sort()).toEqual(['action', 'expectedRevision', 'layout', 'resetConfirmationDigest', 'sourceDigest']);
        for (const forbidden of ['scope', 'owner', 'actor', 'userId', 'siteId', 'session', 'receipt'])
        {
            expect(actual).not.toHaveProperty(forbidden);
        }
    });

    it.each(['wrong-root', 'outer', 'schema', 'truncated', 'trailing', 'text-json', 'receipt-inconsistent'])('rejects %s response without a text fallback', async defect =>
    {
        let payload = encodeAuthoringWorkspaceSnapshotResponse(result());
        let frameType: FrameType = FrameType.AuthoringWorkspaceSnapshotResponse;
        if (defect === 'wrong-root') frameType = FrameType.AuthoringWorkspaceSnapshotRequest;
        if (defect === 'schema') payload[0] = 2;
        if (defect === 'truncated') payload = payload.subarray(0, payload.length - 1);
        if (defect === 'trailing') { const changed = new Uint8Array(payload.length + 1); changed.set(payload); payload = changed; }
        if (defect === 'text-json') payload = new TextEncoder().encode(JSON.stringify(result()));
        // The top-level closed status precedes revision; receipt still says missing.
        if (defect === 'receipt-inconsistent') payload[1] = 2;
        const buffer = defect === 'outer' ? new ArrayBuffer(1) : encodeAedsFrame(frameType, payload);
        boundary.fetch.mockResolvedValue(new Response(buffer));
        // The existing shared classifier treats plain payload-codec Errors as
        // network failures. Preserve this diagnostic gap while proving rejection.
        const nativeFailure = defect === 'wrong-root' || defect === 'outer';
        await expect(transport.read()).rejects.toMatchObject({ name: 'BinaryTransportError',
            kind: nativeFailure ? 'decode_failed' : 'network',
            message: nativeFailure ? expect.any(String) : 'invalid_workspace_snapshot_wire' });
        expect(callsToWorkspace()).toHaveLength(1);
        expect(boundary.fetch).toHaveBeenCalledOnce();
        expect(callsToWorkspace()[0][1].method).toBe('GET');
    });

    it.each(['caller-abort', 'admin-logout', 'admin-generation'] as const)('rejects a late fetch after %s even when network ignores abort', async transition =>
    {
        let finish!: (response: Response) => void;
        boundary.fetch.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
        const controller = new AbortController();
        const pending = transport.read(controller.signal);
        const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(callsToWorkspace()).toHaveLength(1));
        const signal = callsToWorkspace()[0][1].signal!;
        if (transition === 'caller-abort') controller.abort();
        else if (transition === 'admin-logout') privateRequestRuntime.advanceForAuthTransition('admin-logout');
        else privateRequestRuntime.advance('admin');
        expect(signal.aborted).toBe(true);
        finish(new Response(responseFrame()));
        await rejection;
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(decode).not.toHaveBeenCalled();
        // A completed interrupted request must not poison the next GET or lease.
        boundary.fetch.mockResolvedValue(new Response(responseFrame()));
        await expect(transport.read()).resolves.toEqual(result());
    });

    it('rejects an already aborted caller without making a network request', async () =>
    {
        const controller = new AbortController();
        controller.abort();
        await expect(transport.read(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(boundary.fetch).not.toHaveBeenCalled();
        expect(decode).not.toHaveBeenCalled();
    });

    it('checks the actual admin generation after registered payload decoding', async () =>
    {
        vi.mocked(decode).mockImplementation(buffer =>
        {
            const frame = decodeAtNativeBoundary(buffer);
            privateRequestRuntime.advanceForAuthTransition('admin-logout');
            return frame;
        });
        await expect(transport.read()).rejects.toMatchObject({ name: 'AbortError', scope: 'admin' });
    });

    it('keeps an admin read valid across an independent account logout', async () =>
    {
        let finish!: (response: Response) => void;
        boundary.fetch.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
        const pending = transport.read();
        await vi.waitFor(() => expect(callsToWorkspace()).toHaveLength(1));
        const signal = callsToWorkspace()[0][1].signal!;
        privateRequestRuntime.advanceForAuthTransition('logout');
        expect(signal.aborted).toBe(false);
        finish(new Response(responseFrame()));
        await expect(pending).resolves.toEqual(result());
    });

    it('cancels before mutation when abort occurs during the real PoW challenge request', async () =>
    {
        let finish!: (response: Response) => void;
        boundary.fetch.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
        const controller = new AbortController();
        const pending = transport.write({ expectedRevision: 0, layout }, controller.signal);
        const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(boundary.fetch).toHaveBeenCalledOnce());
        controller.abort();
        finish(new Response(powFrame()));
        await rejection;
        expect(callsToWorkspace()).toHaveLength(0);
        expect(boundary.solve).not.toHaveBeenCalled();
    });

    it('rejects malformed mutation layout before PoW or network', async () =>
    {
        const invalid = { ...layout, tabs: [], groups: [] };
        await expect(async () => transport.write({ expectedRevision: 0, layout: invalid })).rejects.toThrow('invalid_workspace_snapshot_wire');
        expect(boundary.fetch).not.toHaveBeenCalled();
        expect(boundary.solve).not.toHaveBeenCalled();
    });
});
