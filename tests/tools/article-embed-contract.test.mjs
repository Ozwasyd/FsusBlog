import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const {
    checkArticleEmbedContract,
    checkArticleEmbedContractSources,
    readArticleEmbedSources
} = await import(pathToFileURL(path.join(root, 'tools/governance/check-article-embed-contract.mjs')).href);

const contractPath = 'src/shared/Contracts/ArticleEmbeds/ArticleEmbedContracts.cs';
const codecPath = 'src/shared/Contracts/ArticleEmbeds/ArticleEmbedTargetCodec.cs';
const schemaPath = 'src/shared/Contracts/ArticleEmbeds/article-embed-contract.schema.json';

function sources()
{
    return new Map(readArticleEmbedSources());
}

function diagnostics(mutator)
{
    const fixture = sources();
    mutator(fixture);
    return checkArticleEmbedContractSources(fixture).join('\n');
}

test('repository has one closed article embed codec, provider contract and dependency coordinate', () =>
{
    assert.deepEqual(checkArticleEmbedContract(), []);
});

test('second target codec, provider request/result or dependency coordinate fails closed', () =>
{
    const mutations = [
        ['src/backend/AlternativeArticleEmbedTargetCodec.cs', 'public class AlternativeArticleEmbedTargetCodec {}', /exact-one target codec/u],
        ['src/backend/OtherArticleEmbedProviderRequest.cs', 'public record OtherArticleEmbedProviderRequest();', /exact-one provider request/u],
        ['src/backend/OtherArticleEmbedProviderResult.cs', 'public record OtherArticleEmbedProviderResult();', /exact-one provider result/u],
        ['src/backend/OtherArticleEmbedDependencyCoordinate.cs', 'public record OtherArticleEmbedDependencyCoordinate();', /exact-one dependency coordinate/u]
    ];
    for (const [relative, source, expected] of mutations)
    {
        assert.match(diagnostics((fixture) => fixture.set(relative, source)), expected);
    }
});

test('regex parser, aliases, remote paths, HTML results, DB identity and mode guessing fail closed', () =>
{
    const mutations = [
        [' Regex.Match(token, value);', /regular-expression target parsing/u],
        [' var alias = "::include";', /compatibility include or wikilink syntax/u],
        [' var remote = "https://example.test/embed";', /remote or file target/u],
        [' var html = new HtmlDocument();', /HTML or DOM provider payload/u],
        [' var mode = GuessTargetMode(token);', /mode inference or guessing/u],
        [' var id = DatabaseArticleId;', /database-id target identity/u]
    ];
    for (const [injected, expected] of mutations)
    {
        assert.match(
            diagnostics((fixture) => fixture.set(codecPath, `${fixture.get(codecPath)}\n${injected}\n`)),
            expected
        );
    }
});

test('FsusUI parser authority, required exact modes and shared consumers reject drift', () =>
{
    assert.match(
        diagnostics((fixture) =>
        {
            const schema = JSON.parse(fixture.get(schemaPath));
            schema['x-fsusblog-contract'].sourceGrammar.ownerPackage = '@blog/private-parser';
            fixture.set(schemaPath, JSON.stringify(schema));
        }),
        /exact FsusUI #290 parser ownership/u
    );
    assert.match(
        diagnostics((fixture) =>
        {
            const schema = JSON.parse(fixture.get(schemaPath));
            schema['x-fsusblog-contract'].sourceGrammar.modes.push('card');
            fixture.set(schemaPath, JSON.stringify(schema));
        }),
        /exact FsusUI #290 parser ownership/u
    );
    assert.match(
        diagnostics((fixture) =>
        {
            const schema = JSON.parse(fixture.get(schemaPath));
            schema['x-fsusblog-contract'].dependencyConsumers = ['article-relation'];
            fixture.set(schemaPath, JSON.stringify(schema));
        }),
        /relation, package and export must share/u
    );
});

test('unknown schema fields and forbidden provider payloads fail closed', () =>
{
    assert.match(
        diagnostics((fixture) =>
        {
            const schema = JSON.parse(fixture.get(schemaPath));
            schema.$defs.providerRequest.additionalProperties = true;
            fixture.set(schemaPath, JSON.stringify(schema));
        }),
        /providerRequest must remain closed/u
    );
    assert.match(
        diagnostics((fixture) =>
        {
            const schema = JSON.parse(fixture.get(schemaPath));
            schema.$defs.providerResult.properties.html = { type: 'string' };
            fixture.set(schemaPath, JSON.stringify(schema));
        }),
        /forbidden executable or UI payload/u
    );
    assert.match(
        diagnostics((fixture) => fixture.set(
            contractPath,
            fixture.get(contractPath).replace(
                'string ResultDigest);',
                'string ResultDigest, string Html);'
            )
        )),
        /provider result must not expose HTML/u
    );
});
