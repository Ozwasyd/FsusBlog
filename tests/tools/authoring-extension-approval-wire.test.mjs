import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(path.join(root, 'src/frontend/src/codecs/binary/articlePropertyValueReadWire.generated.ts'), 'utf8');
const wire = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const corpus = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/protocol/authoring-extension-approval-wire-golden.json'), 'utf8'));
for (const row of corpus.cases)
{
    test(`original approval codec ${row.name}`, () =>
    {
        const bytes = Uint8Array.from(Buffer.from(row.payloadHex, 'hex'));
        const decode = wire['decode' + row.record];
        if (!row.valid)
        {
            assert.throws(() => decode(bytes));
            return;
        }
        const value = decode(bytes);
        assert.deepEqual(wire['encode' + row.record](value), bytes);
        for (let end = 0; end < bytes.length; end++) assert.throws(() => decode(bytes.subarray(0, end)));
    });
}
test('transport leaves every frozen original issuer and dependency source byte-identical', () =>
{
    const custody = JSON.parse(readFileSync(path.join(root, 'artifacts/change-contract/authoring-approval-transport-source-custody.json'), 'utf8'));
    assert.equal(custody.originalIssuerHead, '1647fc9535664ada98b7eccdffe09db240d91acd');
    assert.equal(custody.productionRegistration, false);
    for (const row of custody.sources)
    {
        assert.equal(createHash('sha256').update(readFileSync(path.join(root, row.path))).digest('hex'), row.sha256, row.path);
    }
});
