using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private const string AuthorTextRebuildColumns =
        "author_text_rebuild_job owner_id:uuid profile:int4 definition_id:uuid owner_generation:int8 schema_revision:int8 definition_revision:int8 available_at:timestamptz";

    private static readonly string[] AuthorTextRebuildConstraints =
    [
        "author_text_rebuild_job f owner_id public.blog_user:id",
        "author_text_rebuild_job c profile profile>=1ANDprofile<=4",
        "author_text_rebuild_job c owner_generation owner_generation>0",
        "author_text_rebuild_job c schema_revision,definition_revision schema_revision>=definition_revision",
        "author_text_rebuild_job c definition_revision definition_revision>=0",
        "author_text_rebuild_job c available_at isfinite(available_at)",
        "author_text_rebuild_job p owner_id,profile,definition_id",
        "author_text_rebuild_job u available_at,owner_id,profile,definition_id"
    ];

    internal static Task<bool> HasAuthorTextRebuildAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, "public.author_text_rebuild_job", ct);
}
