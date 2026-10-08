import type { RiskChallengeProofContext } from '@/contracts/riskChallenge';

interface ApiUploadProgress {
    loaded: number;
    total?: number;
}

export interface ApiRequestConfig {
    signal?: AbortSignal;
    onUploadProgress?: (event: ApiUploadProgress) => void;
    mfaProofToken?: string | null;
    riskChallengeProof?: RiskChallengeProofContext | null;
}
