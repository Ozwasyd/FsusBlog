import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
    CommentPolicyContractVersion,
    CommentPolicyReadiness,
    commentPolicyWireFields,
    zkProdServerUnavailableReasons,
    type DecodedCommentPolicySnapshot
} from '@/contracts/commentPolicy'
import {
    finalizeCommentPolicySnapshot,
    isStrongAnonymousCommentAvailable
} from '@/policies/commentPolicy'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))

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
    ] as const)('fails closed for a non-ready production state', (changes, expected) => {
        const policy = finalizeCommentPolicySnapshot({ ...readySnapshot, ...changes })

        expect(policy.zkProdReadiness).toBe(expected)
        expect(isStrongAnonymousCommentAvailable(policy)).toBe(false)
    })

    it.each([
        { zkProdUnavailableReason: 'future_unknown_reason' },
        { zkProdEnabled: 'true' },
        { snapshotHash: '' },
        { supportedDisplayLanguages: 'zh-CN' }
    ])('maps unknown, missing, or type-damaged readiness to contract_invalid', (changes) => {
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

describe('comment policy cross-stack field alignment', () => {
    it('keeps the backend POD and frontend wire field sets identical', () => {
        const source = readFileSync(
            repoFile('src/shared/Contracts/Models/CommentPods.cs'),
            'utf8'
        )
        const structBody = source.match(
            /public readonly struct CommentPolicySnapshotPod\s*\{(?<body>[\s\S]*?)\n\}/u
        )?.groups?.body
        expect(structBody).toBeDefined()

        const backendFields = [...(structBody ?? '').matchAll(/public readonly \w+ (?<name>\w+);/gu)]
            .map((match) => match.groups?.name ?? '')
            .map((name) => `${name[0].toLowerCase()}${name.slice(1)}`)

        expect(backendFields).toEqual(commentPolicyWireFields)
    })

    it('keeps backend unavailable reason codes in the frontend controlled enum', () => {
        const source = readFileSync(
            repoFile('src/backend/Services/Security/ZkProdOptions.cs'),
            'utf8'
        )
        const method = source.slice(source.indexOf('private static string ResolveUnavailableReason'))
        const backendReasons = [...method.matchAll(/return "(?<reason>[a-z0-9_]+)";/gu)]
            .map((match) => match.groups?.reason ?? '')

        expect(['', ...backendReasons]).toEqual(zkProdServerUnavailableReasons)
    })

    it('forbids local optional readiness casts and missing-field allow defaults', () => {
        const source = readFileSync(
            repoFile('src/frontend/src/composables/useArticleDetailView.ts'),
            'utf8'
        )

        expect(source).not.toMatch(/ZkProdCommentPolicySnapshot/u)
        expect(source).not.toMatch(/zkProd\w+\s*===\s*undefined/u)
        expect(source).not.toMatch(/as\s+ZkProd/u)
    })
})
