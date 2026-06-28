using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class TaxonomyFrameProjectionContractTests
{
    [Fact]
    public void BinaryTaxonomyFrames_ReadProjectionTablesWithoutArticleJoinColdMiss()
    {
        string taxonomy = ReadRepoFile("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Taxonomy.cs");
        string categoryGet = ExtractRouteBlock(taxonomy, "group.MapGet(\"/category\"");
        string tagGet = ExtractRouteBlock(taxonomy, "group.MapGet(\"/tag\"");
        string projector = ReadRepoFile("src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactProjector.cs");
        string projectorCategoryFrame = ExtractMethodBlock(projector, "private async Task<PublicBinaryArtifact> BuildCategoryFrameAsync");
        string projectorTagFrame = ExtractMethodBlock(projector, "private async Task<PublicBinaryArtifact> BuildTagFrameAsync");
        string observability = ReadRepoFile("src/backend/Infrastructure/Observability/FsusObservability.cs");

        Assert.Contains("CategoryPublicArticleCount", categoryGet, StringComparison.Ordinal);
        Assert.Contains("TagPublicArticleCount", tagGet, StringComparison.Ordinal);
        Assert.DoesNotContain(".LeftJoin<Article>", categoryGet, StringComparison.Ordinal);
        Assert.DoesNotContain(".LeftJoin<ArticleTag>", tagGet, StringComparison.Ordinal);
        Assert.DoesNotContain(".LeftJoin<Article>", tagGet, StringComparison.Ordinal);
        Assert.DoesNotContain(".GroupBy", categoryGet, StringComparison.Ordinal);
        Assert.DoesNotContain(".GroupBy", tagGet, StringComparison.Ordinal);
        Assert.Contains("CategoryPublicArticleCount", projectorCategoryFrame, StringComparison.Ordinal);
        Assert.Contains("TagPublicArticleCount", projectorTagFrame, StringComparison.Ordinal);
        Assert.DoesNotContain(".LeftJoin<Article>", projectorCategoryFrame, StringComparison.Ordinal);
        Assert.DoesNotContain(".LeftJoin<ArticleTag>", projectorTagFrame, StringComparison.Ordinal);
        Assert.DoesNotContain(".LeftJoin<Article>", projectorTagFrame, StringComparison.Ordinal);
        Assert.DoesNotContain(".GroupBy", projectorCategoryFrame, StringComparison.Ordinal);
        Assert.DoesNotContain(".GroupBy", projectorTagFrame, StringComparison.Ordinal);

        Assert.Contains("RecordTaxonomyFrameCache", taxonomy, StringComparison.Ordinal);
        Assert.Contains("RecordTaxonomyFrameColdMiss", taxonomy, StringComparison.Ordinal);
        Assert.Contains("fsus.taxonomy.frame.cache_access", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.taxonomy.frame.cold_miss_elapsed_ms", observability, StringComparison.Ordinal);
    }

    [Fact]
    public void TaxonomyProjection_ServiceSchemaAndMutationHooksAreRegistered()
    {
        string service = ReadRepoFile("src/backend/Services/Taxonomy/TaxonomyCountProjectionService.cs");
        string migration = ReadRepoFile("src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs");
        string bootstrap = ReadRepoFile("src/backend/Infrastructure/Bootstrap/RuntimeInfrastructureServiceCollectionExtensions.cs");
        string sideEffects = ReadRepoFile("src/backend/Services/ArticleMutationSideEffects.cs");
        string observability = ReadRepoFile("src/backend/Infrastructure/Observability/FsusObservability.cs");

        Assert.Contains("category_public_article_count", migration, StringComparison.Ordinal);
        Assert.Contains("tag_public_article_count", migration, StringComparison.Ordinal);
        Assert.Contains("ITaxonomyCountProjectionService", service, StringComparison.Ordinal);
        Assert.Contains("ReconcileArticleAsync", service, StringComparison.Ordinal);
        Assert.Contains("BumpFrameVersionAsync", service, StringComparison.Ordinal);
        Assert.Contains("AddScoped<ITaxonomyCountProjectionService, TaxonomyCountProjectionService>", bootstrap, StringComparison.Ordinal);
        Assert.Contains("taxonomyProjection.ReconcileArticleAsync", sideEffects, StringComparison.Ordinal);
        Assert.Contains("RecordTaxonomyProjectionUpdate", service, StringComparison.Ordinal);
        Assert.Contains("fsus.taxonomy.projection.update_count", observability, StringComparison.Ordinal);
    }

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static string ExtractRouteBlock(string source, string marker)
    {
        int start = source.IndexOf(marker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Could not find route marker {marker}");
        int end = source.IndexOf("        })\n        .AllowAnonymous()", start, StringComparison.Ordinal);
        Assert.True(end > start, $"Could not find anonymous route terminator for {marker}");
        return source[start..end];
    }

    private static string ExtractMethodBlock(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Could not find method {signature}");
        int bodyStart = source.IndexOf('{', start);
        Assert.True(bodyStart > start, $"Could not find body for {signature}");
        int depth = 0;
        for (int i = bodyStart; i < source.Length; i++)
        {
            if (source[i] == '{')
            {
                depth++;
            }
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return source[start..(i + 1)];
                }
            }
        }

        throw new InvalidOperationException($"Could not extract method {signature}");
    }
}
