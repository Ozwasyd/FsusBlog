import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schemaPath = 'src/shared/Contracts/Validation/article-property-value-read-wire.json';
const producer = 'tools/contracts/generate-article-property-value-read-wire.mjs';
const schema = JSON.parse(readFileSync(path.join(root, schemaPath), 'utf8'));
for (const scenario of ['surrogate-policy', 'utf16-length-policy', 'trim-policy', 'extension-version-limit', 'opaque-user-limit', 'opaque-user-type', 'document-nullability'])
{
    test('the original producer refuses original scope owner drift: ' + scenario, () =>
    {
        const temporary = mkdtempSync(path.join(os.tmpdir(), 'approval-scope-owner-'));
        try
        {
            const inputs = [schemaPath, producer, 'tools/contracts/format-generated-property-value-read-typescript.mjs',
                'src/shared/Contracts/Validation/aeds-protocol.json', schema.approvalScopeFieldOwner,
                schema.typedValueOwner, schema.definitionContractOwner, ...schema.enumOwners, ...schema.contractOwners];
            for (const name of new Set(inputs))
            {
                const target = path.join(temporary, name);
                mkdirSync(path.dirname(target), { recursive: true });
                copyFileSync(path.join(root, name), target);
            }
            const ownerPath = path.join(temporary, schema.approvalScopeFieldOwner);
            const original = readFileSync(ownerPath, 'utf8');
            if (scenario.endsWith('-limit') || scenario === 'opaque-user-type' || scenario === 'document-nullability')
            {
                const altered = structuredClone(schema);
                const field = altered.records.AuthoringApprovalScopeView.fields.find(field =>
                    field.name === (scenario === 'extension-version-limit' ? 'ExtensionVersion'
                        : scenario === 'document-nullability' ? 'DocumentId' : 'UserId'));
                if (scenario === 'opaque-user-type') field.type = 'scheme';
                else if (scenario === 'document-nullability') field.nullable = false;
                else field.maxChars++;
                writeFileSync(path.join(temporary, schemaPath), JSON.stringify(altered));
            }
            else
            {
                const altered = scenario === 'surrogate-policy' ? original.replace(' || char.IsSurrogate(c)', '')
                    : scenario === 'utf16-length-policy' ? original.replace('value.Length <= limit', 'value.Length < limit')
                        : original.replace('value == value.Trim()', "value == value.Trim(' ')");
                assert.notEqual(altered, original);
                writeFileSync(ownerPath, altered);
            }
            const result = spawnSync(process.execPath, [path.join(temporary, producer), '--check'], { encoding: 'utf8' });
            assert.equal(result.status, 1);
            assert.match(result.stderr, /property_value_read_owner_drift: approval_scope_field_owner_drift/);
        }
        finally
        {
            rmSync(temporary, { recursive: true, force: true });
        }
    });
}
