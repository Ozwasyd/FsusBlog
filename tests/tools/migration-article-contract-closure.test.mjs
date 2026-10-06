import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('offline article consumers resolve one Shared contract source without a runtime project dependency', () =>
{
    for (const file of ['PolicyExporter', 'Producer', 'Projection', 'StorageProgram', 'WritePlan'])
    {
        assert.match(read(`src/migration/ArticlePreservation${file}.cs`), /using FsusBlog.Contracts.Articles;/u);
    }
    const project = read('src/migration/FsusBlog.Migration.csproj');
    assert.match(project, /ProjectReference Include="\.\.\\shared\\FsusBlog.Shared.csproj"/u);
    assert.doesNotMatch(project, /FsusBlog\.(?:Core|Server)\.csproj/u);
    for (const projectPath of ['src/core/FsusBlog.Core.csproj', 'src/shared/FsusBlog.Shared.csproj'])
    {
        assert.doesNotMatch(read(projectPath), /FsusBlog\.(?:Migration|Server)\.csproj/u);
    }
});

test('relocated article contracts have no duplicate former product implementation', () =>
{
    for (const former of [
        'src/core/Integrity/ArticleCanonicalHashV1.cs',
        'src/core/Integrity/ArticleRightsCanonicalHashV1.cs',
        'src/core/Services/Articles/ArticleStatusTransitionPolicy.cs',
        'src/backend/Services/Articles/ArticleProductionNormalizers.cs'
    ])
    {
        assert.equal(fs.existsSync(path.join(root, former)), false, former);
    }
    const contracts = read('src/shared/Contracts/Articles/ArticleResponsibilityContracts.cs');
    assert.match(contracts, /public sealed record ArticleResponsibilityDraft\(/u);
    assert.match(contracts, /public sealed record class PrepublishIssue\(/u);
    assert.doesNotMatch(read('src/backend/Infrastructure/Integrity/ArticleResponsibilityManifest.cs'), /public sealed record ArticleResponsibilityDraft\(/u);
    assert.doesNotMatch(read('src/backend/Models/Dtos/AuthoringDtos.cs'), /public sealed record class PrepublishIssue\(/u);
});

test('production wire and persistence consumers use their original distinct pure owners', () =>
{
    assert.match(read('src/core/Cache/PodBinaryCodec.Article.cs'), /ArticleProductionNormalizers.NormalizeWireArticleRights\(request.Rights\)/u);
    assert.match(read('src/backend/Services/Articles/ArticleRevisionContentBlockStore.cs'), /ArticleRevisionContentAddress.Compute\(markdownContent\)/u);
    assert.match(read('src/backend/Services/Articles/ArticleRevisionPersistence.cs'), /ArticleRevisionStorageEncoding.EncodeTagIds\(tagIds\)/u);
    assert.match(read('src/backend/Infrastructure/Integrity/ArticleResponsibilitySnapshotBuilder.cs'), /ArticleResponsibilityStorageEncoding.Encode\(draft\)/u);
    assert.match(read('src/backend/Services/Articles/ArticleRightsSnapshotBuilder.cs'), /ArticleRightsCanonicalBinding.Build\(/u);
});
