import {
    getAnonymousCredentialCircuitSnapshot,
    getAnonymousCredentialRootSnapshot,
    getCommentPolicySnapshot,
    issueAnonymousCommentTicket
} from '@/api/comment';
import { isStrongAnonymousCommentAvailable } from '@/policies/commentPolicy';

import { parseAnonymousCommentScope } from './commentAnonymousScope';
import { zeroizeCommentPrivacyBytes } from './commentPrivacyCredentialLifecycle';
import {
    createCommentPrivacyCredentialProvider
} from './commentPrivacyCredentialProvider';

import type {
    CommentPrivacyCredentialMaterial,
    CommentPrivacyCredentialProvider
} from './commentPrivacyContracts';
import type {
    CommentPrivacyAdapter,
    CommentPrivacyCredentialResult,
    CommentPrivacyMetadata,
    CommentPrivacyMetadataResult,
    CommentPrivacyTicketResult
} from './commentPrivacyTypes';

const DEFAULT_CREDENTIAL_LEVEL = 'strong_anonymous';
const DEFAULT_REPUTATION_BUCKET = 'unrated';

export interface CommentPrivacyAdapterOptions {
    credentialProvider?: CommentPrivacyCredentialProvider;
}

export function createCommentPrivacyAdapter(options: CommentPrivacyAdapterOptions = {}): CommentPrivacyAdapter
{
    const credentialProvider = options.credentialProvider ?? createCommentPrivacyCredentialProvider();
    let credentialMaterial: CommentPrivacyCredentialMaterial | null = null;

    return {
        async ensureCredentialPrepared({ signal }): Promise<CommentPrivacyCredentialResult>
        {
            const credential = await credentialProvider.prepareCredential({ signal });
            if (!credential || signal.aborted)
            {
                zeroizeCredentialMaterial(credentialMaterial);
                credentialMaterial = null;
                return { ok: false, reason: 'comment_privacy_credential_unavailable' };
            }

            zeroizeCredentialMaterial(credentialMaterial);
            credentialMaterial = cloneCredentialMaterial(credential);
            zeroizeCredentialMaterial(credential);
            return { ok: true, credential: cloneCredentialMaterial(credentialMaterial) };
        },
        async loadPrivacyMetadata({ scope, signal }): Promise<CommentPrivacyMetadataResult>
        {
            try
            {
                const [root, circuit, policy] = await Promise.all([
                    getAnonymousCredentialRootSnapshot({ signal, credentials: 'omit' }),
                    getAnonymousCredentialCircuitSnapshot({ signal, credentials: 'omit' }),
                    getCommentPolicySnapshot({ signal, credentials: 'omit' })
                ]);

                if (signal.aborted)
                {
                    return { ok: false, reason: 'comment_privacy_metadata_aborted' };
                }

                if (!isStrongAnonymousCommentAvailable(policy) ||
          !root.zkAnonymousEnabled ||
          !root.verifierConfigured ||
          root.rootExpiresAtUnixMs <= Date.now())
                {
                    return { ok: false, reason: 'comment_privacy_metadata_unavailable' };
                }

                return {
                    ok: true,
                    metadata: toPrivacyMetadata(scope, root, circuit, policy)
                };
            }
            catch
            {
                return { ok: false, reason: 'comment_privacy_metadata_unavailable' };
            }
        },
        async issueAnonymousTicket({ scope, metadata, proof, signal }): Promise<CommentPrivacyTicketResult>
        {
            const parsedScope = parseAnonymousCommentScope(scope);
            if (!parsedScope || !hasTicketMetadata(metadata))
            {
                return { ok: false, reason: 'comment_privacy_ticket_metadata_invalid' };
            }

            try
            {
                const ticket = await issueAnonymousCommentTicket({
                    articleId: parsedScope.articleId,
                    rootId: parsedScope.rootId,
                    circuitNumericId: metadata.circuitNumericId,
                    publicInputLayoutVersion: metadata.publicInputLayoutVersion,
                    actionContext: 'comment.create',
                    anonymousScope: scope,
                    circuitId: metadata.circuitId,
                    verifyingKeyHash: metadata.verifyingKeyHash,
                    nullifierHash: proof.nullifierHash,
                    credentialRoot: metadata.credentialRoot,
                    revocationRoot: metadata.revocationRoot,
                    isEligible: true,
                    mayComment: true,
                    rateClass: 'common',
                    requiresModeration: false,
                    zkProof: proof.proofBytes,
                    publicInputs: proof.publicInputs
                }, { signal, credentials: 'omit' });

                return {
                    ok: true,
                    ticket: {
                        scope,
                        ticket: ticket.ticket,
                        expiresAtUnixMs: ticket.ticketExpiresAtUnixMs,
                        rateClass: ticket.rateClass,
                        requiresModeration: ticket.requiresModeration
                    }
                };
            }
            catch
            {
                return { ok: false, reason: 'comment_privacy_ticket_unavailable' };
            }
        },
        async purgeCredential()
        {
            zeroizeCredentialMaterial(credentialMaterial);
            credentialMaterial = null;
        }
    };
}

