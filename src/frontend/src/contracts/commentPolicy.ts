import { commentPolicyWireFields } from '@/generated/commentPolicyWire';
export { commentPolicyWireFields };

/** Exact low-cardinality reason codes emitted by the backend ZK production policy factory. */
export const zkProdServerUnavailableReasons = [
    '',
    'disabled',
    'native_backend_required',
    'native_verifier_unavailable',
    'trusted_setup_unverified',
    'credential_issuer_unavailable',
    'credential_root_unavailable'
] as const;

/** Controlled server reason codes plus frontend-only fail-closed classifications. */
export const zkProdUnavailableReasons = [
    ...zkProdServerUnavailableReasons,
    'policy_unavailable',
    'contract_invalid'
] as const;

export type ZkProdUnavailableReason = typeof zkProdUnavailableReasons[number];

/** Low-cardinality production readiness state used by comment entry points. */
export const CommentPolicyReadiness = {
    Ready: 'ready',
    Disabled: 'disabled',
    VerifierMissing: 'verifier_missing',
    TrustedSetupUnverified: 'trusted_setup_unverified',
    CredentialRootMissing: 'credential_root_missing',
    PolicyUnavailable: 'policy_unavailable',
    ContractInvalid: 'contract_invalid'
} as const;

export type CommentPolicyReadiness =
  typeof CommentPolicyReadiness[keyof typeof CommentPolicyReadiness];

/** Complete public comment policy returned by the binary decoder and API wrapper. */
export interface CommentPolicySnapshot {
    anonymousCommentsEnabled: boolean;
    publicCommentsEnabled: boolean;
    zkAnonymousEnabled: boolean;
    defaultAuthorMode: 'public' | 'zk_anonymous';
    zkProdEnabled: boolean;
    zkProdNativeVerifierConfigured: boolean;
    zkProdTrustedSetupVerified: boolean;
    zkProdCredentialRequired: boolean;
    zkProdCredentialRootReady: boolean;
    commentMaxChars: number;
    commentMaxUtf8Bytes: number;
    supportedDisplayLanguages: string[];
    snapshotHash: string;
    zkProdUnavailableReason: ZkProdUnavailableReason;
    zkProdReadiness: CommentPolicyReadiness;
}

/** Complete raw decoder shape before controlled reason/readiness normalization. */
export type DecodedCommentPolicySnapshot = Omit<
    CommentPolicySnapshot,
  'zkProdReadiness' | 'zkProdUnavailableReason'
> & {
    zkProdUnavailableReason: string;
};

type CommentPolicyWireField = keyof DecodedCommentPolicySnapshot;
type MissingCommentPolicyWireField = Exclude<CommentPolicyWireField, typeof commentPolicyWireFields[number]>;

const commentPolicyWireFieldsAreExhaustive: MissingCommentPolicyWireField extends never ? true : never = true;
void commentPolicyWireFieldsAreExhaustive;
