import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeDocumentExportRequest } from '@/codecs/binary/documentExportWire.generated';
import { decodeDocumentExportSourceCaptureRequest, decodeDocumentExportSourceChoicesResponse } from '@/codecs/binary/documentExportSourceOptionsWire.generated';
import {
    captureDocumentExportRevisionChoicesRequest, captureDocumentExportSourceCaptureRequest, mapDocumentExportSourceChoices
} from '@/components/document-export/documentExportSourceChoices';
import { createDocumentExportWireUiPort } from '@/components/document-export/documentExportWireUiPort';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';

import goldens from '../../../backend/Fixtures/document-export-source-options-payload-goldens-v1.json';
import jobGoldens from '../../../backend/Fixtures/document-export-payload-goldens-v1.json';

function payload(name: string, catalog = goldens): Uint8Array {
    return Uint8Array.from(catalog.vectors.find(vector => vector.name === name)!.hex.match(/../gu)!, value => Number.parseInt(value, 16));
}
const choices = () => decodeDocumentExportSourceChoicesResponse(payload('exact-version-choices'));
afterEach(() => { privateRequestRuntime.resetForTests(); });

describe('sole source-options projection and exact admission coordinate', () => {
    it('maps the literal authorized projection while requiring explicit host privacy', () => {
        const response = choices(); const policy = vi.fn(() => true);
        const mapped = mapDocumentExportSourceChoices(response, policy);
        expect(mapped).toEqual([{ id: response.choices[0]!.choiceId, label: '原始标题 🌍', private: true, coordinate: response.choices[0]!.coordinate }]);
        expect(mapped[0]!.coordinate.sourceVersion).toBe('9007199254740993');
        expect(mapped[0]!.coordinate.revisionId).toBe('17');
        expect(policy).toHaveBeenCalledExactlyOnceWith(response.choices[0]);
        expect(Object.keys(mapped[0]!)).toEqual(['id', 'label', 'coordinate', 'private']);
    });
    it('preserves exact maximum Int64 article, revision, publication and independent source version', () => {
        const response = choices(); const max = '9223372036854775807';
        response.choices[0]!.coordinate = { kind: 3, articleId: max, draftKey: null, revisionId: max, publicationId: max, sourceVersion: '9007199254740993' };
        const mapped = mapDocumentExportSourceChoices(response, () => false);
        expect(mapped[0]!.coordinate).toEqual(response.choices[0]!.coordinate);
        expect(mapped[0]!.private).toBe(false);
    });
    it('captures immutable choices before host callbacks and caller mutation', () => {
        const response = choices();
        const mapped = mapDocumentExportSourceChoices(response, choice => {
            expect(Object.isFrozen(choice.coordinate)).toBe(true); return true;
        });
        response.choices[0]!.coordinate.sourceVersion = '1'; response.choices[0]!.label = 'changed';
        expect(mapped[0]!.label).toBe('原始标题 🌍'); expect(mapped[0]!.coordinate.sourceVersion).toBe('9007199254740993');
        expect(Object.isFrozen(mapped)).toBe(true); expect(Object.isFrozen(mapped[0])).toBe(true);
    });
    it.each([undefined, null, 0, 'false'])('refuses unavailable host privacy %s without selecting a default', privateSource => {
        expect(() => mapDocumentExportSourceChoices(choices(), () => privateSource as boolean)).toThrow('document_export_source_privacy_unavailable');
    });
    it('delegates duplicate-choice refusal to the sole encoder before applying host policy', () => {
        const response = choices(); const policy = vi.fn(() => true);
        expect(() => mapDocumentExportSourceChoices({ choices: [response.choices[0]!, response.choices[0]!] }, policy)).toThrow('document_export_source_options_payload_invalid');
        expect(policy).not.toHaveBeenCalled();
    });
    it.each(['01', '1\n', '9223372036854775808'])('refuses noncanonical source version %s before host projection', sourceVersion => {
        const response = choices(); response.choices[0]!.coordinate.sourceVersion = sourceVersion; const policy = vi.fn(() => true);
        expect(() => mapDocumentExportSourceChoices(response, policy)).toThrow(); expect(policy).not.toHaveBeenCalled();
    });
    it('keeps the canonical fifty-choice cap and invents no choices for an empty response', () => {
        const original = choices().choices[0]!;
        const response = { choices: Array.from({ length: 51 }, (_, index) => ({ ...original, choiceId: index.toString(16).padStart(64, '0') })) };
        const policy = vi.fn(() => true);
        expect(() => mapDocumentExportSourceChoices(response, policy)).toThrow(); expect(policy).not.toHaveBeenCalled();
        expect(mapDocumentExportSourceChoices({ choices: [] }, policy)).toEqual([]); expect(policy).not.toHaveBeenCalled();
    });
    it('uses the actual bound coordinate in the existing admission adapter without deriving a version or making a job', () => {
        const mapped = mapDocumentExportSourceChoices(choices(), () => true);
        const intent = decodeDocumentExportRequest(payload('request-revision', jobGoldens));
        const port = createDocumentExportWireUiPort({
            sources: mapped,
            catalog: [{ id: intent.formatId, label: 'controlled actual format', providerId: 'controlled original host', available: true, reason: '', layouts: [intent.layoutProfile], themes: [intent.themeProfile], support: [] }],
            prepareRequest: () => ({ ...intent, source: mapped[0]!.coordinate }), deliverPrivate: vi.fn()
        });
        try {
            const request = port.prepareRequest({ sourceId: mapped[0]!.id, formatId: intent.formatId, layout: intent.layoutProfile, theme: intent.themeProfile });
            expect(request.source.sourceVersion).toBe('9007199254740993'); expect(request.source.revisionId).toBe('17');
            expect(request.locale).toBe(intent.locale); expect(request.requestId).toBe(intent.requestId);
        } finally { port.dispose?.(); }
    });
});

describe('unbound capture inputs retain the generated grammar', () => {
    it('captures actual Int32 article and exact Int64 revision without allocating SourceVersion', () => {
        const request = decodeDocumentExportSourceCaptureRequest(payload('capture-revision'));
        request.sources[0]!.articleId = 2147483647; request.sources[0]!.revisionId = '9223372036854775807';
        const captured = captureDocumentExportSourceCaptureRequest(request);
        request.sources[0]!.revisionId = '1'; request.sources[0]!.articleId = 1;
        expect(captured.sources[0]!.articleId).toBe(2147483647); expect(captured.sources[0]!.revisionId).toBe('9223372036854775807');
        expect(captured.sources[0]).not.toHaveProperty('sourceVersion'); expect(Object.isFrozen(captured.sources)).toBe(true);
    });
    it('preserves the original kind grammar instead of inferring a draft or publication', () => {
        const request = decodeDocumentExportSourceCaptureRequest(payload('capture-revision'));
        request.sources[0]!.kind = 3;
        expect(() => captureDocumentExportSourceCaptureRequest(request)).toThrow();
    });
    it('keeps revision enumeration ArticleId Int32 and refuses coercion or overflow', () => {
        const request = { articleId: 2147483647 }; const captured = captureDocumentExportRevisionChoicesRequest(request); request.articleId = 1;
        expect(captured.articleId).toBe(2147483647); expect(Object.isFrozen(captured)).toBe(true);
        expect(() => captureDocumentExportRevisionChoicesRequest({ articleId: 2147483648 })).toThrow();
        expect(() => captureDocumentExportRevisionChoicesRequest({ articleId: '42' as unknown as number })).toThrow();
    });
});
