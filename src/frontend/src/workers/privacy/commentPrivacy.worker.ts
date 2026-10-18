import { zeroizeCommentPrivacyBytes } from '@/privacy/commentPrivacyCredentialLifecycle';
import { buildCommentPrivacyRevocationWitnessLocally } from '@/privacy/commentPrivacyRevocationLocal';
import type { CommentPrivacyProofRequest } from '@/privacy/commentPrivacyTypes';
import { createCommentPrivacyWasmProver } from '@/privacy/commentPrivacyWasmProver';

type CommentPrivacyWorkerRequest =
  | {
      v: 1;
      type: 'prewarm';
      requestId: number;
  }
  | {
      v: 1;
      type: 'buildRevocationWitness';
      requestId: number;
      artifact: {
          credentialEpoch: number;
          version: number;
          baseVersion: number;
          expiresAtUnixMs: number;
          kind: 1 | 2;
          algorithmId: string;
          pathDepth: number;
          issuerPublicKeyHash: string;
          revocationRoot: ArrayBuffer;
          contentHash: ArrayBuffer;
          signature: ArrayBuffer;
          entryHashes: ArrayBuffer;
      };
      baseEntryHashes?: ArrayBuffer;
      revocationHandleHash: ArrayBuffer;
      expectedEpoch: number;
      expectedVersion: number;
      expectedIssuerPublicKeyHash: string;
      expectedRevocationRoot: ArrayBuffer;
      nowUnixMs: number;
      maxCpuMs: number;
  }
  | {
      v: 1;
      type: 'prepareProof';
      requestId: number;
      scope: string;
      rootVersion: string;
      metadataBytes: ArrayBuffer;
      credentialEpoch?: number;
      circuitNumericId?: number;
      publicInputLayoutVersion?: number;
      circuitId?: string;
      verifyingKeyHash?: string;
      issuerPublicKeyHash?: string;
      policyHash?: string;
      isEligible?: boolean;
      mayComment?: boolean;
      rateClass?: 'common' | 'unknown';
      requiresModeration?: boolean;
      credentialCommitment?: ArrayBuffer;
      credentialRoot?: ArrayBuffer;
      revocationRoot?: ArrayBuffer;
      circuitMetadata?: ArrayBuffer;
      credentialLevel?: string;
      reputationBucket?: string;
      credentialSecret?: ArrayBuffer;
      issuerSignature?: ArrayBuffer;
      revocationWitness?: ArrayBuffer;
  };

type CommentPrivacyWorkerResponse =
  | {
      v: 1;
      type: 'prewarmed';
      requestId: number;
      ok: true;
  }
  | {
      v: 1;
      type: 'revocationWitness';
      requestId: number;
      ok: true;
      witness: Uint8Array;
      entryHashes: Uint8Array;
  }
  | {
      v: 1;
      type: 'proof';
      requestId: number;
      ok: true;
      proofBytes: Uint8Array;
      publicInputs: Uint8Array;
      nullifierHash: Uint8Array;
  }
  | {
      v: 1;
      type: 'error';
      requestId: number;
      ok: false;
      error: string;
  };

// Dedicated workers share MessagePort's message and transferable APIs.
const ctx = self as Pick<MessagePort, 'onmessage' | 'postMessage'>;
const prover = createCommentPrivacyWasmProver();

ctx.onmessage = (event: MessageEvent<CommentPrivacyWorkerRequest>) =>
{
    const request = event.data;
    if (request ? request.v !== 1 : true)
    {
        return;
    }

    void handleRequest(request);
};

