using System.Data.Common;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Data;

using SqlSugar;

namespace FsusBlog.Server.Services.Articles;

/// <summary>
/// Production-shared article rights policy upsert used by ArticleService and fixture authority ports.
/// </summary>
public static class ArticleRightsPolicyPersistence
{
    public static async Task<long> UpsertAsync(
        ISqlSugarClient db,
        int articleId,
        ArticleRightsNormalizedModel rights,
        DateTime now,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(rights);

        ArticleRightsPolicy? current = await db.Queryable<ArticleRightsPolicy>()
            .Where(item => item.ArticleId == articleId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);
        if (current is not null && SamePolicy(current, rights))
        {
            return current.Id;
        }

        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            INSERT INTO article_rights_policy (
                article_id,
                enabled,
                license_type,
                copyright_holder,
                copyright_year,
                rights_statement,
                attribution_template,
                copy_policy,
                max_excerpt_chars,
                allow_code_copy,
                show_public_badge,
                proof_binding_enabled,
                created_at,
                updated_at
            )
            VALUES (
                @ArticleId,
                @Enabled,
                @LicenseType,
                @CopyrightHolder,
                @CopyrightYear,
                @RightsStatement,
                @AttributionTemplate,
                @CopyPolicy,
                @MaxExcerptChars,
                @AllowCodeCopy,
                @ShowPublicBadge,
                @ProofBindingEnabled,
                @Now,
                @Now
            )
            ON CONFLICT (article_id)
            DO UPDATE SET
                enabled = EXCLUDED.enabled,
                license_type = EXCLUDED.license_type,
                copyright_holder = EXCLUDED.copyright_holder,
                copyright_year = EXCLUDED.copyright_year,
                rights_statement = EXCLUDED.rights_statement,
                attribution_template = EXCLUDED.attribution_template,
                copy_policy = EXCLUDED.copy_policy,
                max_excerpt_chars = EXCLUDED.max_excerpt_chars,
                allow_code_copy = EXCLUDED.allow_code_copy,
                show_public_badge = EXCLUDED.show_public_badge,
                proof_binding_enabled = EXCLUDED.proof_binding_enabled,
                updated_at = EXCLUDED.updated_at
            RETURNING id;
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@Enabled", rights.Enabled),
            new SugarParameter("@LicenseType", rights.LicenseType),
            NullableStringParameter("@CopyrightHolder", rights.CopyrightHolder),
            NullableInt32Parameter("@CopyrightYear", rights.CopyrightYear),
            NullableStringParameter("@RightsStatement", rights.RightsStatement),
            NullableStringParameter("@AttributionTemplate", rights.AttributionTemplate),
            new SugarParameter("@CopyPolicy", rights.CopyPolicy),
            new SugarParameter("@MaxExcerptChars", rights.MaxExcerptChars),
            new SugarParameter("@AllowCodeCopy", rights.AllowCodeCopy),
            new SugarParameter("@ShowPublicBadge", rights.ShowPublicBadge),
            new SugarParameter("@ProofBindingEnabled", rights.ProofBindingEnabled),
            new SugarParameter("@Now", now)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidOperationException($"Article rights policy was not upserted for article {articleId}.");
        }

        return reader.ReadInt64("id");
    }

    public static bool SamePolicy(ArticleRightsPolicy policy, ArticleRightsNormalizedModel rights)
        => policy.Enabled == rights.Enabled
            && string.Equals(policy.LicenseType, rights.LicenseType, StringComparison.Ordinal)
            && string.Equals(policy.CopyrightHolder, rights.CopyrightHolder, StringComparison.Ordinal)
            && policy.CopyrightYear == rights.CopyrightYear
            && string.Equals(policy.RightsStatement, rights.RightsStatement, StringComparison.Ordinal)
            && string.Equals(policy.AttributionTemplate, rights.AttributionTemplate, StringComparison.Ordinal)
            && string.Equals(policy.CopyPolicy, rights.CopyPolicy, StringComparison.Ordinal)
            && policy.MaxExcerptChars == rights.MaxExcerptChars
            && policy.AllowCodeCopy == rights.AllowCodeCopy
            && policy.ShowPublicBadge == rights.ShowPublicBadge
            && policy.ProofBindingEnabled == rights.ProofBindingEnabled;

    private static SugarParameter NullableStringParameter(string name, string? value)
        => new(name, (object?)value ?? DBNull.Value, System.Data.DbType.String);

    private static SugarParameter NullableInt32Parameter(string name, int? value)
        => new(name, (object?)value ?? DBNull.Value, System.Data.DbType.Int32);
}
