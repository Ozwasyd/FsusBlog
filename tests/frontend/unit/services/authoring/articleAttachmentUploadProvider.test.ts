import { beforeEach, describe, expect, it, vi } from 'vitest';
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/composition/binaryTransport', () => ({ requestBinaryOnly: request }));
import { createArticleAttachmentUploadProvider } from '@/services/authoring/articleAttachmentUploadProvider';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { FrameType } from '@wasm/protocol/frame';

const bytes = new Uint8Array([1, 2, 3]);
const digest = bytesToHex(sha256(bytes));
const session = { uploadId: '0123456789abcdef0123456789abcdef', uploadToken: 'original-secret-token', sha256: digest, totalBytes: 3, commitMayHaveStarted: false };
const status = (state: string) => ({ uploadId: session.uploadId, status: state, totalBytes: 3, uploadedBytes: state === 'pending' ? 1 : 3 });
const preview = { schema: 'fsusblog.upload-asset-preview.v1', uploadId: session.uploadId, assetId: '01234567-89ab-cdef-0123-456789abcdef',
    publicUrl: '/uploads/illustration/0123456789abcdef0123456789abcdef.png', sha256: digest,
    assetVersionSha256: 'a'.repeat(64), referenceLedgerSha256: 'b'.repeat(64), sizeBytes: 3, bytes };

// Controlled transport facts exercise the actual public API; they are not native,
// PoW/owner-runtime or business reference receipt qualification.
function facts(sizeBytes: number) {
    return { schema: 'fsusblog.upload-asset-facts.v1', uploadId: session.uploadId, assetId: preview.assetId,
        publicUrl: preview.publicUrl, sha256: digest, assetVersionSha256: preview.assetVersionSha256,
        referenceLedgerSha256: preview.referenceLedgerSha256, sizeBytes,
        mimeType: 'image/png', extension: '.png', width: 1, height: 1, referenceRowCount: 0 };
}

