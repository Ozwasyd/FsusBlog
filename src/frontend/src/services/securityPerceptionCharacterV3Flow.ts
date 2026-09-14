import type { VerifySecurityChallengeRequest } from '@/api/security';
import {
    PerceptionCharacterV3Representation,
    SecurityChallengeKind,
    type PerceptionCharacterV3IssuePayload,
    type SecurityChallengeAssignment,
    type SecurityChallengeVerifyResponse
} from '@/contracts/binaryApi';
import type { FsusUiPerceptionCharacterMedia } from '@/fsusui/perceptionCharacterChallenge';

import {
    isCanonicalPerceptionCharacterV3OpusOgg,
    isCanonicalPerceptionCharacterV3Png
} from './securityPerceptionCharacterV3MediaValidator';

const ALGORITHM = 'fsu.challenge/perception-character-artifact@v3' as const;
const VISUAL_WIDTH = 384;
const VISUAL_HEIGHT = 144;
const DISPLAY_WIDTH = 320;
const DISPLAY_HEIGHT = 120;
const MAX_VISUAL_BYTES = 32 * 1024;
const MAX_AUDIO_BYTES = 48 * 1024;
const MAX_ANSWER_CHARS = 32;

interface MutableVisualMedia {
    raster: {
        kind: 'image-url';
        src: string;
        width: number;
        height: number;
    } | null;
}

interface MutableAudioMedia {
    audio: {
        src: string;
        type: string;
    } | null;
}

type VerifyChallenge = (request: VerifySecurityChallengeRequest) => Promise<SecurityChallengeVerifyResponse>;

export type PerceptionCharacterV3VerifyOutcome =
  | 'verified'
  | 'retryable'
  | 'reissue'
  | 'unavailable'
  | 'rejected';

export interface PerceptionCharacterV3VerifyResult {
    verified: boolean;
    outcome: PerceptionCharacterV3VerifyOutcome;
    retryable: boolean;
    reissueRequired: boolean;
    unavailable: boolean;
    rejected: boolean;
    proofToken?: string;
    retryAfterMs: number;
}

export interface PerceptionCharacterV3MediaResource {
    readonly media: FsusUiPerceptionCharacterMedia;
    dispose(): void;
}

export interface PerceptionCharacterV3Flow {
    readonly challengeId: string;
    readonly envelopeId: string;
    readonly representation: 'visual' | 'audio';
    readonly expiresAtUnixMs: number;
    readonly attemptBudget: 2;
    createMedia(): PerceptionCharacterV3MediaResource;
    verify(answer: string): Promise<PerceptionCharacterV3VerifyResult>;
    dispose(): void;
}

export interface PerceptionCharacterV3FlowOptions {
    assignment: SecurityChallengeAssignment;
    payload: PerceptionCharacterV3IssuePayload;
    verifyChallenge: VerifyChallenge;
    createObjectUrl?: (blob: Blob) => string;
    revokeObjectUrl?: (url: string) => void;
}

export function createPerceptionCharacterV3Flow(options: PerceptionCharacterV3FlowOptions): PerceptionCharacterV3Flow
{
    assertBinding(options.assignment, options.payload);
    let mediaResource: PerceptionCharacterV3MediaResource | null = null;
    let disposed = false;
    return {
        challengeId: options.payload.challengeId,
        envelopeId: options.payload.envelopeId,
        representation: options.payload.representation === PerceptionCharacterV3Representation.Visual ? 'visual' : 'audio',
        expiresAtUnixMs: options.payload.expiresAtUnixMs,
        attemptBudget: 2,
        createMedia()
        {
            if (disposed)
            {
                throw new TypeError('perception_character_v3_flow_disposed');
            }
            mediaResource?.dispose();
            mediaResource = createPerceptionCharacterV3Media(options.payload, options);
            return mediaResource;
        },
        async verify(answer)
        {
            if (disposed)
            {
                throw new TypeError('perception_character_v3_flow_disposed');
            }
            if (typeof answer !== 'string' || answer.length > MAX_ANSWER_CHARS)
            {
                throw new TypeError('perception_character_v3_answer_invalid');
            }
            const response = await options.verifyChallenge({
                envelopeId: options.payload.envelopeId,
                challengeId: options.payload.challengeId,
                kind: SecurityChallengeKind.PerceptionCharacterV3,
                action: options.assignment.action,
                routeKey: options.assignment.routeKey,
                perceptionCharacterV3: {
                    algorithm: ALGORITHM,
                    challengeId: options.payload.challengeId,
                    envelopeId: options.payload.envelopeId,
                    representation: options.payload.representation,
                    answer,
                    stateToken: options.payload.stateToken
                }
            });
            return mapPerceptionCharacterV3VerifyResult(response);
        },
        dispose()
        {
            if (disposed)
            {
                return;
            }
            disposed = true;
            mediaResource?.dispose();
            mediaResource = null;
            options.payload.mediaBytes.fill(0);
        }
    };
}

