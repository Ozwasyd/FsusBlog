import { expect, it, vi } from 'vitest';

import { decodeDocumentExportRequest } from '@/codecs/binary/documentExportWire.generated';
import { decodeDocumentExportSourceChoicesResponse } from '@/codecs/binary/documentExportSourceOptionsWire.generated';
import { createDocumentExportHostPrepareRequest, requireDocumentExportHostFacts } from '@/views/admin/article/DocumentExportHost.vue';
import type { DocumentExportHostAuthorities } from '@/views/admin/article/DocumentExportHost.vue';

import choicesGoldens from '../../../backend/Fixtures/document-export-source-options-payload-goldens-v1.json';
import jobGoldens from '../../../backend/Fixtures/document-export-payload-goldens-v1.json';

function bytes(name: string, vectors: typeof choicesGoldens.vectors): Uint8Array
{
    return Uint8Array.from(vectors.find(vector => vector.name === name)!.hex.match(/../gu)!, value => Number.parseInt(value, 16));
}
const response = () => decodeDocumentExportSourceChoicesResponse(bytes('exact-version-choices', choicesGoldens.vectors));
const original = () => decodeDocumentExportRequest(bytes('request-revision', jobGoldens.vectors));
function authority(): DocumentExportHostAuthorities
{
    const request = original();
    return {
        readCatalog: () => [{ id: request.formatId, label: 'declared format fixture', providerId: 'qualified fixture provider',
            available: true, reason: '', layouts: [request.layoutProfile], themes: [request.themeProfile], support: [] }],
        privateForSource: () => true
    };
}
function selection()
{
    const request = original();
    return { sourceId: response().choices[0]!.choiceId, formatId: request.formatId, layout: request.layoutProfile, theme: request.themeProfile };
}

it('requires explicit persisted choice rather than inferring a first or latest revision', () =>
{
    const facts = authority();
    const read = vi.spyOn(facts, 'readCatalog');
    expect(() => requireDocumentExportHostFacts(response(), '', facts, () => {})).toThrow('document_export_explicit_source_required');
    expect(read).not.toHaveBeenCalled();
});
it.each(['absent', 'unknown', 'unavailable'] as const)('refuses %s runtime facts before reading source privacy', state =>
{
    const facts = authority();
    const privacy = vi.spyOn(facts, 'privateForSource');
    if (state === 'unknown') facts.readCatalog = () => undefined;
    if (state === 'unavailable')
    {
        const declared = facts.readCatalog()!;
        facts.readCatalog = () => declared.map(format => ({ ...format, available: false, reason: 'runtime-readiness-authority-unavailable' }));
    }
    expect(() => requireDocumentExportHostFacts(response(), selection().sourceId, state === 'absent' ? undefined : facts, () => {}))
        .toThrow('document_export_runtime_availability_unavailable');
    expect(privacy).not.toHaveBeenCalled();
});
it.each([undefined, 'private-authorized-download'])('refuses missing or output-only privacy facts %s', value =>
{
    const facts = authority();
    facts.privateForSource = () => value as unknown as boolean;
    expect(() => requireDocumentExportHostFacts(response(), selection().sourceId, facts, () => {}))
        .toThrow('document_export_source_privacy_unavailable');
});
it.each([true, false])('preserves the explicit source-policy boolean %s', privateSource =>
{
    const facts = authority();
    facts.privateForSource = () => privateSource;
    const captured = requireDocumentExportHostFacts(response(), selection().sourceId, facts, () => {});
    expect(captured.sources).toEqual([{ id: captured.choice.choiceId, label: captured.choice.label, coordinate: captured.choice.coordinate, private: privateSource }]);
});
it('prepares exact bound Int64 coordinates and locale with one stable request/idempotency identity', () =>
{
    const choice = response().choices[0]!;
    const allocate = vi.fn(() => ({ requestId: 'actual-intent', idempotencyKey: 'actual-idempotency' }));
    const locale = vi.fn(() => 'en-US');
    const prepare = createDocumentExportHostPrepareRequest(choice, authority().readCatalog()!, locale, allocate);
    const request = prepare(selection());
    expect(request).toEqual({ requestId: 'actual-intent', idempotencyKey: 'actual-idempotency', source: choice.coordinate,
        formatId: original().formatId, layoutProfile: original().layoutProfile, themeProfile: original().themeProfile, locale: 'en-US' });
    expect(request.source.sourceVersion).toBe('9007199254740993');
    expect(prepare(selection())).toBe(request);
    expect(allocate).toHaveBeenCalledOnce();
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.source)).toBe(true);
});
it.each(['sourceId', 'formatId', 'layout', 'theme'] as const)('refuses an unbound %s before allocating identities', field =>
{
    const allocate = vi.fn(() => ({ requestId: 'unused', idempotencyKey: 'unused' }));
    const prepare = createDocumentExportHostPrepareRequest(response().choices[0]!, authority().readCatalog()!, () => 'zh-CN', allocate);
    expect(() => prepare({ ...selection(), [field]: 'unsupported' })).toThrow('document_export_selection_unavailable');
    expect(allocate).not.toHaveBeenCalled();
});
it('captures the actual locale for each changed explicit intent without mutating a prior uncertain request', () =>
{
    let locale = 'zh-CN';
    const allocate = vi.fn(() => ({ requestId: `intent-${locale}`, idempotencyKey: `key-${locale}` }));
    const prepare = createDocumentExportHostPrepareRequest(response().choices[0]!, authority().readCatalog()!, () => locale, allocate);
    const prior = prepare(selection());
    locale = 'en-US';
    const next = prepare(selection());
    expect(prior.locale).toBe('zh-CN');
    expect(next.locale).toBe('en-US');
    expect(next.requestId).not.toBe(prior.requestId);
    expect(prepare(selection())).toBe(next);
    expect(allocate).toHaveBeenCalledTimes(2);
});
it('retains the captured server coordinate when the caller later mutates its response object', () =>
{
    const choice = response().choices[0]!;
    const coordinate = { ...choice.coordinate };
    const prepare = createDocumentExportHostPrepareRequest(choice, authority().readCatalog()!, () => 'zh-CN', () => ({ requestId: 'intent', idempotencyKey: 'key' }));
    choice.coordinate.sourceVersion = '1';
    expect(prepare(selection()).source).toEqual(coordinate);
});
