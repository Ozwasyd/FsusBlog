import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameType } from '@wasm/protocol/frame';
import { readVaultRecoveryHistory, type VaultRecoveryHistoryRequest } from '@/api/articleVault';
import { requestBinaryOnly } from '@/composition/binaryTransport';
import { decodeAedsFrame } from '../../support/aeds-envelope.mjs';

vi.mock('@/composition/binaryTransport', () => ({ requestBinaryOnly: vi.fn() }));
const binaryMock = vi.mocked(requestBinaryOnly);
const digest = 'a'.repeat(64);
const request: VaultRecoveryHistoryRequest = {
    schema: 'fsusblog.article-vault.recovery-history-request.v1',
    articleId: 17,
    resolutionOperationIdentity: `resolution-${digest}`,
    proposalSha256: digest,
    operation: {
        schema: 'fsusblog.article-vault.operation-identity.v1', schemaVersion: 1,
        siteIdentity: 'site-a', vaultIdentity: 'vault-a', deviceIdentity: 'device-a',
        agentIdentity: 'agent-a', planReference: 'plan-a', planSha256: digest,
        operationIdentity: 'operation-a', requestSha256: digest, idempotencySha256: digest,
        deadlineUnixMs: 1700000000000, contentSha256: digest
    },
    sequence: 3,
    checkpointSha256: digest
};

describe('Vault historical private authoring transport', () => {
    beforeEach(() => vi.clearAllMocks());

    it('uses the actual authoring envelope with exact references and cookie/private scope', async () => {
        const response = { isHistorical: true, canExecute: false, canCommitBase: false };
        const controller = new AbortController();
        binaryMock.mockResolvedValue(response);
        await expect(readVaultRecoveryHistory(request, { signal: controller.signal })).resolves.toBe(response);
        const options = binaryMock.mock.calls[0]![0];
        expect(options).toMatchObject({
            binaryUrl: '/api/binary/author/vault/recovery/history', privateScope: 'admin',
            frameType: FrameType.ArticleVaultRecoveryHistoryResponse, signal: controller.signal,
            requestOptions: { method: 'POST', credentials: 'include' }
        });
        const frame = decodeAedsFrame(options.requestOptions!.body as ArrayBuffer);
        expect(frame.frameType).toBe(FrameType.ArticleVaultRecoveryHistoryRequest);
        expect(JSON.parse(new TextDecoder().decode(frame.payload))).toEqual(request);
        expect(options.requestOptions!.body).toBeInstanceOf(ArrayBuffer);
    });

    it('propagates permission/transport rejection without a second request', async () => {
        const rejected = new Error('article_vault_recovery_history_not_authorized');
        binaryMock.mockRejectedValue(rejected);
        await expect(readVaultRecoveryHistory(request)).rejects.toBe(rejected);
        expect(binaryMock).toHaveBeenCalledTimes(1);
    });

    it('passes an interrupted caller signal through the same private runtime', async () => {
        const controller = new AbortController();
        controller.abort();
        const aborted = new DOMException('interrupted', 'AbortError');
        binaryMock.mockRejectedValue(aborted);
        await expect(readVaultRecoveryHistory(request, { signal: controller.signal })).rejects.toBe(aborted);
        expect(binaryMock.mock.calls[0]![0].signal?.aborted).toBe(true);
        expect(binaryMock).toHaveBeenCalledTimes(1);
    });
});
