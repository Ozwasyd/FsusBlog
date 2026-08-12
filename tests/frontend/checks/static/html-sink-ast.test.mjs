import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { analyzeHtmlSinks } from '../../../../tools/security/html-sink-ast.mjs';

const fixturePath = fileURLToPath(new URL('../../fixtures/html-sink-ast/cases.json', import.meta.url));
const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'));

for (const fixture of fixtures)
{
    test(`HTML sink AST fixture: ${fixture.id}`, () =>
    {
        const diagnostics = analyzeHtmlSinks(fixture.source, { filePath: fixture.filePath })
            .map(({ sink, line, column }) => ({ sink, line, column }));

        if (fixture.expected === null)
        {
            assert.deepEqual(diagnostics, []);
            return;
        }

        assert.deepEqual(diagnostics, [fixture.expected]);
    });
}
