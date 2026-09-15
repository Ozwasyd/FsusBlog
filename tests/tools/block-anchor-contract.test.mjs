import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const {
    checkBlockAnchorContract,
    checkBlockAnchorContractSources,
    readBlockAnchorSources
} = await import(pathToFileURL(path.join(root, 'tools/governance/check-block-anchor-contract.mjs')).href);

const contractsFile = 'src/shared/Contracts/BlockLinks/BlockAnchorContracts.cs';
const codecFile = 'src/shared/Contracts/BlockLinks/BlockAnchorCodec.cs';
const schemaFile = 'src/shared/Contracts/BlockLinks/block-anchor-contract.schema.json';

function sources()
{
    return new Map(readBlockAnchorSources());
}

function diagnostics(mutator)
{
    const fixture = sources();
    mutator(fixture);
    return checkBlockAnchorContractSources(fixture).join('\n');
}

test('repository has one closed canonical block-anchor identity and codec boundary', () =>
{
    assert.deepEqual(checkBlockAnchorContract(), []);
});

test('duplicate identity, target, or grammar authorities fail closed', () =>
{
    const mutations = [
        ['src/backend/AlternativeBlockAnchorId.cs', 'public readonly record struct AlternativeBlockAnchorId();', /exact-one BlockAnchorId/u],
        ['src/backend/AlternativeArticleBlockTarget.cs', 'public record AlternativeArticleBlockTarget();', /exact-one ArticleBlockTarget/u],
        ['src/backend/AlternativeAnchorGrammar.cs', 'public static bool IsCanonical(string value) => true;', /exact-one anchor grammar predicate/u]
    ];
    for (const [relative, source, expected] of mutations)
    {
        assert.match(diagnostics((fixture) => fixture.set(relative, source)), expected);
    }
});

test('regular expressions, normalization, fallback identity, and runtime consumers fail closed', () =>
{
    const mutations = [
        [' Regex.Match(value, pattern);', /regular-expression parsing/u],
        [' var decoded = Uri.UnescapeDataString(value);', /percent decoding or compatibility normalization/u],
        [' var normalized = value.ToLowerInvariant();', /percent decoding or compatibility normalization/u],
        [' var fallback = ContentHash; ', /content, source-offset or hash fallback identity/u],
        [' var result = QueryResolver.Resolve();', /query, relation, package or UI implementation/u],
        [' var html = new HtmlAnchor();', /HTML or sidecar anchor authority/u],
        [' var alias = "#^anchor";', /second marker or link syntax literal/u]
    ];
    for (const [injected, expected] of mutations)
    {
        assert.match(
            diagnostics((fixture) => fixture.set(codecFile, `${fixture.get(codecFile)}\n${injected}\n`)),
            expected
        );
    }
});

test('schema constants and closed error taxonomy cannot drift', () =>
{
    assert.match(
        diagnostics((fixture) =>
        {
            const schema = JSON.parse(fixture.get(schemaFile));
            schema.properties.grammar.const = '[a-z0-9-]+';
            fixture.set(schemaFile, JSON.stringify(schema));
        }),
        /grammar must remain the exact canonical constant/u
    );
    assert.match(
        diagnostics((fixture) =>
        {
            const schema = JSON.parse(fixture.get(schemaFile));
            schema.additionalProperties = true;
            fixture.set(schemaFile, JSON.stringify(schema));
        }),
        /contract and error taxonomy must be closed/u
    );
    assert.match(
        diagnostics((fixture) => fixture.set(
            contractsFile,
            fixture.get(contractsFile).replace('CodecMismatch = 6', 'CodecMismatch = 7')
        )),
        /closed error taxonomy is incomplete/u
    );
});

test('single grammar authority and upstream delegation are mandatory', () =>
{
    assert.match(
        diagnostics((fixture) => fixture.set(
            'src/shared/Contracts/ArticleEmbeds/ArticleEmbedTargetCodec.cs',
            fixture.get('src/shared/Contracts/ArticleEmbeds/ArticleEmbedTargetCodec.cs')
                .replace('=> BlockAnchorId.IsCanonical(value);', '{}')
        )),
        /must delegate block-anchor grammar/u
    );
    assert.match(
        diagnostics((fixture) => fixture.set(
            codecFile,
            fixture.get(codecFile).replace('TryParseSourceMarker', 'TryParseSourceMarkerRemoved')
        )),
        /source marker, fragment and URL parsers/u
    );
});

test('test corpus and documentation retain forbidden syntax mutation evidence', () =>
{
    const fixture = sources();
    const testSource = fixture.get('tests/backend/Unit/BlockAnchorContractTests.cs');
    const documentation = fixture.get('docs/architecture/block-anchor-contract.md');
    for (const text of [testSource, documentation])
    {
        for (const required of ['#^', '[[', '{#', 'sidecar', 'content hash', 'first-match'])
        {
            assert.match(text.toLowerCase(), new RegExp(required.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
        }
    }
});
