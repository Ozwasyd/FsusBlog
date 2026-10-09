using System.Globalization;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Counts current value facts under the definition owner's canonical mutation lock.</summary>
public sealed class PostgresArticlePropertyDefinitionValueImpactAuthority(ISqlSugarClient db)
    : IArticlePropertyDefinitionImpactAuthority
{
    public async Task<ArticlePropertyDefinitionImpact> GetImpactAsync(
        ArticlePropertyDefinitionOwner owner,
        ArticlePropertyDefinition? before,
        ArticlePropertyDefinition after,
        string commandKind,
        CancellationToken cancellationToken = default)
    {
        ArticlePropertyDefinitionContract.ValidateOwner(owner);
        ArticlePropertyDefinitionContract.ValidateDefinition(after);
        if (after.Owner != owner || before is not null && before.Owner != owner || db.Ado.Transaction is null)
        {
            throw new ArticlePropertyDefinitionIntegrityException("article_property_value_impact_transaction_required");
        }
        cancellationToken.ThrowIfCancellationRequested();
        if (before is null || commandKind == "rename")
        {
            return new(0, []);
        }
        object? count = await db.Ado.GetScalarAsync("""
            SELECT COUNT(*) FROM article_property_value_head h
            JOIN article_property_value_snapshot s ON s.snapshot_id = h.snapshot_id
            JOIN article_property_value_entry e ON e.factset_id = s.factset_id
            WHERE h.owner_user_key = @Owner AND h.site_scope = @Site AND e.definition_id = @Definition;
            """, new SugarParameter("@Owner", owner.UserId ?? 0), new SugarParameter("@Site", owner.SiteScope),
            new SugarParameter("@Definition", after.DefinitionId)).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        long affected = Convert.ToInt64(count, CultureInfo.InvariantCulture);
        return new(affected, affected == 0 ? [] :
            [new("article-property-definition-reconciliation", affected, true, "article_property_definition_changed")]);
    }
}
