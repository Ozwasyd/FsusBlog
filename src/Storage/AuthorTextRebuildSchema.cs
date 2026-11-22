using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts AuthorTextRebuildShape = Table(
        "author_text_rebuild_job owner_id:uuid profile:int4 definition_id:uuid owner_generation:int8 schema_revision:int8 definition_revision:int8 available_at:timestamptz",
        "f owner_id public.admin_principal:id",
        "c profile profile>=1ANDprofile<=4",
        "c owner_generation owner_generation>0",
        "c schema_revision,definition_revision schema_revision>=definition_revision",
        "c definition_revision definition_revision>=0",
        "c available_at isfinite(available_at)",
        "p owner_id,profile,definition_id",
        "u available_at,owner_id,profile,definition_id");

    private const string AuthorTextRebuildRelation = "public.author_text_rebuild_job";

    internal static Task<bool> HasAuthorTextRebuildAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, AuthorTextRebuildRelation, ct);
}
