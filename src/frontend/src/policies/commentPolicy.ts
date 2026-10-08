import {
    CommentPolicyReadiness,
    zkProdServerUnavailableReasons,
    type DecodedCommentPolicySnapshot,
    type CommentPolicySnapshot,
    type ZkProdUnavailableReason
} from '@/contracts/commentPolicy';
import { COMMENT_POLICY_WIRE } from '@/generated/commentPolicyWire';

const policyHashPattern = /^[0-9a-f]{64}$/;
const serverReasonSet = new Set<string>(zkProdServerUnavailableReasons);

/** Normalizes a complete decoded policy and maps every invalid combination fail closed. */
export function finalizeCommentPolicySnapshot(
    snapshot: DecodedCommentPolicySnapshot
): CommentPolicySnapshot
{
    if (!isDecodedSnapshotShapeValid(snapshot))
    {
        return createContractInvalidCommentPolicySnapshot();
    }

    const normalizedReason = snapshot.zkProdUnavailableReason.trim().toLowerCase().replaceAll('-', '_');
    if (!serverReasonSet.has(normalizedReason))
    {
        return {
            ...snapshot,
            zkProdUnavailableReason: 'contract_invalid',
            zkProdReadiness: CommentPolicyReadiness.ContractInvalid
        };
    }

    const reason = normalizedReason as ZkProdUnavailableReason;
    const readiness = resolveCurrentReadiness(snapshot, reason);
    return {
        ...snapshot,
        zkProdUnavailableReason: readiness === CommentPolicyReadiness.ContractInvalid
            ? 'contract_invalid'
            : readiness === CommentPolicyReadiness.PolicyUnavailable && reason === ''
        ? 'policy_unavailable'
        : reason,
        zkProdReadiness: readiness
    };
}

function isDecodedSnapshotShapeValid(snapshot: DecodedCommentPolicySnapshot): boolean
{
    return typeof snapshot === 'object' &&
    snapshot !== null &&
    typeof snapshot.anonymousCommentsEnabled === 'boolean' &&
    typeof snapshot.publicCommentsEnabled === 'boolean' &&
    typeof snapshot.zkAnonymousEnabled === 'boolean' &&
    (snapshot.defaultAuthorMode === 'public' || snapshot.defaultAuthorMode === 'zk_anonymous') &&
    typeof snapshot.zkProdEnabled === 'boolean' &&
    typeof snapshot.zkProdNativeVerifierConfigured === 'boolean' &&
    typeof snapshot.zkProdTrustedSetupVerified === 'boolean' &&
    typeof snapshot.zkProdCredentialRequired === 'boolean' &&
    typeof snapshot.zkProdCredentialRootReady === 'boolean' &&
    Number.isInteger(snapshot.commentMaxChars) &&
    snapshot.commentMaxChars >= COMMENT_POLICY_WIRE.minMaxChars &&
    snapshot.commentMaxChars <= COMMENT_POLICY_WIRE.hardMaxChars &&
    Number.isInteger(snapshot.commentMaxUtf8Bytes) &&
    snapshot.commentMaxUtf8Bytes >= COMMENT_POLICY_WIRE.minMaxUtf8Bytes &&
    snapshot.commentMaxUtf8Bytes <= COMMENT_POLICY_WIRE.hardMaxUtf8Bytes &&
    Array.isArray(snapshot.supportedDisplayLanguages) &&
    snapshot.supportedDisplayLanguages.every((language) => typeof language === 'string') &&
    typeof snapshot.snapshotHash === 'string' &&
    typeof snapshot.zkProdUnavailableReason === 'string';
}

function createContractInvalidCommentPolicySnapshot(): CommentPolicySnapshot
{
    return {
        anonymousCommentsEnabled: false,
        publicCommentsEnabled: false,
        zkAnonymousEnabled: false,
        defaultAuthorMode: 'public',
        zkProdEnabled: false,
        zkProdNativeVerifierConfigured: false,
        zkProdTrustedSetupVerified: false,
        zkProdCredentialRequired: true,
        zkProdCredentialRootReady: false,
        commentMaxChars: 0,
        commentMaxUtf8Bytes: 0,
        supportedDisplayLanguages: [],
        snapshotHash: '',
        zkProdUnavailableReason: 'contract_invalid',
        zkProdReadiness: CommentPolicyReadiness.ContractInvalid
    };
}

/** Returns true only when the full server-authoritative strong-anonymous gate is ready. */
export function isStrongAnonymousCommentAvailable(policy: CommentPolicySnapshot): boolean
{
    return policy.anonymousCommentsEnabled &&
    policy.zkAnonymousEnabled &&
    policy.zkProdReadiness === CommentPolicyReadiness.Ready;
}

function resolveCurrentReadiness(
    snapshot: DecodedCommentPolicySnapshot,
    reason: ZkProdUnavailableReason
): CommentPolicyReadiness
{
    if (!policyHashPattern.test(snapshot.snapshotHash.trim().toLowerCase()))
    {
        return CommentPolicyReadiness.ContractInvalid;
    }

    if (!snapshot.zkProdEnabled)
    {
        return reason === 'disabled'
            ? CommentPolicyReadiness.Disabled
            : CommentPolicyReadiness.ContractInvalid;
    }

    if (reason === 'native_backend_required')
    {
        return CommentPolicyReadiness.VerifierMissing;
    }

    if (!snapshot.zkProdNativeVerifierConfigured)
    {
        return reason === 'native_verifier_unavailable'
            ? CommentPolicyReadiness.VerifierMissing
            : CommentPolicyReadiness.ContractInvalid;
    }

    if (!snapshot.zkProdTrustedSetupVerified)
    {
        return reason === 'trusted_setup_unverified'
            ? CommentPolicyReadiness.TrustedSetupUnverified
            : CommentPolicyReadiness.ContractInvalid;
    }

    if (!snapshot.zkProdCredentialRequired)
    {
        return CommentPolicyReadiness.PolicyUnavailable;
    }

    if (reason === 'credential_issuer_unavailable')
    {
        return CommentPolicyReadiness.CredentialRootMissing;
    }

    if (!snapshot.zkProdCredentialRootReady)
    {
        return reason === 'credential_root_unavailable'
            ? CommentPolicyReadiness.CredentialRootMissing
            : CommentPolicyReadiness.ContractInvalid;
    }

    if (reason === '')
    {
        return CommentPolicyReadiness.Ready;
    }

    return CommentPolicyReadiness.ContractInvalid;
}
