import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { validateDocumentExportRegistration } from '../../tools/contracts/document-export-registration.mjs';

const protocol = JSON.parse(readFileSync(new URL('../../src/shared/Contracts/Validation/aeds-protocol.json', import.meta.url)));
const { roots } = JSON.parse(readFileSync(new URL('../../src/shared/Contracts/Validation/document-export-wire.json', import.meta.url)));

test('active exact roots do not require a reservation property or create one', () =>
{
    const candidate = structuredClone(protocol);
    delete candidate.reservedFrameValues;
    const before = JSON.stringify(candidate);
    validateDocumentExportRegistration(candidate, roots);
    assert.equal(JSON.stringify(candidate), before);
});

for (const [label, mutate, expected] of [
    ['missing active root without reservations', value => { value.frameTypes = value.frameTypes.filter(frame => frame.value !== 278); }, /registration drift:DocumentExportRequest/u],
    ['wrong active value', value => { value.frameTypes.find(frame => frame.value === 278).value = 282; }, /registration drift:DocumentExportRequest/u],
    ['wrong active family', value => { value.frameTypes.find(frame => frame.value === 278).goldenFamily = 'wrong'; }, /registration drift:DocumentExportRequest/u],
    ['object reservations', value => { value.reservedFrameValues = {}; }, /registration drift:reservedFrameValues/u],
    ['null reservations', value => { value.reservedFrameValues = null; }, /registration drift:reservedFrameValues/u],
    ['wrong reservation owner', value =>
    {
        value.frameTypes = value.frameTypes.filter(frame => frame.value !== 278);
        value.reservedFrameValues = [{ name: 'DocumentExportRequest', value: 278, ownerIssue: 2436 }];
    }, /registration drift:DocumentExportRequest/u]
])
{
    test(`registration refuses ${label} with controlled contract drift`, () =>
    {
        const candidate = structuredClone(protocol);
        delete candidate.reservedFrameValues;
        mutate(candidate);
        assert.throws(() => validateDocumentExportRegistration(candidate, roots), expected);
    });
}
