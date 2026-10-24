import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertOpaqueFixtureSourceOwner, isOpaqueFrontendFixture, opaqueFixtureSourcePath, selectOpaqueFixtureSourceRegressions } from './opaque-fixture-source-ownership.mjs';
import { parseMatrix } from './parse-matrix.mjs';

const matrix = () => parseMatrix(fs.readFileSync(fileURLToPath(new URL('../../tests/matrix.yml', import.meta.url)), 'utf8'));

test('opaque source ownership retains the actual original complete matrix consumer', () =>
{
    assert.doesNotThrow(() => assertOpaqueFixtureSourceOwner(matrix(), [opaqueFixtureSourcePath]));
    assert.equal(isOpaqueFrontendFixture(opaqueFixtureSourcePath), true);
    assert.equal(isOpaqueFrontendFixture('tests/tools/fixtures/unregistered.mjs'), true);
    assert.equal(isOpaqueFrontendFixture('tools/current-source.mjs'), false);
    assert.equal(isOpaqueFrontendFixture('tests/tools/current-source.test.mjs'), false);
    assert.throws(() => assertOpaqueFixtureSourceOwner(matrix(), ['tests/tools/fixtures/unregistered.mjs']), /no registered/u);
    assert.throws(() => assertOpaqueFixtureSourceOwner(matrix(), []), /no registered/u);
});

test('opaque matrix owner refuses absent duplicated crossed and filtered source consumer declarations', () =>
{
    for (const mutation of ['missing-owner', 'duplicate', 'crossed', 'filter', 'partial', 'missing-input', 'schema'])
    {
        const document = matrix();
        const group = document.commandGroups['frontend-static-governance'];
        const owner = group.commands.find(command => command.id === 'frontend-style-fixtures');
        if (mutation === 'missing-owner')
        {
            group.commands = group.commands.filter(command => command !== owner);
        }
        else if (mutation === 'duplicate')
        {
            group.commands.push(structuredClone(owner));
        }
        else if (mutation === 'crossed')
        {
            document.commandGroups.other = group;
            delete document.commandGroups['frontend-static-governance'];
        }
        else if (mutation === 'filter')
        {
            owner.command.splice(2, 0, '--test-name-pattern=partial');
        }
        else if (mutation === 'partial')
        {
            owner.command.splice(2, 1);
        }
        else if (mutation === 'missing-input')
        {
            owner.consumedInputs = owner.consumedInputs.filter(file => file !== opaqueFixtureSourcePath);
        }
        else
        {
            group.schema = 'unregistered-owner';
        }
        assert.throws(() => assertOpaqueFixtureSourceOwner(document, [opaqueFixtureSourcePath]), /complete original matrix consumer/u);
    }
});

test('opaque source registration adds only its actual applicable source controls', () =>
{
    assert.equal(selectOpaqueFixtureSourceRegressions([opaqueFixtureSourcePath]).length, 2);
    assert.equal(selectOpaqueFixtureSourceRegressions(['tools/configuration/check-opaque-fixture-source.mjs']).length, 2);
    assert.equal(selectOpaqueFixtureSourceRegressions(['tests/tools/canonical-digest-edge.test.mjs']).length, 2);
    assert.deepEqual(selectOpaqueFixtureSourceRegressions(['docs/unrelated.md']), []);
    assert.deepEqual(selectOpaqueFixtureSourceRegressions(['tests/tools/fixtures/unregistered.mjs']), []);
});
