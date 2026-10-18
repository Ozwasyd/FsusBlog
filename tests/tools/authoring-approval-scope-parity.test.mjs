import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

import { approvalScopeCorpus as corpus, scopeHostText, scopePayloadWitness } from './support/approval-scope-witnesses.mjs';

const source = readFileSync(new URL('../../src/frontend/src/codecs/binary/articlePropertyValueReadWire.generated.ts', import.meta.url), 'utf8');
const wire = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const base = wire.decodeAuthoringExtensionApprovalPreviewResponse(Uint8Array.from(Buffer.from(corpus.basePayloadHex, 'hex')));
for (const vector of corpus.vectors)
{
    test('original issuer scope text parity ' + vector.name, () =>
    {
        for (const [index, field] of corpus.fields.entries())
        {
            const bytes = scopePayloadWitness(field, vector);
            const expected = vector.expectedByField[index];
            if (vector.hasHostValue)
            {
                const value = structuredClone(base);
                value.scope[field.property] = scopeHostText(vector);
                if (expected) assert.deepEqual(wire.encodeAuthoringExtensionApprovalPreviewResponse(value), bytes, field.name);
                else assert.throws(() => wire.encodeAuthoringExtensionApprovalPreviewResponse(value), field.name);
            }
            if (expected) assert.deepEqual(wire.encodeAuthoringExtensionApprovalPreviewResponse(
                wire.decodeAuthoringExtensionApprovalPreviewResponse(bytes)), bytes, field.name);
            else assert.throws(() => wire.decodeAuthoringExtensionApprovalPreviewResponse(bytes), field.name);
        }
    });
}
test('approval scope policy does not replace the original property scope text contract', () =>
{
    const bytes = Uint8Array.from(Buffer.from(corpus.retainedProperty.payloadHex, 'hex'));
    assert.equal(wire.decodeArticlePropertyValueReadResponse(bytes).scope.siteScope, '站😀');
    assert.deepEqual(wire.encodeArticlePropertyValueReadResponse(wire.decodeArticlePropertyValueReadResponse(bytes)), bytes);
});
