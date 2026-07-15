import {
  getAnonymousCredentialCircuitSnapshot,
  getAnonymousCredentialRootSnapshot,
  getCommentPolicySnapshot,
  issueAnonymousCommentTicket
} from '@/api/comment'
import {
  createCommentPrivacyCredentialProvider,
  type CommentPrivacyCredentialProvider
} from './commentPrivacyCredentialProvider'
import type {
  CommentPrivacyAdapter,
  CommentPrivacyCredentialMaterial,
  CommentPrivacyCredentialResult,
  CommentPrivacyMetadata,
  CommentPrivacyMetadataResult,
  CommentPrivacyTicketResult
} from './commentPrivacyTypes'

const DEFAULT_CREDENTIAL_LEVEL = 'strong_anonymous'
const DEFAULT_REPUTATION_BUCKET = 'unrated'

export interface CommentPrivacyAdapterOptions {
  credentialProvider?: CommentPrivacyCredentialProvider
}

export function createCommentPrivacyAdapter(options: CommentPrivacyAdapterOptions = {}): CommentPrivacyAdapter {
  const credentialProvider = options.credentialProvider ?? createCommentPrivacyCredentialProvider()
  let credentialMaterial: CommentPrivacyCredentialMaterial | null = null

  return {
    async ensureCredentialPrepared({ signal }): Promise<CommentPrivacyCredentialResult> {
      if (credentialMaterial) {
        return { ok: true, credential: cloneCredentialMaterial(credentialMaterial) }
      }

      const credential = await credentialProvider.prepareCredential({ signal })
      if (!credential || signal.aborted) {
        return { ok: false, reason: 'comment_privacy_credential_unavailable' }
      }

      credentialMaterial = cloneCredentialMaterial(credential)
      return { ok: true, credential: cloneCredentialMaterial(credentialMaterial) }
    },
    async loadPrivacyMetadata({ scope, signal }): Promise<CommentPrivacyMetadataResult> {
      try {
        const [root, circuit, policy] = await Promise.all([
          getAnonymousCredentialRootSnapshot({ signal, credentials: 'omit' }),
          getAnonymousCredentialCircuitSnapshot({ signal, credentials: 'omit' }),
          getCommentPolicySnapshot({ signal, credentials: 'omit' })
        ])

        if (signal.aborted) {
          return { ok: false, reason: 'comment_privacy_metadata_aborted' }
        }

        if (!root.zkAnonymousEnabled || !root.verifierConfigured || root.rootExpiresAtUnixMs <= Date.now()) {
          return { ok: false, reason: 'comment_privacy_metadata_unavailable' }
        }

        return {
          ok: true,
          metadata: toPrivacyMetadata(scope, root, circuit, policy)
        }
      } catch {
        return { ok: false, reason: 'comment_privacy_metadata_unavailable' }
      }
    },
    async issueAnonymousTicket({ scope, metadata, proof, signal }): Promise<CommentPrivacyTicketResult> {
      const articleId = parseArticleIdFromScope(scope)
      if (articleId === null || !hasTicketMetadata(metadata)) {
        return { ok: false, reason: 'comment_privacy_ticket_metadata_invalid' }
      }

      try {
        const ticket = await issueAnonymousCommentTicket({
          articleId,
          credentialEpoch: metadata.credentialEpoch,
          circuitNumericId: metadata.circuitNumericId,
          publicInputLayoutVersion: metadata.publicInputLayoutVersion,
          actionContext: 'comment.create',
          anonymousScope: scope,
          circuitId: metadata.circuitId,
          verifyingKeyHash: metadata.verifyingKeyHash,
          nullifierHash: proof.nullifierHash,
          credentialRoot: metadata.credentialRoot,
          revocationRoot: metadata.revocationRoot,
          credentialLevel: metadata.credentialLevel,
          reputationBucket: metadata.reputationBucket,
          zkProof: proof.proofBytes,
          publicInputs: proof.publicInputs
        }, { signal, credentials: 'omit' })

        return {
          ok: true,
          ticket: {
            scope,
            credentialEpoch: ticket.credentialEpoch,
            ticket: ticket.ticket,
            expiresAtUnixMs: ticket.ticketExpiresAtUnixMs,
            credentialLevel: ticket.credentialLevel
          }
        }
      } catch {
        return { ok: false, reason: 'comment_privacy_ticket_unavailable' }
      }
    }
  }
}

function toPrivacyMetadata(
  scope: string,
  root: {
    credentialEpoch: number
    rootExpiresAtUnixMs: number
    circuitNumericId: number
    publicInputLayoutVersion: number
    circuitId: string
    verifyingKeyHash: string
    issuerPublicKeyHash: string
    credentialRoot: Uint8Array
    revocationRoot: Uint8Array
    circuitMetadata: Uint8Array
  },
  circuit: {
    circuitMetadata: Uint8Array
  },
  policy: {
    snapshotHash: string
  }
): CommentPrivacyMetadata {
  const circuitMetadata = circuit.circuitMetadata.byteLength > 0 ? circuit.circuitMetadata : root.circuitMetadata
  const policyHash = policy.snapshotHash.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(policyHash)) {
    throw new Error('comment_privacy_policy_hash_invalid')
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
  }
}

function hasTicketMetadata(metadata: CommentPrivacyMetadata): metadata is CommentPrivacyMetadata & {
  credentialEpoch: number
  circuitNumericId: number
  publicInputLayoutVersion: number
  circuitId: string
  verifyingKeyHash: string
  policyHash: string
  credentialRoot: Uint8Array
  revocationRoot: Uint8Array
  credentialLevel: string
  reputationBucket: string
} {
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
    Boolean(metadata.reputationBucket)
}

function parseArticleIdFromScope(scope: string): number | null {
  if (!scope.startsWith('article:')) {
    return null
  }

  const parsed = Number(scope.slice('article:'.length))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function cloneCredentialMaterial(material: CommentPrivacyCredentialMaterial): CommentPrivacyCredentialMaterial {
  return {
    credentialSecret: new Uint8Array(material.credentialSecret),
    credentialCommitment: new Uint8Array(material.credentialCommitment),
    issuerSignature: new Uint8Array(material.issuerSignature),
    revocationWitness: new Uint8Array(material.revocationWitness),
    revocationHandleHash: material.revocationHandleHash ? new Uint8Array(material.revocationHandleHash) : undefined,
    credentialLevel: material.credentialLevel,
    reputationBucket: material.reputationBucket
  }
}
