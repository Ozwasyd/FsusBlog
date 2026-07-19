import type { RiskChallengeProofContext } from '@/contracts/riskChallenge'

type ApiUploadProgress = {
  loaded: number
  total?: number
}

export type ApiRequestConfig = {
  signal?: AbortSignal
  credentials?: RequestCredentials
  onUploadProgress?: (event: ApiUploadProgress) => void
  requiresPow?: boolean
  mfaProofToken?: string | null
  riskChallengeProof?: RiskChallengeProofContext | null
}
