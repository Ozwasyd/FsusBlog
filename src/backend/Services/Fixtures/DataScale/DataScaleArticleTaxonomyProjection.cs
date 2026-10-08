using System.Globalization;
using System.Reflection;

using FsusBlog.Server.Entities;

using SqlSugar;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

internal sealed record DataScaleArticleTaxonomySchema(
    DataScaleEntityTransportBinding ArticleTag,
    DataScaleEntityTransportBinding Category,
    DataScaleEntityTransportBinding Tag);
internal sealed record DataScaleOwnedRowScope(int Column, IReadOnlyList<long> Values);
internal sealed record DataScaleExternalReferenceKeys(string Table, DataScaleBulkColumn Key, IReadOnlyList<long> Values);

/// <summary>
/// Copies current taxonomy from canonical row/pointer outputs to the existing ArticleTag model.
/// Historical taxonomy stays in the canonical revision snapshot. No taxonomy or native IDs are invented.
/// Category/tag authorities remain external: every referenced key must actually exist at verification.
/// </summary>
internal static class DataScaleArticleTaxonomyProjection
{
    internal static DataScaleArticlePhysicalBatch Attach(ArticleScalePlan plan,
        IReadOnlyList<ArticleScaleArticleGraph> graphs,
        IReadOnlyDictionary<string, ArticleScaleGraphIdentityBindings> identities,
        DataScaleArticleTaxonomySchema schema, DataScaleArticlePhysicalBatch batch)
    {
        Validate<ArticleTag>(schema.ArticleTag);
        Validate<Category>(schema.Category);
        Validate<Tag>(schema.Tag);
        var links = new List<IReadOnlyList<object?>>();
        var articles = new List<long>();
        var categories = new HashSet<long>();
        var tags = new HashSet<long>();
        foreach (ArticleScaleArticleGraph graph in graphs)
        {
            CanonicalArticleGraphVerifier.VerifyArticleGraph(plan, graph).ThrowIfInvalid();
            long articleId = identities[graph.SemanticArticleId].Resolve(graph.SemanticArticleId);
            articles.Add(articleId);
            ArticleScaleRowPlan article = graph.Rows.Single(row => row.Kind == ArticleScaleRowKind.Article);
            string revision = graph.Pointers.Single(pointer => pointer.Kind == ArticleScalePointerKind.CurrentRevision).TargetSemanticId;
            ArticleScaleRowPlan[] taxonomy = graph.Rows.Where(row => row.Kind == ArticleScaleRowKind.ArticleTaxonomyReference).ToArray();
            ArticleScaleRowPlan current = taxonomy.Single(row => (string)row.Fields["RevisionSemanticId"]! == revision);
            if (Convert.ToInt32(article.Fields["CategoryId"], CultureInfo.InvariantCulture)
                != Convert.ToInt32(current.Fields["CategoryId"], CultureInfo.InvariantCulture))
            {
                throw new InvalidOperationException("taxonomy_current_category_pointer_mismatch");
            }
            foreach (ArticleScaleRowPlan reference in taxonomy)
            {
                int category = Convert.ToInt32(reference.Fields["CategoryId"], CultureInfo.InvariantCulture);
                if (category <= 0 || reference.Fields["TagIds"] is not IReadOnlyList<int> nativeTags
                    || nativeTags.Count > 256 || nativeTags.Any(id => id <= 0) || nativeTags.Distinct().Count() != nativeTags.Count)
                {
                    throw new InvalidOperationException("taxonomy_native_reference_shape_invalid");
                }
                categories.Add(category);
                tags.UnionWith(nativeTags.Select(id => (long)id));
            }
            foreach (int tag in (IReadOnlyList<int>)current.Fields["TagIds"]!)
            {
                links.Add(new object?[] { checked((int)articleId), tag });
            }
        }
        if (links.Count > 50_000 || batch.Tables.Sum(table => (long)table.Rows.Count) + links.Count > 50_000)
        {
            throw new InvalidOperationException("taxonomy_physical_batch_bound_exceeded");
        }
        var composite = new Dictionary<string, IReadOnlyList<int>>(batch.CompositePrimaryKeyColumns, StringComparer.Ordinal)
        {
            [schema.ArticleTag.Table] = new[] { 0, 1 }
        };
        var scopes = new Dictionary<string, DataScaleOwnedRowScope>(batch.OwnedRowScopes, StringComparer.Ordinal)
        {
            [schema.ArticleTag.Table] = new(0, Array.AsReadOnly(articles.Order().ToArray()))
        };
        return batch with
        {
            Tables = batch.Tables.Concat(new[] { new DataScaleBulkTableRows(schema.ArticleTag.Table,
                [new(schema.ArticleTag.Columns[nameof(ArticleTag.ArticleId)], System.Data.DbType.Int32),
                 new(schema.ArticleTag.Columns[nameof(ArticleTag.TagId)], System.Data.DbType.Int32)], links) }).ToArray(),
            CompositePrimaryKeyColumns = composite,
            OwnedRowScopes = scopes,
            ExternalReferences = [new(schema.Category.Table, new(schema.Category.Columns[nameof(Category.Id)], System.Data.DbType.Int32),
                    Array.AsReadOnly(categories.Order().ToArray())),
                new(schema.Tag.Table, new(schema.Tag.Columns[nameof(Tag.Id)], System.Data.DbType.Int32),
                    Array.AsReadOnly(tags.Order().ToArray()))],
            LogicalReferences = batch.LogicalReferences.Where(row => row.Kind != ArticleScaleRowKind.ArticleTaxonomyReference).ToArray()
        };
    }

    private static void Validate<TEntity>(DataScaleEntityTransportBinding binding)
    {
        Type model = typeof(TEntity);
        string owner = (string)model.GetCustomAttributesData().Single(attribute => attribute.AttributeType == typeof(SugarTable))
            .ConstructorArguments[0].Value!;
        // The existing SqlSugarInitializer explicitly enables PgSqlIsAutoToLowerCodeFirst.
        // Prepared metadata must use either the literal model owner or that existing lower-case spelling.
        if (binding.Table != owner && binding.Table != owner.ToLowerInvariant())
        {
            throw new InvalidOperationException("taxonomy_table_owner_mismatch");
        }
        PropertyInfo[] properties = model.GetProperties().Where(property => property.GetCustomAttribute<SugarColumn>()?.IsIgnore != true).ToArray();
        if (!properties.Select(property => property.Name).ToHashSet(StringComparer.Ordinal).SetEquals(binding.Columns.Keys)
            || binding.Columns.Values.Distinct(StringComparer.Ordinal).Count() != binding.Columns.Count)
        {
            throw new InvalidOperationException("taxonomy_prepared_property_coverage_mismatch");
        }
        DataScaleProviderBulkTransport.ValidateIdentifier(binding.Table);
        foreach (string column in binding.Columns.Values)
        {
            DataScaleProviderBulkTransport.ValidateIdentifier(column);
        }
    }
}
