using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    [Flags]
    private enum PreviewSchema
    {
        Recovery = 1,
        Revisions = 2,
        Administration = 4,
        Publications = 8,
        Schedule = 16,
        Uploads = 32,
        Rights = 64
    }

    private static async Task<PreviewSchema> ReadPreviewSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx,
        CancellationToken ct)
    {
        await using var command = new NpgsqlCommand($"""
            select coalesce(sum(part),0)::integer from (values
                ({(int)PreviewSchema.Recovery},'public.authoring_recovery_site'),
                ({(int)PreviewSchema.Revisions},'public.article_rollback'),
                ({(int)PreviewSchema.Administration},'{CurrentSchema.AdminIdentityMarker}'),
                ({(int)PreviewSchema.Publications},'{CurrentSchema.PublicationHistoryRelation}'),
                ({(int)PreviewSchema.Schedule},'{CurrentSchema.ArticleScheduleRelation}'),
                ({(int)PreviewSchema.Uploads},'{CurrentSchema.MediaUploadRelation}'),
                ({(int)PreviewSchema.Rights},'{CurrentSchema.PublicationRightsRelation}')
            ) as components(part, relation) where pg_catalog.to_regclass(relation) is not null
            """, db, tx);
        return (PreviewSchema)(int)(await command.ExecuteScalarAsync(ct))!;
    }

    private static Task<bool> VerifyPreviewCatalogAsync(NpgsqlConnection db, NpgsqlTransaction tx, PreviewSchema shape,
        CancellationToken ct, bool legacyCanvas = false, bool requireCanvasHistory = true,
        int adminIdentityVersion = CurrentSchema.AdminIdentityVersion) =>
        CurrentSchema.VerifyCatalogAsync(db, tx, ct,
            shape.HasFlag(PreviewSchema.Recovery), shape.HasFlag(PreviewSchema.Revisions),
            shape.HasFlag(PreviewSchema.Administration), shape.HasFlag(PreviewSchema.Publications),
            shape.HasFlag(PreviewSchema.Schedule), shape.HasFlag(PreviewSchema.Uploads), legacyCanvas, adminIdentityVersion,
            requirePublicationRights: shape.HasFlag(PreviewSchema.Rights), requireCanvasHistory: requireCanvasHistory);

    private static async Task<PreviewSchema> InstallPreviewSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx,
        PreviewSchema component, string script, CancellationToken ct)
    {
        var shape = await ReadPreviewSchemaAsync(db, tx, ct);
        if (!shape.HasFlag(component))
        {
            var webp = await VerifyPreviewCatalogAsync(db, tx, shape, ct);
            await ApplySchemaAddition(db, tx, script, ct);
            if (component == PreviewSchema.Uploads && webp)
                await AllowWebpFormatAsync(db, tx, "private_media_upload", ct);
            shape |= component;
        }
        await VerifyPreviewCatalogAsync(db, tx, shape, ct);
        await VerifyPreviewIdentityAsync(db, tx, shape, ct,
            adminFirst: component is PreviewSchema.Recovery or PreviewSchema.Revisions);
        return shape;
    }

    private static async Task VerifyPreviewIdentityAsync(NpgsqlConnection db, NpgsqlTransaction tx, PreviewSchema shape,
        CancellationToken ct, bool adminFirst = false)
    {
        var admin = shape.HasFlag(PreviewSchema.Administration);
        if (adminFirst && admin) await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        if (shape.HasFlag(PreviewSchema.Recovery)) await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct);
        if (!adminFirst && admin) await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
    }
}