async function handleRequest(request: CommentPrivacyWorkerRequest): Promise<void>
{
    try
    {
        if (request.type === 'prewarm')
        {
            await prover.prewarm();
            const response: CommentPrivacyWorkerResponse = {
                v: 1,
                type: 'prewarmed',
                requestId: request.requestId,
                ok: true
            };
            ctx.postMessage(response);
            return;
        }

        if (request.type === 'buildRevocationWitness')
        {
            const revocationHandleHash = new Uint8Array(request.revocationHandleHash);
            const expectedRevocationRoot = new Uint8Array(request.expectedRevocationRoot);
            const baseEntryHashes = request.baseEntryHashes ? new Uint8Array(request.baseEntryHashes) : undefined;
            const artifact = {
                ...request.artifact,
                revocationRoot: new Uint8Array(request.artifact.revocationRoot),
                contentHash: new Uint8Array(request.artifact.contentHash),
                signature: new Uint8Array(request.artifact.signature),
                entryHashes: new Uint8Array(request.artifact.entryHashes)
            };
            try
            {
                const result = await buildCommentPrivacyRevocationWitnessLocally({
                    artifact,
                    baseEntryHashes,
                    revocationHandleHash,
                    expectedEpoch: request.expectedEpoch,
                    expectedVersion: request.expectedVersion,
                    expectedIssuerPublicKeyHash: request.expectedIssuerPublicKeyHash,
                    expectedRevocationRoot,
                    nowUnixMs: request.nowUnixMs,
                    maxCpuMs: request.maxCpuMs
                });
                const response: CommentPrivacyWorkerResponse = {
                    v: 1,
                    type: 'revocationWitness',
                    requestId: request.requestId,
                    ok: true,
                    witness: result.witness,
                    entryHashes: result.entryHashes
                };
                ctx.postMessage(response, [result.witness.buffer, result.entryHashes.buffer]);
            }
            finally
            {
                zeroizeCommentPrivacyBytes(revocationHandleHash);
                zeroizeCommentPrivacyBytes(expectedRevocationRoot);
                zeroizeCommentPrivacyBytes(baseEntryHashes);
                zeroizeCommentPrivacyBytes(artifact.revocationRoot);
                zeroizeCommentPrivacyBytes(artifact.contentHash);
                zeroizeCommentPrivacyBytes(artifact.signature);
                zeroizeCommentPrivacyBytes(artifact.entryHashes);
            }
            return;
        }

        const proofRequest = toProofRequest(request);
        try
        {
            const proof = await prover.prepareProof(proofRequest);
            const response: CommentPrivacyWorkerResponse = {
                v: 1,
                type: 'proof',
                requestId: request.requestId,
                ok: true,
                proofBytes: proof.proofBytes,
                publicInputs: proof.publicInputs,
                nullifierHash: proof.nullifierHash
            };
            ctx.postMessage(response, [proof.proofBytes.buffer, proof.publicInputs.buffer, proof.nullifierHash.buffer]);
        }
        finally
        {
            zeroizeProofRequest(proofRequest);
        }
    }
    catch (error)
    {
        const response: CommentPrivacyWorkerResponse = {
            v: 1,
            type: 'error',
            requestId: request.requestId,
            ok: false,
            error: sanitizeWorkerError(error)
        };
        ctx.postMessage(response);
    }
}

function toProofRequest(request: Extract<CommentPrivacyWorkerRequest, { type: 'prepareProof'; }>): CommentPrivacyProofRequest
{
    return {
        scope: request.scope,
        rootVersion: request.rootVersion,
        metadataBytes: new Uint8Array(request.metadataBytes),
        credentialEpoch: request.credentialEpoch,
        circuitNumericId: request.circuitNumericId,
        publicInputLayoutVersion: request.publicInputLayoutVersion,
        circuitId: request.circuitId,
        verifyingKeyHash: request.verifyingKeyHash,
        issuerPublicKeyHash: request.issuerPublicKeyHash,
        policyHash: request.policyHash,
        isEligible: request.isEligible,
        mayComment: request.mayComment,
        rateClass: request.rateClass,
        requiresModeration: request.requiresModeration,
        credentialCommitment: toBytes(request.credentialCommitment),
        credentialRoot: toBytes(request.credentialRoot),
        revocationRoot: toBytes(request.revocationRoot),
        circuitMetadata: toBytes(request.circuitMetadata),
        credentialLevel: request.credentialLevel,
        reputationBucket: request.reputationBucket,
        credentialSecret: toBytes(request.credentialSecret),
        issuerSignature: toBytes(request.issuerSignature),
        revocationWitness: toBytes(request.revocationWitness)
    };
}

function toBytes(buffer: ArrayBuffer | undefined): Uint8Array | undefined
{
    return buffer ? new Uint8Array(buffer) : undefined;
}

function zeroizeProofRequest(request: CommentPrivacyProofRequest): void
{
    zeroizeCommentPrivacyBytes(request.metadataBytes);
    zeroizeCommentPrivacyBytes(request.credentialCommitment);
    zeroizeCommentPrivacyBytes(request.credentialRoot);
    zeroizeCommentPrivacyBytes(request.revocationRoot);
    zeroizeCommentPrivacyBytes(request.circuitMetadata);
    zeroizeCommentPrivacyBytes(request.credentialSecret);
    zeroizeCommentPrivacyBytes(request.issuerSignature);
    zeroizeCommentPrivacyBytes(request.revocationWitness);
}

function sanitizeWorkerError(error: unknown): string
{
    if (error instanceof Error && error.message.startsWith('comment_privacy_prover_'))
    {
        return error.message;
    }

    return 'comment_privacy_worker_failed';
}