export function createPerceptionCharacterV3Media(
    payload: PerceptionCharacterV3IssuePayload,
    options: Pick<PerceptionCharacterV3FlowOptions, 'createObjectUrl' | 'revokeObjectUrl'> = {}
): PerceptionCharacterV3MediaResource
{
    if (payload.representation === PerceptionCharacterV3Representation.Visual)
    {
        if (payload.mediaType !== 'image/png' || payload.mediaBytes.byteLength <= 0 ||
        payload.mediaBytes.byteLength > MAX_VISUAL_BYTES ||
        payload.physicalWidth !== VISUAL_WIDTH || payload.physicalHeight !== VISUAL_HEIGHT ||
        payload.displayWidth !== DISPLAY_WIDTH || payload.displayHeight !== DISPLAY_HEIGHT ||
        !isCanonicalPerceptionCharacterV3Png(payload.mediaBytes))
        {
            throw new TypeError('perception_character_v3_visual_media_invalid');
        }
        const createObjectUrl = options.createObjectUrl ?? URL.createObjectURL.bind(URL);
        const revokeObjectUrl = options.revokeObjectUrl ?? URL.revokeObjectURL.bind(URL);
        const mediaBytes = Uint8Array.from(payload.mediaBytes);
        const objectUrl = createObjectUrl(new Blob([mediaBytes], { type: 'image/png' }));
        const media: MutableVisualMedia = {
            raster: {
                kind: 'image-url',
                src: objectUrl,
                width: DISPLAY_WIDTH,
                height: DISPLAY_HEIGHT
            }
        };
        let disposed = false;
        return {
            media,
            dispose()
            {
                if (disposed)
                {
                    return;
                }
                disposed = true;
                revokeObjectUrl(objectUrl);
                mediaBytes.fill(0);
                media.raster = null;
            }
        };
    }

    if (payload.representation !== PerceptionCharacterV3Representation.Audio ||
      payload.mediaType !== 'audio/ogg; codecs=opus' ||
      payload.mediaBytes.byteLength <= 0 || payload.mediaBytes.byteLength > MAX_AUDIO_BYTES ||
      payload.physicalWidth !== 0 || payload.physicalHeight !== 0 ||
      payload.displayWidth !== 0 || payload.displayHeight !== 0 ||
      !isCanonicalPerceptionCharacterV3OpusOgg(payload.mediaBytes))
    {
        throw new TypeError('perception_character_v3_audio_media_invalid');
    }
    const createObjectUrl = options.createObjectUrl ?? URL.createObjectURL.bind(URL);
    const revokeObjectUrl = options.revokeObjectUrl ?? URL.revokeObjectURL.bind(URL);
    const audioBytes = Uint8Array.from(payload.mediaBytes);
    const objectUrl = createObjectUrl(new Blob([audioBytes], { type: 'audio/ogg; codecs=opus' }));
    const media: MutableAudioMedia = { audio: { src: objectUrl, type: 'audio/ogg; codecs=opus' } };
    let disposed = false;
    return {
        media,
        dispose()
        {
            if (disposed)
            {
                return;
            }
            disposed = true;
            revokeObjectUrl(objectUrl);
            audioBytes.fill(0);
            media.audio = null;
        }
    };
}

export function mapPerceptionCharacterV3VerifyResult(response: SecurityChallengeVerifyResponse): PerceptionCharacterV3VerifyResult
{
    const outcome = response.verified
        ? 'verified'
        : response.reason === 'retryable'
      ? 'retryable'
      : response.reason === 'reissueRequired'
        ? 'reissue'
        : response.reason === 'unavailable'
          ? 'unavailable'
          : 'rejected';
    return {
        verified: outcome === 'verified',
        outcome,
        retryable: outcome === 'retryable',
        reissueRequired: outcome === 'reissue',
        unavailable: outcome === 'unavailable',
        rejected: outcome === 'rejected',
        ...(outcome === 'verified' && response.proofToken ? { proofToken: response.proofToken } : {}),
        retryAfterMs: Math.max(0, response.retryAfterMs)
    };
}

function assertBinding(assignment: SecurityChallengeAssignment, payload: PerceptionCharacterV3IssuePayload): void
{
    if (assignment.kind !== SecurityChallengeKind.PerceptionCharacterV3 || assignment.challengeId !== payload.challengeId ||
      assignment.issuedAtUnixMs !== payload.issuedAtUnixMs || assignment.expiresAtUnixMs !== payload.expiresAtUnixMs ||
      payload.algorithm !== ALGORITHM)
    {
        throw new TypeError('perception_character_v3_assignment_mismatch');
    }
}