function toPrivacyMetadata(
    scope: string,
    root: {
        credentialEpoch: number;
        rootExpiresAtUnixMs: number;
        circuitNumericId: number;
        publicInputLayoutVersion: number;
        circuitId: string;
        verifyingKeyHash: string;
        issuerPublicKeyHash: string;
        credentialRoot: Uint8Array;
        revocationRoot: Uint8Array;
        circuitMetadata: Uint8Array;
    },
    circuit: {
        circuitMetadata: Uint8Array;
    },
    policy: {
        snapshotHash: string;
    }
): CommentPrivacyMetadata
{
    const circuitMetadata = circuit.circuitMetadata.byteLength > 0 ? circuit.circuitMetadata : root.circuitMetadata;
    const policyHash = policy.snapshotHash.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(policyHash))
    {
        throw new Error('comment_privacy_policy_hash_invalid');
    }

    return {
        scope,
        rootVersion: `${root.credentialEpoch}:${root.verifyingKeyHash}`,
        metadataBytes: new Uint8Array(circuitMetadata),
        credentialEpoch: root.credentialEpoch,
        circuitNumericId: root.circuitNumericId,
        publicInputLayoutVersion: root.publicInputLayoutVersion,
        circuitId: root.circuitId,
        verifyingKeyHash: root.verifyingKeyHash,
        issuerPublicKeyHash: root.issuerPublicKeyHash,
        policyHash,
        credentialRoot: new Uint8Array(root.credentialRoot),
        revocationRoot: new Uint8Array(root.revocationRoot),
        circuitMetadata: new Uint8Array(circuitMetadata),
        credentialLevel: DEFAULT_CREDENTIAL_LEVEL,
        reputationBucket: DEFAULT_REPUTATION_BUCKET
    };
}

function hasTicketMetadata(metadata: CommentPrivacyMetadata): metadata is CommentPrivacyMetadata & {
    credentialEpoch: number;
    circuitNumericId: number;
    publicInputLayoutVersion: number;
    circuitId: string;
    verifyingKeyHash: string;
    policyHash: string;
    credentialRoot: Uint8Array;
    revocationRoot: Uint8Array;
    credentialLevel: string;
    reputationBucket: string;
}
{
    return Number.isFinite(metadata.credentialEpoch) &&
    Number.isFinite(metadata.circuitNumericId) &&
    Number.isFinite(metadata.publicInputLayoutVersion) &&
    Boolean(metadata.circuitId) &&
    Boolean(metadata.verifyingKeyHash) &&
    Boolean(metadata.policyHash) &&
    metadata.credentialRoot instanceof Uint8Array &&
    metadata.credentialRoot.byteLength > 0 &&
    metadata.revocationRoot instanceof Uint8Array &&
    metadata.revocationRoot.byteLength > 0 &&
    Boolean(metadata.credentialLevel) &&
    Boolean(metadata.reputationBucket);
}

function cloneCredentialMaterial(material: CommentPrivacyCredentialMaterial): CommentPrivacyCredentialMaterial
{
    return {
        credentialSecret: new Uint8Array(material.credentialSecret),
        credentialCommitment: new Uint8Array(material.credentialCommitment),
        issuerSignature: new Uint8Array(material.issuerSignature),
        revocationWitness: new Uint8Array(material.revocationWitness),
        revocationHandleHash: material.revocationHandleHash ? new Uint8Array(material.revocationHandleHash) : undefined,
        credentialLevel: material.credentialLevel,
        reputationBucket: material.reputationBucket
    };
}

function zeroizeCredentialMaterial(material: CommentPrivacyCredentialMaterial | null): void
{
    if (!material)
    {
        return;
    }
    zeroizeCommentPrivacyBytes(material.credentialSecret);
    zeroizeCommentPrivacyBytes(material.credentialCommitment);
    zeroizeCommentPrivacyBytes(material.issuerSignature);
    zeroizeCommentPrivacyBytes(material.revocationWitness);
    zeroizeCommentPrivacyBytes(material.revocationHandleHash);
}
