import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { validateCurrentSchemaAuthority } from '../../tools/db/check-current-schema-authority.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const canonicalRelative = 'src/backend/Infrastructure/SchemaMigration/CurrentSchemaCanonicalModel.cs';
const inspectorRelative = 'src/backend/Infrastructure/SchemaMigration/SchemaModelInspector.cs';

function mutatedRepository(mutate)
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-current-schema-authority-'));
    for (const relative of [canonicalRelative, inspectorRelative])
    {
        const target = path.join(temporary, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(root, relative), target);
    }
    mutate(temporary);
    return temporary;
}

test('current schema authority has one canonical extractor, three adapters and one verifier', () =>
{
    assert.deepEqual(validateCurrentSchemaAuthority(root), []);
});

test('current schema authority rejects migration catalog input and fixture reconstruction', () =>
{
    for (const mutation of [
        'SchemaMigrationRegistry registry = new();',
        'string expected = File.ReadAllText("tests/Fixtures/current-schema.json");'
    ])
    {
        const temporary = mutatedRepository((repository) =>
        {
            fs.appendFileSync(path.join(repository, canonicalRelative), `\n${mutation}\n`);
        });
        assert.notDeepEqual(validateCurrentSchemaAuthority(temporary), []);
    }
});

test('current schema authority rejects a hand-written inventory or second generator', () =>
{
    const handWritten = mutatedRepository((repository) =>
    {
        const target = path.join(repository, 'src/backend/Services/SecondSchemaInventory.cs');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'var table = new SchemaTableModel("manual", [], []);\n');
    });
    assert.ok(validateCurrentSchemaAuthority(handWritten).some((error) => error.includes('hand-written')));

    const secondGenerator = mutatedRepository((repository) =>
    {
        const target = path.join(repository, 'src/backend/Services/SecondSchemaGenerator.cs');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'var model = CurrentSchemaCanonicalAuthority.Extract(entityTypes);\n');
    });
    assert.ok(validateCurrentSchemaAuthority(secondGenerator).some((error) => error.includes('second current schema producer')));
});
