import type {
  RiskChallengeProof,
  RiskChallengeProofSettlement
} from '@/contracts/riskChallenge'

export type SecurityChallengeProof = RiskChallengeProof

export type ChallengeProofState = 'available' | 'reserved' | 'consumed' | 'expired' | 'rejected' | 'replayed'
export type ChallengeProofSettlement = RiskChallengeProofSettlement

export interface ChallengeProofReservation {
  reservationId: string
  proof: SecurityChallengeProof
}

export interface ChallengeProofStateSnapshot {
  state: ChallengeProofState
  challengeId: string
  expiresAtUnixMs: number
}

export interface ChallengeProofStore {
  peek(action: string, routeKey: string): SecurityChallengeProof | null
  reserve(action: string, routeKey: string): ChallengeProofReservation | null
  markInFlight(reservationId: string): boolean
  settle(reservationId: string, outcome: ChallengeProofSettlement): boolean
  inspect(action: string, routeKey: string): ChallengeProofStateSnapshot | null
  set(proof: SecurityChallengeProof): void
  delete(action: string, routeKey: string): void
  clear(): void
}

export interface ChallengeProofStoreOptions {
  now?: () => number
  expirySkewMs?: number
}

interface ProofEntry {
  state: ChallengeProofState
  challengeId: string
  expiresAtUnixMs: number
  proof?: SecurityChallengeProof
  reservationId?: string
  mayHaveBeenSent?: boolean
}

const DEFAULT_EXPIRY_SKEW_MS = 1000

export function createChallengeProofStore(options: ChallengeProofStoreOptions = {}): ChallengeProofStore {
  const now = options.now ?? (() => Date.now())
  const expirySkewMs = Math.max(0, options.expirySkewMs ?? DEFAULT_EXPIRY_SKEW_MS)
  const proofs = new Map<string, ProofEntry>()
  let reservationSequence = 0

  const expireIfNecessary = (key: string, entry: ProofEntry): boolean => {
    if (entry.expiresAtUnixMs - expirySkewMs > now()) {
      return false
    }

    proofs.set(key, terminalEntry(entry, 'expired'))
    return true
  }

  return {
    peek(action, routeKey) {
      const key = proofKey(action, routeKey)
      const entry = proofs.get(key)
      if (!entry || expireIfNecessary(key, entry) || entry.state !== 'available' || !entry.proof) {
        return null
      }
      return { ...entry.proof }
    },
    reserve(action, routeKey) {
      const key = proofKey(action, routeKey)
      const entry = proofs.get(key)
      if (!entry || expireIfNecessary(key, entry) || entry.state !== 'available' || !entry.proof) {
        return null
      }

      const reservationId = `${++reservationSequence}:${entry.challengeId}`
      proofs.set(key, {
        ...entry,
        state: 'reserved',
        reservationId,
        mayHaveBeenSent: false
      })
      return { reservationId, proof: { ...entry.proof } }
    },
    markInFlight(reservationId) {
      const located = findReservation(proofs, reservationId)
      if (!located) {
        return false
      }
      located.entry.mayHaveBeenSent = true
      return true
    },
    settle(reservationId, outcome) {
      const located = findReservation(proofs, reservationId)
      if (!located) {
        return false
      }

      if (outcome === 'before_send_cancelled' && !located.entry.mayHaveBeenSent && located.entry.proof) {
        proofs.set(located.key, {
          ...located.entry,
          state: 'available',
          reservationId: undefined,
          mayHaveBeenSent: undefined
        })
        return true
      }

      const terminalState: ChallengeProofState = outcome === 'expired'
        ? 'expired'
        : outcome === 'replayed'
          ? 'replayed'
          : outcome === 'binding_mismatch' || outcome === 'revoked' || outcome === 'rejected'
            ? 'rejected'
            : 'consumed'
      proofs.set(located.key, terminalEntry(located.entry, terminalState))
      return true
    },
    inspect(action, routeKey) {
      const key = proofKey(action, routeKey)
      const entry = proofs.get(key)
      if (!entry) {
        return null
      }
      expireIfNecessary(key, entry)
      const current = proofs.get(key)!
      return {
        state: current.state,
        challengeId: current.challengeId,
        expiresAtUnixMs: current.expiresAtUnixMs
      }
    },
    set(proof) {
      const key = proofKey(proof.action, proof.routeKey)
      const entry: ProofEntry = {
        state: 'available',
        challengeId: proof.challengeId,
        expiresAtUnixMs: proof.expiresAtUnixMs,
        proof: { ...proof }
      }
      proofs.set(key, entry)
      expireIfNecessary(key, entry)
    },
    delete(action, routeKey) {
      proofs.delete(proofKey(action, routeKey))
    },
    clear() {
      proofs.clear()
    }
  }
}

function findReservation(proofs: Map<string, ProofEntry>, reservationId: string): { key: string, entry: ProofEntry } | null {
  for (const [key, entry] of proofs) {
    if (entry.state === 'reserved' && entry.reservationId === reservationId) {
      return { key, entry }
    }
  }
  return null
}

function terminalEntry(entry: ProofEntry, state: ChallengeProofState): ProofEntry {
  return {
    state,
    challengeId: entry.challengeId,
    expiresAtUnixMs: entry.expiresAtUnixMs
  }
}

export function proofKey(action: string, routeKey: string): string {
  return `${action.trim()}\x1f${routeKey.trim()}`
}

export const defaultChallengeProofStore = createChallengeProofStore()
