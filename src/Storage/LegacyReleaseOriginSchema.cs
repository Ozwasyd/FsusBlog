using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string LegacyReleaseOriginRelation = "public.legacy_release_origin";

    private static readonly SchemaFacts LegacyReleaseOriginShape = Table(
        "legacy_release_origin article_id:int4 revision:int8 publication_id:int8 source_revision_id:int8 source_actor_id:int8 source_rollback_revision_id:int8? rollback_reason:text? responsibility:jsonb? evidence:jsonb manifest:jsonb plan_sha256:text projection_sha256:text source_admin_identity_sha256:text",
        "p article_id,revision",
        "f article_id,revision public.article_revision:article_id,revision",
        "u publication_id");

    internal static Task<bool> HasLegacyReleaseOriginAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, LegacyReleaseOriginRelation, ct);
}
