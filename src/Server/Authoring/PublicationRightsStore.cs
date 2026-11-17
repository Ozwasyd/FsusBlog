using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal static class PublicationRightsStore
{
    internal static async Task<ArticleRightsPolicy> Read(NpgsqlConnection db, NpgsqlTransaction tx,
        int article, long revision, CancellationToken ct)
    {
        await using var read = SqlCommands.Create(db, tx, """
            select enabled,license_type,copyright_holder,copyright_year,rights_statement,attribution_template,
                   copy_policy,max_excerpt_chars,allow_code_copy,show_public_badge,proof_binding_enabled
            from public.article_revision_rights where article_id=$1 and revision=$2
            """, article, revision);
        await using var row = await read.ExecuteReaderAsync(ct);
        return await row.ReadAsync(ct) ? ReadPolicy(row, 0, article, revision) : Wire.MissingRights(article, revision);
    }

    // The selected columns are shared by the private reader and the public projection.
    internal static ArticleRightsPolicy ReadPolicy(NpgsqlDataReader row, int offset, int article, long revision)
    {
        var value = new ArticleRightsPolicy(article, revision, true, row.GetBoolean(offset), row.GetString(offset + 1),
            row.GetString(offset + 2), row.GetInt32(offset + 3), row.GetString(offset + 4), row.GetString(offset + 5),
            row.GetString(offset + 6), row.GetInt32(offset + 7), row.GetBoolean(offset + 8),
            row.GetBoolean(offset + 9), row.GetBoolean(offset + 10));
        Wire.Validate(value);
        return value;
    }

    internal static async Task Insert(NpgsqlConnection db, NpgsqlTransaction tx, ArticleRightsPolicy policy, CancellationToken ct)
    {
        Wire.Validate(policy);
        if (!policy.Present) throw new InvalidOperationException("Cannot persist an absent rights policy.");
        await using var add = SqlCommands.Create(db, tx, """
            insert into public.article_revision_rights
                (article_id,revision,enabled,license_type,copyright_holder,copyright_year,rights_statement,attribution_template,
                 copy_policy,max_excerpt_chars,allow_code_copy,show_public_badge,proof_binding_enabled)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            """, policy.Id, policy.Revision, policy.Enabled, policy.LicenseType, policy.CopyrightHolder, policy.CopyrightYear,
            policy.RightsStatement, policy.AttributionTemplate, policy.CopyPolicy, policy.MaxExcerptChars, policy.AllowCodeCopy,
            policy.ShowPublicBadge, policy.ProofBindingEnabled);
        await add.ExecuteNonQueryAsync(ct);
    }

    internal static async Task CarryForward(NpgsqlConnection db, NpgsqlTransaction tx, int article, long source, long target, CancellationToken ct)
    {
        await using var copy = SqlCommands.Create(db, tx, """
            insert into public.article_revision_rights
            select article_id,$3,enabled,license_type,copyright_holder,copyright_year,rights_statement,attribution_template,
                   copy_policy,max_excerpt_chars,allow_code_copy,show_public_badge,proof_binding_enabled
            from public.article_revision_rights where article_id=$1 and revision=$2
            """, article, source, target);
        await copy.ExecuteNonQueryAsync(ct);
    }

    internal static async Task Require(NpgsqlConnection db, NpgsqlTransaction tx, int article, long revision, CancellationToken ct)
    {
        if (!(await Read(db, tx, article, revision, ct)).Present)
            throw new BusinessException(Rejection.Conflict, "Save an explicit rights policy before publishing this revision.");
    }

    internal static async Task Attach(NpgsqlConnection db, NpgsqlTransaction tx, int article, long revision, long publication, CancellationToken ct)
    {
        await using var add = SqlCommands.Create(db, tx, """
            insert into public.article_publication_rights(article_id,publication_id,revision) values($1,$2,$3)
            """, article, publication, revision);
        await add.ExecuteNonQueryAsync(ct);
    }
}
