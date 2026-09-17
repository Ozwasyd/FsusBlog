import { describe, expect, it } from 'vitest'

import {
    CommentPolicyContractVersion,
    CommentPolicyReadiness,
    type DecodedCommentPolicySnapshot
} from '@/contracts/commentPolicy'
import {
    finalizeCommentPolicySnapshot,
    isStrongAnonymousCommentAvailable
} from '@/policies/commentPolicy'

const readySnapshot: DecodedCommentPolicySnapshot = {
    contractVersion: CommentPolicyContractVersion.Current,
    anonymousCommentsEnabled: true,
    publicCommentsEnabled: true,
    zkAnonymousEnabled: true,
    defaultAuthorMode: 'zk_anonymous',
    zkProdEnabled: true,
    zkProdNativeVerifierConfigured: true,
    zkProdTrustedSetupVerified: true,
    zkProdCredentialRequired: true,
    zkProdCredentialRootReady: true,
    commentMaxChars: 1000,
    commentMaxUtf8Bytes: 4096,
    supportedDisplayLanguages: ['zh-CN', 'en'],
    snapshotHash: '9'.repeat(64),
    zkProdUnavailableReason: ''
}

describe('comment policy readiness contract', () => {
    it('allows strong anonymous submission only for the complete current ready state', () => {
        const policy = finalizeCommentPolicySnapshot(readySnapshot)

        expect(policy.zkProdReadiness).toBe(CommentPolicyReadiness.Ready)
        expect(isStrongAnonymousCommentAvailable(policy)).toBe(true)
    })

    it.each([
        [{ zkProdEnabled: false, zkProdUnavailableReason: 'disabled' }, CommentPolicyReadiness.Disabled],
        [{ zkProdNativeVerifierConfigured: false, zkProdUnavailableReason: 'native_verifier_unavailable' }, CommentPolicyReadiness.VerifierMissing],
        [{ zkProdUnavailableReason: 'native_backend_required' }, CommentPolicyReadiness.VerifierMissing],
        [{ zkProdTrustedSetupVerified: false, zkProdUnavailableReason: 'trusted_setup_unverified' }, CommentPolicyReadiness.TrustedSetupUnverified],
        [{ zkProdCredentialRootReady: false, zkProdUnavailableReason: 'credential_root_unavailable' }, CommentPolicyReadiness.CredentialRootMissing],
        [{ zkProdUnavailableReason: 'credential_unready' }, CommentPolicyReadiness.CredentialRootMissing],
        [{ zkProdUnavailableReason: 'credential_issuer_unavailable' }, CommentPolicyReadiness.CredentialRootMissing],
        [{ zkProdCredentialRequired: false, zkProdUnavailableReason: '' }, CommentPolicyReadiness.PolicyUnavailable],
        [{ zkProdUnavailableReason: 'dev_verifier_disallowed' }, CommentPolicyReadiness.PolicyUnavailable]
    ] as const)('fails closed for a non-ready production state (%j -> %s)', (changes, expected) => {
        const policy = finalizeCommentPolicySnapshot({ ...readySnapshot, ...changes })

        expect(policy.zkProdReadiness).toBe(expected)
        expect(isStrongAnonymousCommentAvailable(policy)).toBe(false)
    })

    it.each([
        { zkProdUnavailableReason: 'future_unknown_reason' },
        { zkProdEnabled: 'true' },
        { snapshotHash: '' },
        { supportedDisplayLanguages: 'zh-CN' }
    ])('maps unknown, missing, or type-damaged readiness to contract_invalid (%j)', (changes) => {
        const policy = finalizeCommentPolicySnapshot({
            ...readySnapshot,
            ...changes
        } as DecodedCommentPolicySnapshot)

        expect(policy.zkProdReadiness).toBe(CommentPolicyReadiness.ContractInvalid)
        expect(policy.zkProdUnavailableReason).toBe('contract_invalid')
        expect(isStrongAnonymousCommentAvailable(policy)).toBe(false)
    })

    it('maps an old frame version to unavailable even when its legacy flags look ready', () => {
        const policy = finalizeCommentPolicySnapshot({
            ...readySnapshot,
            contractVersion: CommentPolicyContractVersion.LegacyPadded
        })

        expect(policy.zkProdReadiness).toBe(CommentPolicyReadiness.ContractInvalid)
        expect(isStrongAnonymousCommentAvailable(policy)).toBe(false)
    })
})
