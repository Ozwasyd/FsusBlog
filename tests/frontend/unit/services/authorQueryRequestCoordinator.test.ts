import { afterEach, describe, expect, it } from 'vitest';

import { AuthorQueryRequestCoordinator } from '@/services/authoring/authorQueryRequestCoordinator';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';
import { clearRegisteredPrivateState } from '@/services/privateStorageRegistry';

const coordinators: AuthorQueryRequestCoordinator[] = [];
const digest = 'a'.repeat(64);
function create(): AuthorQueryRequestCoordinator {
    const coordinator = new AuthorQueryRequestCoordinator();
    coordinators.push(coordinator);
    return coordinator;
}

afterEach(() => {
    for (const coordinator of coordinators.splice(0)) {
        coordinator.dispose();
    }
    privateRequestRuntime.resetForTests();
});

describe('author query request coordinator', () => {
    it('aborts old transport and suppresses an old completion even if it ignores abort', () => {
        const coordinator = create();
        const first = coordinator.begin(digest);
        const second = coordinator.begin(digest);
        expect(first.signal.aborted).toBe(true);
        expect(() => first.assertCurrent()).toThrow('author_query_request_stale');
        expect(second.requestSequence).toBe(first.requestSequence + 1);
        expect(second.requestId).not.toBe(first.requestId);
        second.assertCurrent();
    });

    it('uses the original admin generation and rejects logout-era responses', () => {
        const request = create().begin(digest);
        expect(request.adminGeneration).toBe(privateRequestRuntime.adminSessionGeneration);
        privateRequestRuntime.advance('admin');
        expect(request.signal.aborted).toBe(true);
        expect(() => request.assertCurrent()).toThrow('stale_private_response');
    });

    it('honors caller cancellation before and after beginning a request', () => {
        const before = new AbortController();
        before.abort();
        const first = create().begin(digest, before.signal);
        expect(first.signal.aborted).toBe(true);
        expect(() => first.assertCurrent()).toThrow();
        const after = new AbortController();
        const second = create().begin(digest, after.signal);
        after.abort();
        expect(second.signal.aborted).toBe(true);
        expect(() => second.assertCurrent()).toThrow();
    });

    it('old release cannot remove the newer active slot', () => {
        const coordinator = create();
        const first = coordinator.begin(digest);
        const second = coordinator.begin(digest);
        first.release();
        first.release();
        second.assertCurrent();
        second.release();
        expect(() => second.assertCurrent()).toThrow();
    });

    it('keeps independent query slots independent while sharing admin generation', () => {
        const entity = create().begin(digest);
        const fullText = create().begin('b'.repeat(64));
        entity.release();
        fullText.assertCurrent();
        privateRequestRuntime.advance('admin');
        expect(() => fullText.assertCurrent()).toThrow();
    });

    it.each(['account-switch', 'admin-logout', 'credential-revoked', 'epoch-changed', 'panic'] as const)(
        'cancels via registered private cleanup: %s', async (trigger) => {
            const request = create().begin(digest);
            await clearRegisteredPrivateState({ trigger });
            expect(request.signal.aborted).toBe(true);
            expect(() => request.assertCurrent()).toThrow();
        }
    );

    it('dispose is repeatable and cannot be bypassed by later begin', () => {
        const coordinator = create();
        const request = coordinator.begin(digest);
        coordinator.dispose();
        coordinator.dispose();
        expect(request.signal.aborted).toBe(true);
        expect(() => coordinator.begin(digest)).toThrow('author_query_request_invalid');
    });

    it.each(['', 'private query text', 'g'.repeat(64), 'a'.repeat(65)])('rejects invalid identity %s', (scope) => {
        expect(() => create().begin(scope)).toThrow('author_query_request_invalid');
    });
});
