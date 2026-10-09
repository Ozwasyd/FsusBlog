import { beforeEach, describe, expect, it, vi } from 'vitest';
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/composition/binaryTransport', () => ({ requestBinaryOnly: request }));
import { createArticleAttachmentUploadProvider } from '@/services/authoring/articleAttachmentUploadProvider';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const bytes = new Uint8Array([1, 2, 3]);
const digest = bytesToHex(sha256(bytes));
const session = { uploadId: '0123456789abcdef0123456789abcdef', uploadToken: 'original-secret-token', sha256: digest, totalBytes: 3, commitMayHaveStarted: false };
const status = (state: string) => ({ uploadId: session.uploadId, status: state, totalBytes: 3, uploadedBytes: state === 'pending' ? 1 : 3 });
const preview = { schema: 'fsusblog.upload-asset-preview.v1', uploadId: session.uploadId, assetId: '01234567-89ab-cdef-0123-456789abcdef',
    publicUrl: '/uploads/illustration/0123456789abcdef0123456789abcdef.png', sha256: digest,
    assetVersionSha256: 'a'.repeat(64), referenceLedgerSha256: 'b'.repeat(64), sizeBytes: 3, bytes };

describe('original upload business provider operations', () => {
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
    it('reports the exact facts-only transport gap for larger original committed uploads', async () => {
        request.mockResolvedValueOnce({ ...status('completed'), totalBytes: 20_971_520, uploadedBytes: 20_971_520 });
        expect(await createArticleAttachmentUploadProvider({ ...session, totalBytes: 20_971_520 }).observe())
            .toEqual({ status: 'recovery-required', reason: 'upload_facts_only_transport_missing' });
        expect(request).toHaveBeenCalledOnce();
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
