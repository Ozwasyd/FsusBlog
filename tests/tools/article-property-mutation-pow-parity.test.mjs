import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checker = 'tests/frontend/checks/static/check-frontend-backend-pow-parity.mjs';
const sourcePaths = [checker, 'tests/frontend/checks/support/crossStackMatrix.mjs',
    'src/shared/Contracts/Validation/fsusblog.openapi.json', 'src/frontend/src/generated/fsusBinaryRoutes.ts',
    'src/frontend/src/api/comment.ts', 'src/frontend/src/api/article.ts',
    'src/frontend/src/api/articlePropertyValues.ts', 'src/frontend/src/api/articlePropertyDefinitions.ts'];

function fixture(run)
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'property-pow-original-checker-'));
    try
    {
        for (const name of sourcePaths)
        {
            const target = path.join(directory, name);
            mkdirSync(path.dirname(target), { recursive: true });
            copyFileSync(path.join(root, name), target);
        }
        return run(directory);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
}
function check(directory)
{
    return spawnSync(process.execPath, [path.join(directory, checker)], { cwd: directory, encoding: 'utf8' });
}

test('the original unchanged PoW checker verifies the real six property operation descriptors', () => fixture(directory =>
{
    const result = check(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /frontend-backend-pow-parity.*ok/);
    assert.equal(readFileSync(path.join(directory, checker), 'utf8'), readFileSync(path.join(root, checker), 'utf8'));
}));

for (const operation of ['binary_author_article_property_values_mutate',
    ...['create', 'update', 'rename', 'deprecate', 'delete'].map(action => `binary_author_article_property_definition_${action}`)])
{
    test(`the original PoW checker still refuses a false no-PoW descriptor for ${operation}`, () => fixture(directory =>
    {
        const name = operation.endsWith('values_mutate') ? 'articlePropertyValues.ts' : 'articlePropertyDefinitions.ts';
        const target = path.join(directory, 'src/frontend/src/api', name);
        const source = readFileSync(target, 'utf8');
        assert.ok(source.includes(`operationId: '${operation}'`));
        writeFileSync(target, source.replace(`operationId: '${operation}'`, "operationId: 'binary_author_article_property_values_read'"));
        const result = check(directory);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /frontend requiresPow=true but backend x-fsus-pow=false/);
    }));
}
