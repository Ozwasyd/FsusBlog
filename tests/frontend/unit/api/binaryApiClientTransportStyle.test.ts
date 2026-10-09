import { afterEach, describe, expect, it, vi } from 'vitest';

import { binaryRequest } from '@/api/binaryApiClient';
import { SecurityChallengeKind } from '@/contracts/binaryApi';
import type { BinaryRequestOptions } from '@/contracts/binaryTransport';
import type { RiskChallengeProofContext } from '@/contracts/riskChallenge';

vi.mock('@/composables/usePow', () => ({
    usePow: () => ({ calculate: vi.fn() })
}));

vi.mock('@/utils/fingerprint', () => ({
    getBrowserFp: () => 'transport-style-browser-fp'
}));

function createDeferred<T>()
{
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) =>
    {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

describe('binaryApiClient transport rejection and option preservation', () =>
{
    afterEach(() =>
    {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it.each([
        new TypeError('Failed to fetch'),
        new DOMException('The operation was aborted.', 'AbortError'),
        'external rejection value'
    ])('preserves the original shared rejection value %s and cleans every waiter', async (reason) =>
    {
        const network = createDeferred<Response>();
        const firstController = new AbortController();
        const secondController = new AbortController();
        const removeFirst = vi.spyOn(firstController.signal, 'removeEventListener');
        const removeSecond = vi.spyOn(secondController.signal, 'removeEventListener');
        const fetchMock = vi.fn((_url: RequestInfo | URL, _options?: RequestInit) => network.promise);
        vi.stubGlobal('fetch', fetchMock);

        const first = binaryRequest('/api/binary/transport-style/rejection', { signal: firstController.signal });
        const second = binaryRequest('/api/binary/transport-style/rejection', { signal: secondController.signal });
        const outcomes = Promise.allSettled([first, second]);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        network.reject(reason);

        const settled = await outcomes;
        for (const result of settled)
        {
            expect(result.status).toBe('rejected');
            if (result.status === 'rejected')
            {
                expect(result.reason).toBe(reason);
            }
        }
        expect(removeFirst).toHaveBeenCalledTimes(1);
        expect(removeSecond).toHaveBeenCalledTimes(1);
        const sharedSignal = fetchMock.mock.calls[0]?.[1]?.signal;
        firstController.abort();
        secondController.abort();
        expect(sharedSignal?.aborted).toBe(false);

        fetchMock.mockImplementationOnce(async () => new Response(new Uint8Array([9])));
        expect(new Uint8Array(await binaryRequest('/api/binary/transport-style/rejection'))).toEqual(new Uint8Array([9]));
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('cancels one waiter without cancelling its peer and removes the listener before rejection', async () =>
    {
        const network = createDeferred<Response>();
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const fetchMock = vi.fn((_url: RequestInfo | URL, _options?: RequestInit) => network.promise);
        vi.stubGlobal('fetch', fetchMock);
        const cancelled = binaryRequest('/api/binary/transport-style/peer', { signal: controller.signal });
        const peer = binaryRequest('/api/binary/transport-style/peer');
        const cancelledOutcome = cancelled.catch((reason: unknown) =>
        {
            expect(remove).toHaveBeenCalledTimes(1);
            return reason;
        });
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        controller.abort();
        expect(await cancelledOutcome).toMatchObject({ name: 'AbortError' });
        expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
        network.resolve(new Response(new Uint8Array([3])));
        expect(new Uint8Array(await peer)).toEqual(new Uint8Array([3]));
        controller.abort();
        expect(remove).toHaveBeenCalledTimes(1);
    });

    it('cancels the shared fetch after the final waiter is cleaned and ignores its late rejection', async () =>
    {
        const network = createDeferred<Response>();
        const firstController = new AbortController();
        const secondController = new AbortController();
        const removeFirst = vi.spyOn(firstController.signal, 'removeEventListener');
        const removeSecond = vi.spyOn(secondController.signal, 'removeEventListener');
        const fetchMock = vi.fn((_url: RequestInfo | URL, _options?: RequestInit) => network.promise);
        vi.stubGlobal('fetch', fetchMock);
        const first = binaryRequest('/api/binary/transport-style/final', { signal: firstController.signal });
        const second = binaryRequest('/api/binary/transport-style/final', { signal: secondController.signal });
        const outcomes = Promise.allSettled([first, second]);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const signal = fetchMock.mock.calls[0]?.[1]?.signal;
        signal?.addEventListener('abort', () =>
        {
            expect(removeFirst).toHaveBeenCalledTimes(1);
            expect(removeSecond).toHaveBeenCalledTimes(1);
        });
        firstController.abort();
        expect(signal?.aborted).toBe(false);
        secondController.abort();
        expect(signal?.aborted).toBe(true);
        const results = await outcomes;
        for (const result of results)
        {
            expect(result.status).toBe('rejected');
            if (result.status === 'rejected')
            {
                expect(result.reason).toMatchObject({ name: 'AbortError' });
            }
        }
        network.reject(new TypeError('late fetch failure'));
        await vi.waitFor(() => expect(removeSecond).toHaveBeenCalledTimes(1));
    });

    it('strips proof and observer without mutating input or changing proof settlement and fetch options', async () =>
    {
        const lease: RiskChallengeProofContext = {
            proof: {
                action: 'comment.create',
                routeKey: 'article:42',
                challengeId: 'challenge-1',
                kind: SecurityChallengeKind.PerceptionLocalizationV2,
                proofToken: 'proof-token',
                policyVersion: 'policy-v1',
                verifiedAtUnixMs: 1_000,
                expiresAtUnixMs: 60_000
            },
            markInFlight: vi.fn(() => true),
            settle: vi.fn(() => true)
        };
        const observer = vi.fn();
        const fetchMock = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) =>
            new Response(new Uint8Array([1]), { headers: { 'X-Test-Response': 'kept' } }));
        vi.stubGlobal('fetch', fetchMock);
        const options: BinaryRequestOptions = Object.freeze({
            method: 'POST',
            credentials: 'omit',
            cache: 'no-store',
            requiresPow: false,
            powScope: 'transport-style',
            headers: { Authorization: 'Bearer secret', Cookie: 'sid=secret', 'X-Test': 'kept' },
            riskChallengeProof: lease,
            onResponseHeaders: observer
        });
        await binaryRequest('/api/binary/transport-style/options', options);
        const init = fetchMock.mock.calls[0]?.[1];
        expect(init).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store', requiresPow: false, powScope: 'transport-style' });
        expect(init).not.toHaveProperty('riskChallengeProof');
        expect(init).not.toHaveProperty('onResponseHeaders');
        expect(options.riskChallengeProof).toBe(lease);
        expect(options.onResponseHeaders).toBe(observer);
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBeNull();
        expect(headers.get('cookie')).toBeNull();
        expect(headers.get('X-Test')).toBe('kept');
        expect(headers.get('X-Fsus-Challenge-Proof')).toBe('proof-token');
        expect(lease.markInFlight).toHaveBeenCalledOnce();
        expect(lease.settle).toHaveBeenCalledWith('accepted');
        expect(observer).toHaveBeenCalledOnce();
        expect(observer.mock.calls[0]?.[0].get('X-Test-Response')).toBe('kept');
    });
});
