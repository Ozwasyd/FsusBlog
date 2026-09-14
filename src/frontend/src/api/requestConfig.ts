import type { RiskChallengeProofContext } from '@/contracts/riskChallenge';

interface ApiUploadProgress {
    loaded: number;
    total?: number;
}

export interface ApiRequestConfig {
    signal?: AbortSignal;
    credentials?: RequestCredentials;
    onUploadProgress?: (event: ApiUploadProgress) => void;
    requiresPow?: boolean;
    mfaProofToken?: string | null;
    riskChallengeProof?: RiskChallengeProofContext | null;
}
