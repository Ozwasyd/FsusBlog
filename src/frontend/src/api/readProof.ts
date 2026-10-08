import { requestBinaryOnly } from '@/composition/binaryTransport';
import type { HumanReadChallenge, HumanReadScope, HumanReadSubmitResult } from '@/contracts/binaryApi';

import { FrameType } from '@wasm/protocol/frame';

import { encodeAedsFrame } from './binaryFrame';

export type { HumanReadChallenge, HumanReadScope, HumanReadSubmitResult } from '@/contracts/binaryApi';

const textEncoder = new TextEncoder();

interface Utf8Part { bytes: Uint8Array; offset: number; length: number; }

export async function requestHumanReadChallenge(input: {
    scope: HumanReadScope;
    routeKey: string;
    articleId?: number | null;
    signal?: AbortSignal;
}): Promise<HumanReadChallenge>
{
    return await requestBinaryOnly<HumanReadChallenge>({
        binaryRoute: { operationId: 'binary_post_read_proof_challenge_aeds' },
        frameType: FrameType.HumanReadChallengeResponse,
        signal: input.signal,
        requestOptions: {
            body: encodeAedsFrame(FrameType.HumanReadChallengeRequest, encodeHumanReadChallengeRequest(input))
        }
    });
}

export async function submitHumanReadProof(input: {
    token: string;
    scope: HumanReadScope;
    routeKey: string;
    articleId?: number | null;
    dwellMs: number;
    signal?: AbortSignal;
}): Promise<HumanReadSubmitResult>
{
    return await requestBinaryOnly<HumanReadSubmitResult>({
        binaryRoute: { operationId: 'binary_post_read_proof_submit_aeds' },
        frameType: FrameType.HumanReadSubmitResponse,
        signal: input.signal,
        requestOptions: {
            body: encodeAedsFrame(FrameType.HumanReadSubmitRequest, encodeHumanReadSubmitRequest(input))
        }
    });
}

function encodeHumanReadChallengeRequest(input: {
    scope: HumanReadScope;
    routeKey: string;
    articleId?: number | null;
}): Uint8Array
{
    const { blob, parts } = buildBlob([input.scope, input.routeKey]);
    const payload = new Uint8Array(24 + 4 + blob.byteLength);
    const view = new DataView(payload.buffer);
    view.setInt32(0, input.articleId ?? 0, true);
    payload[4] = input.articleId == null ? 0 : 1;
    writeSliceRef(view, 8, parts[0]);
    writeSliceRef(view, 16, parts[1]);
    view.setInt32(24, blob.byteLength, true);
    payload.set(blob, 28);
    return payload;
}

function encodeHumanReadSubmitRequest(input: {
    token: string;
    scope: HumanReadScope;
    routeKey: string;
    articleId?: number | null;
    dwellMs: number;
}): Uint8Array
{
    const { blob, parts } = buildBlob([input.token, input.scope, input.routeKey]);
    const payload = new Uint8Array(36 + 4 + blob.byteLength);
    const view = new DataView(payload.buffer);
    view.setInt32(0, input.articleId ?? 0, true);
    view.setInt32(4, input.dwellMs, true);
    payload[8] = input.articleId == null ? 0 : 1;
    writeSliceRef(view, 12, parts[0]);
    writeSliceRef(view, 20, parts[1]);
    writeSliceRef(view, 28, parts[2]);
    view.setInt32(36, blob.byteLength, true);
    payload.set(blob, 40);
    return payload;
}

function buildBlob(values: string[]): { blob: Uint8Array; parts: Utf8Part[]; }
{
    let offset = 0;
    const parts = values.map((value) =>
    {
        const bytes = textEncoder.encode(value);
        const part = { bytes, offset, length: bytes.byteLength };
        offset += bytes.byteLength;
        return part;
    });

    const blob = new Uint8Array(offset);
    for (const part of parts)
    {
        blob.set(part.bytes, part.offset);
    }

    return { blob, parts };
}

function writeSliceRef(view: DataView, offset: number, part: Utf8Part | undefined): void
{
    view.setInt32(offset, part?.offset ?? 0, true);
    view.setInt32(offset + 4, part?.length ?? 0, true);
}