describe('original upload business provider operations' , () => {
    beforeEach(() => request.mockReset());
    it('observes actual status with owner token and actual progress without committing', async () => {
        request.mockResolvedValue(status('pending'));
        const provider = createArticleAttachmentUploadProvider(session);
        expect(await provider.observe()).toEqual({ status: 'pending', uploadedBytes: 1, totalBytes: 3 });
        expect(request.mock.calls[0][0]).toMatchObject({ privateScope: 'admin', requestOptions: { requiresPow: true, headers: { 'X-Fsus-Upload-Token': session.uploadToken } } });
        expect(request).toHaveBeenCalledOnce();
    });
    it('uses actual completion then re-observes original ledger/bytes instead of trusting URL', async () => {
        request.mockResolvedValueOnce({ url: 'unverified-url' }).mockResolvedValueOnce(status('completed')).mockResolvedValueOnce(preview);
        const result = await createArticleAttachmentUploadProvider(session).retryCommit();
        expect(result.status).toBe('committed');
        expect(JSON.stringify(result)).not.toMatch(/original-secret-token|"bytes"|unverified-url/u);
        expect(request.mock.calls[0][0].binaryUrl).toContain('/complete');
        expect(request.mock.calls[2][0].binaryRoute.operationId).toBe('binary_post_upload_uploadId_preview');
    });
    it('coalesces duplicate commit attempts against the same original session', async () => {
        let finish!: (value: unknown) => void;
        request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const provider = createArticleAttachmentUploadProvider(session);
        const first = provider.retryCommit();
        const second = provider.retryCommit();
        request.mockResolvedValueOnce(status('completed')).mockResolvedValueOnce(preview);
        finish({ url: 'not-a-receipt' });
        expect(await first).toEqual(await second);
        expect(request).toHaveBeenCalledTimes(3);
    });
    it.each([3, 20_971_520])('rejects a joining caller abort while preserving the original %i-byte commit', async totalBytes => {
        let finish!: (value: unknown) => void;
        let taskSignal!: AbortSignal;
        request.mockImplementationOnce(call => new Promise(resolve => {
            taskSignal = call.signal;
            finish = resolve;
        }));
        const provider = createArticleAttachmentUploadProvider({ ...session, totalBytes, commitMayHaveStarted: true });
        const owner = new AbortController();
        const added = vi.spyOn(owner.signal, 'addEventListener');
        const removed = vi.spyOn(owner.signal, 'removeEventListener');
        const first = provider.retryCommit(owner.signal);
        const joining = new AbortController();
        const second = provider.retryCommit(joining.signal).catch(error => error);
        const reason = new DOMException('Joining caller interrupted', 'AbortError');
        joining.abort(reason);
        expect(taskSignal.aborted).toBe(false);
        request.mockResolvedValueOnce({ ...status('completed'), totalBytes, uploadedBytes: totalBytes })
            .mockResolvedValueOnce(totalBytes === 3 ? preview : facts(totalBytes));
        finish({ url: 'not-a-receipt' });
        expect((await first).status).toBe('committed');
        expect(await second).toBe(reason);
        expect(removed).toHaveBeenCalledWith('abort', added.mock.calls[0][1]);
        expect(request).toHaveBeenCalledTimes(3);
        expect(request.mock.calls.some(([call]) => call.requestOptions.method === 'DELETE')).toBe(false);
    });
    it.each([3, 20_971_520])('preserves the original caller control of the shared %i-byte commit', async totalBytes => {
        let taskSignal!: AbortSignal;
        request.mockImplementationOnce(call => new Promise((_, reject) => {
            taskSignal = call.signal;
            taskSignal.addEventListener('abort', () => reject(taskSignal.reason), { once: true });
        }));
        const provider = createArticleAttachmentUploadProvider({ ...session, totalBytes });
        const owner = new AbortController();
        const joining = new AbortController();
        const first = provider.retryCommit(owner.signal).catch(error => error);
        const second = provider.retryCommit(joining.signal).catch(error => error);
        const reason = new DOMException('First caller interrupted', 'AbortError');
        owner.abort(reason);
        expect(taskSignal.aborted).toBe(true);
        expect(await first).toBe(reason);
        expect(await second).toBe(reason);
        expect(joining.signal.aborted).toBe(false);
        expect(request).toHaveBeenCalledOnce();
    });
    it('retains the original shared task after a joining caller abort until transport actually settles', async () => {
        let finish!: (value: unknown) => void;
        let taskSignal!: AbortSignal;
        request.mockImplementationOnce(call => new Promise(resolve => {
            taskSignal = call.signal;
            finish = resolve;
        }));
        const provider = createArticleAttachmentUploadProvider(session);
        const owner = new AbortController();
        const added = vi.spyOn(owner.signal, 'addEventListener');
        const removed = vi.spyOn(owner.signal, 'removeEventListener');
        const first = provider.retryCommit(owner.signal);
        const joining = new AbortController();
        let settled = false;
        const second = provider.retryCommit(joining.signal).catch(error => { settled = true; return error; });
        const reason = new DOMException('Delayed interruption', 'AbortError');
        joining.abort(reason);
        await Promise.resolve();
        await Promise.resolve();
        expect(taskSignal.aborted).toBe(false);
        expect(settled).toBe(false);
        expect(removed).not.toHaveBeenCalled();
        const third = provider.retryCommit();
        expect(request).toHaveBeenCalledOnce();
        request.mockResolvedValueOnce(status('completed')).mockResolvedValueOnce(preview);
        finish({ url: 'late-promotion-not-a-receipt' });
        expect((await first).status).toBe('committed');
        expect(await third).toEqual(await first);
        expect(await second).toBe(reason);
        expect(removed).toHaveBeenCalledWith('abort', added.mock.calls[0][1]);
        expect(request).toHaveBeenCalledTimes(3);
        request.mockResolvedValueOnce({ url: 'not-a-receipt' }).mockResolvedValueOnce(status('completed')).mockResolvedValueOnce(preview);
        expect((await provider.retryCommit()).status).toBe('committed');
        expect(request).toHaveBeenCalledTimes(6);
        expect(request.mock.calls.some(([call]) => call.requestOptions.method === 'DELETE')).toBe(false);
    });
    it('retains each cancelled caller reason when both signals abort the shared attempt', async () => {
        request.mockImplementationOnce(call => new Promise((_, reject) => {
            call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true });
        }));
        const provider = createArticleAttachmentUploadProvider({ ...session, totalBytes: 20_971_520 });
        const owner = new AbortController();
        const joining = new AbortController();
        const first = provider.retryCommit(owner.signal).catch(error => error);
        const second = provider.retryCommit(joining.signal).catch(error => error);
        const ownerReason = new DOMException('Original caller aborted', 'AbortError');
        const joiningReason = new DOMException('Joining caller aborted', 'AbortError');
        joining.abort(joiningReason);
        owner.abort(ownerReason);
        expect(await first).toBe(ownerReason);
        expect(await second).toBe(joiningReason);
        expect(request).toHaveBeenCalledOnce();
    });
    it('retains uncertainty and never aborts after a possibly committed failed RPC', async () => {
        request.mockRejectedValueOnce(new Error('secret original-secret-token'));
        const provider = createArticleAttachmentUploadProvider(session);
        expect(await provider.retryCommit()).toEqual({ status: 'recovery-required', reason: 'upload_commit_unknown' });
        request.mockResolvedValueOnce(status('uploaded'));
        expect(await provider.cancel()).toEqual({ status: 'recovery-required', reason: 'abort_missing_atomic_commit_outcome' });
        expect(request.mock.calls.some(([call]) => call.requestOptions.method === 'DELETE')).toBe(false);
    });
    it('requires a real abort acknowledgement and preserves failed abort obligations for retry', async () => {
        request.mockRejectedValueOnce(new Error('disconnect')).mockResolvedValueOnce({ uploadId: session.uploadId, status: 'aborted' });
        const provider = createArticleAttachmentUploadProvider(session);
        expect((await provider.cancel()).status).toBe('recovery-required');
        expect((await provider.cancel()).status).toBe('cancelled');
        expect((await provider.cancel()).status).toBe('cancelled');
        expect(request).toHaveBeenCalledTimes(2);
        expect(request.mock.calls[1][0]).toMatchObject({ requestOptions: { method: 'DELETE', headers: { 'X-Fsus-Upload-Token': session.uploadToken } } });
    });
    it('blocks commit after an uncertain abort rather than racing a deleted original session', async () => {
        let fail!: (reason: Error) => void;
        request.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
        const provider = createArticleAttachmentUploadProvider(session);
        const cancelling = provider.cancel();
        expect(await provider.retryCommit()).toEqual({ status: 'recovery-required', reason: 'upload_abort_unknown' });
        fail(new Error('disconnect'));
        expect((await cancelling).status).toBe('recovery-required');
        expect((await provider.retryCommit()).status).toBe('recovery-required');
        expect(request).toHaveBeenCalledOnce();
    });
    it('interrupts its actual commit task and observes late server promotion without deleting it', async () => {
        let commitSignal: AbortSignal | undefined;
        request.mockImplementationOnce((call) => new Promise((_, reject) => {
            commitSignal = call.signal;
            commitSignal!.addEventListener('abort', () => reject(commitSignal!.reason), { once: true });
        }));
        const provider = createArticleAttachmentUploadProvider(session);
        const committing = provider.retryCommit();
        request.mockResolvedValueOnce(status('completed')).mockResolvedValueOnce(preview);
        const cancelled = await provider.cancel();
        expect(commitSignal!.aborted).toBe(true);
        expect((await committing).status).toBe('recovery-required');
        expect(cancelled.status).toBe('committed');
        expect(request.mock.calls.some(([call]) => call.requestOptions.method === 'DELETE')).toBe(false);
    });
    it('never revives unknown/expired progress or URL-only commit evidence', async () => {
        request.mockRejectedValueOnce(new Error('not found'));
        const provider = createArticleAttachmentUploadProvider({ ...session, commitMayHaveStarted: true });
        expect((await provider.observe()).status).toBe('recovery-required');
        request.mockResolvedValueOnce(status('completed')).mockResolvedValueOnce({ ...preview, bytes: new Uint8Array([0]) });
        expect((await provider.observe()).status).toBe('recovery-required');
    });
    it.each([8_387_833, 20_971_520])('reads original facts without preview bytes for %i-byte committed uploads', async totalBytes => {
        request.mockResolvedValueOnce({ ...status('completed'), totalBytes, uploadedBytes: totalBytes })
            .mockResolvedValueOnce(facts(totalBytes));
        const result = await createArticleAttachmentUploadProvider({ ...session, totalBytes }).observe();
        expect(result).toMatchObject({ status: 'committed', asset: { assetId: preview.assetId, sha256: digest, sizeBytes: totalBytes } });
        expect(JSON.stringify(result)).not.toMatch(/original-secret-token|"bytes"|receipt/u);
        expect(request).toHaveBeenCalledTimes(2);
        const call = request.mock.calls[1][0];
        expect(call).toMatchObject({ binaryRoute: { operationId: 'binary_post_upload_uploadId_facts', params: { uploadId: session.uploadId } },
            privateScope: 'admin', frameType: FrameType.UploadAssetFacts,
            requestOptions: { method: 'POST', requiresPow: true, headers: { 'X-Fsus-Upload-Token': session.uploadToken } } });
        const frame = call.requestOptions.body as Uint8Array;
        expect(new TextDecoder().decode(frame.slice(-64))).toBe(digest);
        expect(request.mock.calls.some(([candidate]) => candidate.binaryRoute?.operationId === 'binary_post_upload_uploadId_preview')).toBe(false);
    });
    it('retains the preview route at the original exact budget', async () => {
        const totalBytes = 8_387_832;
        request.mockResolvedValueOnce({ ...status('completed'), totalBytes, uploadedBytes: totalBytes })
            .mockRejectedValueOnce(new Error('controlled preview refusal'));
        expect((await createArticleAttachmentUploadProvider({ ...session, totalBytes }).observe()).status).toBe('recovery-required');
        expect(request.mock.calls[1][0].binaryRoute.operationId).toBe('binary_post_upload_uploadId_preview');
    });
    it.each(['uploadId', 'sha256', 'sizeBytes'] as const)('refuses changed facts %s without promoting a receipt', async key => {
        const totalBytes = 20_971_520;
        request.mockResolvedValueOnce({ ...status('completed'), totalBytes, uploadedBytes: totalBytes })
            .mockResolvedValueOnce({ ...facts(totalBytes), [key]: key === 'sizeBytes' ? totalBytes - 1 : 'changed' });
        const result = await createArticleAttachmentUploadProvider({ ...session, totalBytes }).observe();
        expect(result).toEqual({ status: 'recovery-required', reason: key === 'sizeBytes' ? 'upload_asset_size_mismatch' : 'upload_observation_failed' });
    });
    it('preserves original owner-token refusal for large facts', async () => {
        const totalBytes = 20_971_520;
        request.mockResolvedValueOnce({ ...status('completed'), totalBytes, uploadedBytes: totalBytes })
            .mockRejectedValueOnce(new Error('controlled original authority refusal'));
        const result = await createArticleAttachmentUploadProvider({ ...session, totalBytes }).observe();
        expect(result).toEqual({ status: 'recovery-required', reason: 'upload_observation_failed' });
        expect(request.mock.calls[1][0].requestOptions.headers['X-Fsus-Upload-Token']).toBe(session.uploadToken);
        expect(request).toHaveBeenCalledTimes(2);
    });
    it('rejects changed session status before requesting large facts', async () => {
        const totalBytes = 20_971_520;
        request.mockResolvedValueOnce({ ...status('completed'), uploadId: 'other-upload', totalBytes, uploadedBytes: totalBytes });
        expect(await createArticleAttachmentUploadProvider({ ...session, totalBytes }).observe())
            .toEqual({ status: 'recovery-required', reason: 'upload_status_binding_invalid' });
        expect(request).toHaveBeenCalledOnce();
    });
    it('propagates cancellation while reading original large facts', async () => {
        const totalBytes = 20_971_520;
        const controller = new AbortController();
        let finish!: (value: unknown) => void;
        request.mockResolvedValueOnce({ ...status('completed'), totalBytes, uploadedBytes: totalBytes })
            .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const reading = createArticleAttachmentUploadProvider({ ...session, totalBytes }).observe(controller.signal);
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
        expect(request.mock.calls[1][0].signal).toBe(controller.signal);
        controller.abort(new DOMException('Owned facts interrupted', 'AbortError'));
        finish(facts(totalBytes));
        await expect(reading).rejects.toThrow('Owned facts interrupted');
    });
    it('coalesces large retry attempts and reads facts after the actual completion RPC', async () => {
        const totalBytes = 20_971_520;
        let finish!: (value: unknown) => void;
        request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const provider = createArticleAttachmentUploadProvider({ ...session, totalBytes });
        const first = provider.retryCommit();
        const second = provider.retryCommit();
        request.mockResolvedValueOnce({ ...status('completed'), totalBytes, uploadedBytes: totalBytes }).mockResolvedValueOnce(facts(totalBytes));
        finish({ url: 'not-a-receipt' });
        expect(await first).toEqual(await second);
        expect((await first).status).toBe('committed');
        expect(request).toHaveBeenCalledTimes(3);
        expect(request.mock.calls[2][0].binaryRoute.operationId).toBe('binary_post_upload_uploadId_facts');
    });
    it('preserves the original caller cancellation during a coalesced large facts read', async () => {
        const totalBytes = 20_971_520;
        let factsSignal!: AbortSignal;
        request.mockResolvedValueOnce({ url: 'not-a-receipt' })
            .mockResolvedValueOnce({ ...status('completed'), totalBytes, uploadedBytes: totalBytes })
            .mockImplementationOnce(call => new Promise((_, reject) => {
                factsSignal = call.signal;
                factsSignal.addEventListener('abort', () => reject(factsSignal.reason), { once: true });
            }));
        const provider = createArticleAttachmentUploadProvider({ ...session, totalBytes });
        const owner = new AbortController();
        const first = provider.retryCommit(owner.signal).catch(error => error);
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
        const second = provider.retryCommit().catch(error => error);
        const reason = new DOMException('Original facts read interrupted', 'AbortError');
        owner.abort(reason);
        expect(factsSignal.aborted).toBe(true);
        expect(await second).toBe(reason);
        expect(await first).toBe(reason);
        expect(request.mock.calls[2][0].binaryRoute.operationId).toBe('binary_post_upload_uploadId_facts');
        expect(request).toHaveBeenCalledTimes(3);
        expect(request.mock.calls.some(([call]) => call.requestOptions.method === 'DELETE')).toBe(false);
    });
    it('observes a late large commit on cancel without deleting original bytes', async () => {
        const totalBytes = 20_971_520;
        let commitSignal: AbortSignal | undefined;
        request.mockImplementationOnce(call => new Promise((_, reject) => {
            commitSignal = call.signal;
            commitSignal!.addEventListener('abort', () => reject(commitSignal!.reason), { once: true });
        }));
        const provider = createArticleAttachmentUploadProvider({ ...session, totalBytes });
        const committing = provider.retryCommit();
        request.mockResolvedValueOnce({ ...status('completed'), totalBytes, uploadedBytes: totalBytes }).mockResolvedValueOnce(facts(totalBytes));
        const cancelled = await provider.cancel();
        expect(commitSignal!.aborted).toBe(true);
        expect((await committing).status).toBe('recovery-required');
        expect(cancelled.status).toBe('committed');
        expect(request.mock.calls[2][0].binaryRoute.operationId).toBe('binary_post_upload_uploadId_facts');
        expect(request.mock.calls.some(([call]) => call.requestOptions.method === 'DELETE')).toBe(false);
    });
    it('does not send an interrupted operation or acknowledge interrupted abort', async () => {
        const controller = new AbortController();
        controller.abort();
        const provider = createArticleAttachmentUploadProvider(session);
        await expect(provider.retryCommit(controller.signal)).rejects.toThrow();
        await expect(provider.cancel(controller.signal)).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
    });
});
