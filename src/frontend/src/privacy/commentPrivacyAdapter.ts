import {
  getAnonymousCredentialCircuitSnapshot,
  getAnonymousCredentialRootSnapshot,
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
        const [root, circuit] = await Promise.all([
          getAnonymousCredentialRootSnapshot({ signal, credentials: 'omit' }),
          getAnonymousCredentialCircuitSnapshot({ signal, credentials: 'omit' })
        ])

        if (signal.aborted) {
          return { ok: false, reason: 'comment_privacy_metadata_aborted' }
        }

        if (!root.zkAnonymousEnabled || !root.verifierConfigured || root.rootExpiresAtUnixMs <= Date.now()) {
          return { ok: false, reason: 'comment_privacy_metadata_unavailable' }
        }

        return {
          ok: true,
          metadata: toPrivacyMetadata(scope, root, circuit)
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
          anonymousScope: scope,
          displayLanguage: 'zh-CN',
          circuitId: metadata.circuitId,
          nullifierHash: proof.nullifierHash,
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
    credentialRoot: Uint8Array
    revocationRoot: Uint8Array
    circuitMetadata: Uint8Array
  },
  circuit: {
    circuitMetadata: Uint8Array
  }
): CommentPrivacyMetadata {
  const circuitMetadata = circuit.circuitMetadata.byteLength > 0 ? circuit.circuitMetadata : root.circuitMetadata
  return {
    scope,
    rootVersion: `${root.credentialEpoch}:${root.verifyingKeyHash}`,
    metadataBytes: new Uint8Array(circuitMetadata),
    credentialEpoch: root.credentialEpoch,
    circuitNumericId: root.circuitNumericId,
    publicInputLayoutVersion: root.publicInputLayoutVersion,
    circuitId: root.circuitId,
    credentialRoot: new Uint8Array(root.credentialRoot),
    revocationRoot: new Uint8Array(root.revocationRoot),
    circuitMetadata: new Uint8Array(circuitMetadata)
  }
}

function hasTicketMetadata(metadata: CommentPrivacyMetadata): metadata is CommentPrivacyMetadata & {
  credentialEpoch: number
  circuitNumericId: number
  publicInputLayoutVersion: number
  circuitId: string
} {
  return Number.isFinite(metadata.credentialEpoch) &&
    Number.isFinite(metadata.circuitNumericId) &&
    Number.isFinite(metadata.publicInputLayoutVersion) &&
    Boolean(metadata.circuitId)
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
    issuerSignature: new Uint8Array(material.issuerSignature),
    revocationWitness: new Uint8Array(material.revocationWitness)
  }
}
