namespace FsusBlog.Server.Services.Fixtures.DataScale;

public sealed record ArticleScaleNativeRoleRequirement(
    ArticleScaleRowKind Kind,
    string AllocationRole,
    IReadOnlyList<string> SemanticRoles);

public static partial class CanonicalArticleGraphFactory
{
    /// <summary>Canonical pre-sealing role/alias roster; contains no generated database IDs.</summary>
    public static IReadOnlyList<ArticleScaleNativeRoleRequirement> DescribeNativeRoles(
        ArticleScalePlan plan, IReadOnlyList<ArticleScaleArticleGraph> graphs)
    {
        ArticleScalePlanValidator.Validate(plan, plan.Artifacts).ThrowIfInvalid();
        if (graphs.Count is < 1 or > 1000 || graphs.Select(graph => graph.SemanticArticleId).Distinct().Count() != graphs.Count)
        {
            throw new InvalidOperationException("native_factory_batch_bound_or_article_duplicate");
        }
        foreach (ArticleScaleArticleGraph graph in graphs)
        {
            CanonicalArticleGraphVerifier.VerifyArticleGraph(plan, graph).ThrowIfInvalid();
        }
        var result = new List<ArticleScaleNativeRoleRequirement>();
        var rows = graphs.SelectMany(graph => graph.Rows).ToArray();
        foreach (ArticleScaleRowPlan row in rows.Where(row => row.Kind is not (ArticleScaleRowKind.ArticleBody
            or ArticleScaleRowKind.ArticleTaxonomyReference or ArticleScaleRowKind.ArticleAuditCoordinate
            or ArticleScaleRowKind.ArticleRevisionContentBlock)))
        {
            result.Add(new(row.Kind, row.SemanticId, Array.AsReadOnly(new[] { row.SemanticId })));
        }
        foreach (var aliases in rows.Where(row => row.Kind == ArticleScaleRowKind.ArticleRevisionContentBlock)
            .GroupBy(row => row.Fields["ContentHash"]))
        {
            foreach (string field in new[] { "ContentHash", "ByteLength", "MarkdownContent", "CreatedAt" })
            {
                if (aliases.Select(row => row.Fields[field]).Distinct().Count() != 1)
                {
                    throw new InvalidOperationException("native_factory_shared_block_values_mismatch");
                }
            }
            string[] roles = aliases.Select(row => row.SemanticId).Order(StringComparer.Ordinal).ToArray();
            result.Add(new(ArticleScaleRowKind.ArticleRevisionContentBlock, roles[0], Array.AsReadOnly(roles)));
        }
        if (result.Sum(group => (long)group.SemanticRoles.Count) > 50_000
            || result.SelectMany(group => group.SemanticRoles).Distinct(StringComparer.Ordinal).Count()
                != result.Sum(group => group.SemanticRoles.Count))
        {
            throw new InvalidOperationException("native_factory_role_bound_or_duplicate");
        }
        return result.AsReadOnly();
    }
}
