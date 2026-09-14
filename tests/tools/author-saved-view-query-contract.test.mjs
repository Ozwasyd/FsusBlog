import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {validateAuthorSavedViewQueryContract} = await import(new URL('../../tools/governance/check-author-saved-view-query-contract.mjs', import.meta.url));
const root = path.resolve(import.meta.dirname, '../..');
const contractPath = 'src/backend/Services/Authoring/AuthorSavedViewContracts.cs';
const source = fs.readFileSync(path.join(root, contractPath), 'utf8');

function withFixture(mutator, run)
{
    const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-saved-view-contract-')));
    try
    {
        const target = path.join(fixture, contractPath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, mutator(source));
        run(fixture);
    }
    finally
    {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
}

test('current Author Saved View query contract satisfies static governance', () =>
{
    assert.deepEqual(validateAuthorSavedViewQueryContract(root), []);
});

test('static governance rejects recursive or executable query surfaces', () =>
{
    withFixture(
        (value) => value.replace(
            'IReadOnlyList<AuthorSavedViewCondition> Conditions,',
            'IReadOnlyList<AuthorSavedViewCondition> Conditions, string SqlExpression,'),
        (fixture) => assert.match(
            validateAuthorSavedViewQueryContract(fixture).join('\n'),
            /exact non-recursive closed shape/u));
});

test('static governance rejects provider-owned operator descriptors', () =>
{
    withFixture(
        (value) => value.replace(
            'ValueTask<AuthorSavedViewDependencyFact?> ResolveConditionAsync(',
            'ValueTask<AuthorSavedViewDependencyResolution?> ResolveConditionAsync('),
        (fixture) => assert.match(
            validateAuthorSavedViewQueryContract(fixture).join('\n'),
            /resolve facts only/u));
});

test('static governance rejects a second operator registry', () =>
{
    withFixture(
        (value) => `${value}\ninternal static class SecondSavedViewRegistry\n{\n` +
            '    private static readonly System.Collections.ObjectModel.ReadOnlyDictionary<string, ' +
            'AuthorSavedViewOperatorDescriptor> s_second = new(new Dictionary<string, ' +
            'AuthorSavedViewOperatorDescriptor>());\n}\n',
        (fixture) => assert.match(
            validateAuthorSavedViewQueryContract(fixture).join('\n'),
            /exactly one read-only owner/u));
});

test('static governance rejects removal of fail-closed field validation', () =>
{
    withFixture(
        (value) => value.replaceAll('saved_view_field_identity_unknown', 'saved_view_field_identity_unchecked'),
        (fixture) => assert.match(
            validateAuthorSavedViewQueryContract(fixture).join('\n'),
            /missing fail-closed validation/u));
});
