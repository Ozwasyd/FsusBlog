import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDocumentExport, requestDocumentExport } from '@/api/documentExport';
import {
    decodeDocumentExportJobResponse, decodeDocumentExportPageResponse, decodeDocumentExportRequest,
    decodeDocumentExportTaskRequest
} from '@/codecs/binary/documentExportWire.generated';
import {
    binaryFrameDecoderFrameTypes, binaryFrameDecoderRegistrations, binaryFrameDecoderRegistry,
    decodeBinaryFramePayload
} from '@/composition/binaryDecoderRegistry';
import { FrameType } from '@wasm/protocol/frame';

import spec from '../../../../src/shared/Contracts/Validation/document-export-wire.json';
import goldens from '../../../backend/Fixtures/document-export-payload-goldens-v1.json';

const controlledHttp = vi.hoisted(() => vi.fn());
// The actual frame enum, original response registry and generated codecs are
// unmocked. Only the HTTP/outer-native admission boundary is controlled here.
// This is not authenticated HTTP, native Wasm or successful output evidence.
vi.mock('@/composition/binaryTransport', () => ({ requestBinaryOnly: controlledHttp }));

function payload(name: string): Uint8Array {
    const hex = goldens.vectors.find(vector => vector.name === name)!.hex;
    return Uint8Array.from(hex.match(/../gu)!, value => Number.parseInt(value, 16));
}

beforeEach(() => { controlledHttp.mockReset(); });

describe('registered Export consumer with actual Shared response composition', () => {
    it('uses all four actual owner-allocated frame names without a test replacement', () => {
        for (const [name, root] of Object.entries(spec.roots)) {
            expect((FrameType as Readonly<Record<string, number | undefined>>)[name]).toBe(root.value);
        }
    });

    it('registers the actual job decoder exactly once and retains the queued literal facts', () => {
        expect(binaryFrameDecoderFrameTypes.filter(type => type === FrameType.DocumentExportJobResponse)).toHaveLength(1);
        expect(binaryFrameDecoderRegistrations.filter(([type]) => type === FrameType.DocumentExportJobResponse)).toHaveLength(1);
        expect(binaryFrameDecoderRegistry[FrameType.DocumentExportJobResponse]).toBe(decodeDocumentExportJobResponse);
        const job = decodeBinaryFramePayload(FrameType.DocumentExportJobResponse, payload('queued-job-response'));
        expect(job).toEqual(decodeDocumentExportJobResponse(payload('queued-job-response')));
        expect(job).toMatchObject({ taskId: 'task-1', status: 1, output: null, attempts: [] });
    });

    it('registers the actual page decoder exactly once and retains literal paging facts', () => {
        expect(binaryFrameDecoderRegistrations.filter(([type]) => type === FrameType.DocumentExportPageResponse)).toHaveLength(1);
        expect(binaryFrameDecoderRegistry[FrameType.DocumentExportPageResponse]).toBe(decodeDocumentExportPageResponse);
        expect(decodeBinaryFramePayload(FrameType.DocumentExportPageResponse, payload('single-page-response')))
            .toEqual(decodeDocumentExportPageResponse(payload('single-page-response')));
    });

    it('keeps request roots outside the sole response registry', () => {
        for (const type of [FrameType.DocumentExportRequest, FrameType.DocumentExportTaskRequest]) {
            expect(binaryFrameDecoderRegistry[type]).toBeUndefined();
            expect(() => decodeBinaryFramePayload(type, payload('request-revision'))).toThrow();
        }
    });

    it('refuses malformed response payloads through the real registered decoders', () => {
        for (const [type, name] of [[FrameType.DocumentExportJobResponse, 'queued-job-response'],
            [FrameType.DocumentExportPageResponse, 'single-page-response']] as const) {
            const bytes = payload(name);
            expect(() => decodeBinaryFramePayload(type, bytes.subarray(0, bytes.length - 1))).toThrow();
            expect(() => decodeBinaryFramePayload(type, Uint8Array.from([...bytes, 0]))).toThrow();
        }
    });

    it('connects the production request caller to actual registered frame and payload identities', async () => {
        controlledHttp.mockImplementation(async options =>
            decodeBinaryFramePayload(options.frameType, payload('queued-job-response')));
        const request = decodeDocumentExportRequest(payload('request-revision'));
        await expect(requestDocumentExport(request)).resolves.toMatchObject({ taskId: 'task-1', output: null });
        const options = controlledHttp.mock.calls[0]![0];
        expect(options).toMatchObject({ privateScope: 'admin', frameType: FrameType.DocumentExportJobResponse });
        expect(options.requestOptions).toMatchObject({ method: 'POST', credentials: 'include', requiresPow: true });
        expect(new DataView(options.requestOptions.body).getUint16(8, true)).toBe(FrameType.DocumentExportRequest);
        expect(decodeDocumentExportRequest(new Uint8Array(options.requestOptions.body, 16))).toEqual(request);
    });

    it('connects the production status caller without adding a second task or response authority', async () => {
        controlledHttp.mockImplementation(async options =>
            decodeBinaryFramePayload(options.frameType, payload('queued-job-response')));
        await expect(getDocumentExport('task-1')).resolves.toMatchObject({ taskId: 'task-1', status: 1, output: null });
        const options = controlledHttp.mock.calls[0]![0];
        expect(options.requestOptions.requiresPow).toBe(false);
        expect(new DataView(options.requestOptions.body).getUint16(8, true)).toBe(FrameType.DocumentExportTaskRequest);
        expect(decodeDocumentExportTaskRequest(new Uint8Array(options.requestOptions.body, 16))).toEqual({ taskId: 'task-1' });
    });
});
