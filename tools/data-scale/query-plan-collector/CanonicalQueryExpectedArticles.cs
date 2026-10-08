using System.Globalization;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Services.Fixtures.DataScale;

// A read-only projection of the original factory, never a fixture writer or admission authority.
internal static class CanonicalQueryExpectedArticles
{
    private static readonly JsonSerializerOptions s_json = new(JsonSerializerDefaults.Web);

    internal static async Task ExportAsync(string planPath, string mappingPath, string epoch, string sourceCommit, string outputPath)
    {
        CurrentSchemaTestMaterializer.ValidateAssemblySourceCommit(sourceCommit);
        ArticleScalePlan plan = JsonSerializer.Deserialize<ArticleScalePlan>(await File.ReadAllTextAsync(planPath), s_json)
            ?? throw new InvalidOperationException("canonical plan missing");
        using JsonDocument mapping = JsonDocument.Parse(await File.ReadAllTextAsync(mappingPath));
        QueryPlanCollector.WritePrivate(outputPath, Project(plan, mapping.RootElement, epoch, sourceCommit));
    }

    internal static object Project(ArticleScalePlan plan, JsonElement mapping, string epoch, string sourceCommit)
    {
        ArticleScalePlanValidator.Validate(plan, plan.Artifacts).ThrowIfInvalid();
        ArticleScaleGraphReceipt receipt = mapping.GetProperty("graphReceipt").Deserialize<ArticleScaleGraphReceipt>(s_json)
            ?? throw new InvalidOperationException("canonical graph receipt missing");
        CanonicalArticleGraphVerifier.VerifyReceipt(plan, receipt).ThrowIfInvalid();
        if (mapping.GetProperty("sourceCommit").GetString() != sourceCommit
            || mapping.GetProperty("businessEpochUtc").GetString() != epoch
            || mapping.GetProperty("planDigest").GetString() != ArticleScalePlanDigest.Compute(plan))
        {
            throw new InvalidOperationException("canonical mapping binding mismatch");
        }
        DateTime now = DateTimeOffset.Parse(epoch, CultureInfo.InvariantCulture).UtcDateTime;
        string runId = mapping.GetProperty("dataScaleRunId").GetString()!;
        string generation = mapping.GetProperty("fixtureGeneration").GetString()!;
        string seedDigest = mapping.GetProperty("seedReceiptDigest").GetString()!;
        if (string.IsNullOrWhiteSpace(runId) || string.IsNullOrWhiteSpace(generation)
            || !System.Text.RegularExpressions.Regex.IsMatch(seedDigest, "^sha256:[0-9a-f]{64}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant))
        {
            throw new InvalidOperationException("canonical mapping fixture identity missing");
        }
        JsonElement[] keys = mapping.GetProperty("keys").EnumerateArray().ToArray();
        var keysBySemanticId = keys.ToDictionary(key => key.GetProperty("semanticId").GetString()!, StringComparer.Ordinal);
        var ids = keys.ToDictionary(key => key.GetProperty("semanticId").GetString()!, key => key.GetProperty("id").GetString()!, StringComparer.Ordinal);
        if (ids.Values.Any(id => !long.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out long value) || value <= 0)
            || keys.GroupBy(key => key.GetProperty("kind").GetString()).Any(group => group.Select(key => key.GetProperty("id").GetString()).Distinct().Count() != group.Count()))
        {
            throw new InvalidOperationException("canonical mapping ID invalid or duplicated");
        }
        JsonElement[] categories = mapping.GetProperty("categories").EnumerateArray().ToArray();
        JsonElement[] tags = mapping.GetProperty("tags").EnumerateArray().ToArray();
        int TaxonomyId(JsonElement[] rows, int ordinal)
            => int.Parse(rows.Single(row => row.GetProperty("ordinal").GetInt32() == ordinal).GetProperty("id").GetString()!, CultureInfo.InvariantCulture);
        string Resolve(ArticleScaleRowPlan row)
        {
            JsonElement key = keysBySemanticId[row.SemanticId];
            if (key.GetProperty("kind").GetString() != row.Kind.ToString())
            {
                throw new InvalidOperationException("canonical mapping row kind mismatch");
            }
            return ids[row.SemanticId];
        }
        static DateTime? Time(ArticleScaleRowPlan row, string name)
            => row.Fields[name] is string value ? DateTimeOffset.Parse(value, CultureInfo.InvariantCulture).UtcDateTime : null;
        var articles = new List<object>();
        var usedKeys = new HashSet<string>(StringComparer.Ordinal);
        using var graphHasher = System.Security.Cryptography.IncrementalHash.CreateHash(System.Security.Cryptography.HashAlgorithmName.SHA256);
        foreach (ArticleScaleArticleGraph graph in CanonicalArticleGraphFactory.GenerateGraphStream(plan))
        {
            CanonicalArticleGraphVerifier.VerifyArticleGraph(plan, graph).ThrowIfInvalid();
            graphHasher.AppendData(System.Text.Encoding.UTF8.GetBytes(graph.ArticleDigest));
            foreach (ArticleScaleRowPlan row in graph.Rows)
            {
                Resolve(row);
                usedKeys.Add(row.SemanticId);
            }
            ArticleScaleRowPlan article = graph.Rows.Single(row => row.Kind == ArticleScaleRowKind.Article);
            if (!ArticlePublication.IsPubliclyVisible((ArticleStatus)(int)article.Fields["Status"]!, (bool)article.Fields["IsDeleted"]!,
                Time(article, "PublishedAt"), Time(article, "ScheduledPublishAt"), now))
            {
                continue;
            }
            string publicationId = (string?)article.Fields["CurrentPublicationId"]
                ?? throw new InvalidOperationException("public canonical publication pointer missing");
            ArticleScaleRowPlan publication = graph.Rows.Single(row => row.SemanticId == publicationId);
            ArticleScaleRowPlan revision = graph.Rows.Single(row => row.SemanticId == (string)publication.Fields["RevisionSemanticId"]!);
            ArticleScaleRowPlan content = graph.Rows.Single(row => row.SemanticId == (string)revision.Fields["ContentBlockSemanticId"]!);
            articles.Add(new
            {
                id = int.Parse(Resolve(article), CultureInfo.InvariantCulture),
                title = revision.Fields["Title"],
                body = content.Fields["MarkdownContent"],
                createTime = Time(article, "CreateTime")!.Value.ToString("O"),
                categoryId = TaxonomyId(categories, (int)revision.Fields["CategoryId"]!),
                tagIds = ((string)revision.Fields["TagIds"]!).Split(',', StringSplitOptions.RemoveEmptyEntries)
                    .Select(value => TaxonomyId(tags, int.Parse(value, CultureInfo.InvariantCulture))).ToArray()
            });
        }
        string graphDigest = "sha256:" + Convert.ToHexStringLower(graphHasher.GetHashAndReset());
        if (graphDigest != receipt.SemanticGraphDigest || usedKeys.Count != ids.Count)
        {
            throw new InvalidOperationException("canonical graph or mapping inventory mismatch");
        }
        return new
        {
            schema = "fsusblog.data-scale-query-expected-articles.v1",
            qualification = "not-performed",
            sourceCommit,
            dataScaleRunId = runId,
            fixtureGeneration = generation,
            seedReceiptDigest = seedDigest,
            businessEpochUtc = epoch,
            tier = plan.ScaleTier,
            factoryId = ArticleScaleContractIds.RequiredGraphFactory,
            planDigest = receipt.PlanDigest,
            graphDigest,
            publicArticles = articles,
            categories = categories.Select(row => new { id = int.Parse(row.GetProperty("id").GetString()!, CultureInfo.InvariantCulture), name = row.GetProperty("name").GetString() }).ToArray(),
            tags = tags.Select(row => new { id = int.Parse(row.GetProperty("id").GetString()!, CultureInfo.InvariantCulture), name = row.GetProperty("name").GetString() }).ToArray()
        };
    }
}
