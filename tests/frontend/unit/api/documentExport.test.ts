import { describe, expect, it, vi } from 'vitest';

import { createDocumentExportCall } from '@/components/document-export/documentExportCall';
import type { DocumentExportCallState } from '@/components/document-export/documentExportCall';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((accept, refuse) => {
        resolve = accept;
        reject = refuse;
    });
    return { promise, resolve, reject };
}

describe('document export command coordination', () => {
    it('coalesces a synchronous status callback submit without a second write', async () => {
        const execute = vi.fn().mockResolvedValue('receipt');
        let reentered = false;
        const call = createDocumentExportCall({
            captureRequest: (request: string) => request,
            execute,
            changed: (state) => {
                if (state.phase === 'pending' && !reentered) {
                    reentered = true;
                    void call.start('second');
                }
            },
            classifyFailure: () => 'uncertain',
            permissionRevoked: vi.fn(),
            allowUncertainRetry: true,
        });
        await call.start('first');
        expect(execute).toHaveBeenCalledExactlyOnceWith('first');
    });

    it('allows a new identity after synchronous pending callback invalidation', async () => {
        const execute = vi.fn().mockResolvedValue('receipt');
        let resetOnce = true;
        const call = createDocumentExportCall({
            captureRequest: (request: string) => request,
            execute,
            changed: (state) => {
                if (state.phase === 'pending' && resetOnce) {
                    resetOnce = false;
                    call.reset();
                }
            },
            classifyFailure: () => 'uncertain',
            permissionRevoked: vi.fn(),
            allowUncertainRetry: true,
        });
        await call.start('old');
        await call.start('new');
        expect(execute).toHaveBeenCalledExactlyOnceWith('new');
    });

    it('captures an immutable payload before an uncertain response and UI edits', async () => {
        const execute = vi.fn().mockRejectedValueOnce('lost').mockResolvedValueOnce('receipt');
        const call = createDocumentExportCall({
            captureRequest: (request: { format: string }) => Object.freeze({ ...request }),
            execute,
            changed: vi.fn(),
            classifyFailure: () => 'uncertain',
            permissionRevoked: vi.fn(),
            allowUncertainRetry: true,
        });
        const request = { format: 'pdf' };
        await call.start(request);
        request.format = 'epub';
        await call.retry();
        expect(execute.mock.calls[1]?.[0]).toEqual({ format: 'pdf' });
        expect(execute.mock.calls[1]?.[0]).toBe(execute.mock.calls[0]?.[0]);
    });
    it('performs zero writes if identity changes before dispatch', async () => {
        const execute = vi.fn().mockResolvedValue('should not run');
        const call = createDocumentExportCall({
            captureRequest: (request) => request,
            execute,
            changed: vi.fn(),
            classifyFailure: () => 'uncertain',
            permissionRevoked: vi.fn(),
            allowUncertainRetry: true,
        });
        const completion = call.start('old-user');
        call.reset();
        await completion;
        expect(execute).not.toHaveBeenCalled();
    });
    it('coalesces clicks and accepts only an actual adapter response', async () => {
        const response = deferred<string>();
        const execute = vi.fn(() => response.promise);
        const states: DocumentExportCallState<string>[] = [];
        const call = createDocumentExportCall({
            captureRequest: (request) => request,
            execute,
            changed: (state) => states.push(state),
            classifyFailure: () => 'uncertain',
            permissionRevoked: vi.fn(),
            allowUncertainRetry: true,
        });
        const first = call.start('same-request');
        expect(call.start('different-request')).toBe(first);
        expect(states).toEqual([{ phase: 'pending' }]);
        await Promise.resolve();
        expect(execute).toHaveBeenCalledExactlyOnceWith('same-request');
        response.resolve('actual-response');
        await first;
        expect(states.at(-1)).toEqual({ phase: 'confirmed', result: 'actual-response' });
    });

    it('holds an uncertain request and explicitly retries its exact identity', async () => {
        const execute = vi.fn().mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce('receipt');
        const states: DocumentExportCallState<string>[] = [];
        const call = createDocumentExportCall<object, string>({
            captureRequest: (request) => Object.freeze({ ...request }),
            execute,
            changed: (state) => states.push(state),
            classifyFailure: () => 'uncertain',
            permissionRevoked: vi.fn(),
            allowUncertainRetry: true,
        });
        const request = Object.freeze({ idempotencyKey: 'fixed' });
        await call.start(request);
        expect(states.at(-1)).toEqual({ phase: 'uncertain' });
        await call.start({ idempotencyKey: 'new' });
        expect(execute).toHaveBeenCalledTimes(1);
        await call.retry();
        expect(execute.mock.calls[1]?.[0]).toBe(execute.mock.calls[0]?.[0]);
        expect(execute.mock.calls[1]?.[0]).toEqual(request);
        expect(states.at(-1)).toEqual({ phase: 'confirmed', result: 'receipt' });
    });

    it('never replays an uncertain single-use download', async () => {
        const execute = vi.fn().mockRejectedValue(new Error('unknown delivery'));
        const call = createDocumentExportCall({
            captureRequest: (request) => request,
            execute,
            changed: vi.fn(),
            classifyFailure: () => 'uncertain',
            permissionRevoked: vi.fn(),
            allowUncertainRetry: false,
        });
        await call.start('download');
        await call.retry();
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('invalidates private late responses and clears retry identity on revocation', async () => {
        const response = deferred<string>();
        const states: DocumentExportCallState<string>[] = [];
        const revoked = vi.fn();
        const execute = vi.fn().mockImplementationOnce(() => response.promise).mockRejectedValueOnce('denied');
        const call = createDocumentExportCall({
            captureRequest: (request) => request,
            execute,
            changed: (state) => states.push(state),
            classifyFailure: () => 'permission-revoked',
            permissionRevoked: revoked,
            allowUncertainRetry: true,
        });
        const old = call.start('old-user');
        await Promise.resolve();
        call.reset();
        response.resolve('private old output');
        await old;
        expect(states.at(-1)).toEqual({ phase: 'idle' });
        await call.start('new-user');
        expect(revoked).toHaveBeenCalledOnce();
        expect(states.at(-1)).toEqual({ phase: 'permission-revoked' });
        await call.retry();
        await call.start('another-request');
        expect(execute).toHaveBeenCalledTimes(2);
    });
});
