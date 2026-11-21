using System.Data;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Cli
{
    private const int PublicationMediaObjectLimit = 20 * 1024 * 1024;

    private static async Task VerifyOrRebuildPublicationMediaAsync(NpgsqlConnection db, bool rebuild,
        string site, string privateRoot, string publicRoot, string webRoot, CancellationToken ct)
    {
        if (!Guid.TryParseExact(site, "D", out var expectedSite) || expectedSite == Guid.Empty)
            throw new ArgumentException("Supply the expected durable site UUID.");
        if (!Path.IsPathFullyQualified(privateRoot) || !Path.IsPathFullyQualified(publicRoot) ||
            !Path.IsPathFullyQualified(webRoot) || !Directory.Exists(webRoot))
            throw new ArgumentException("Supply absolute existing private media, public media and web directories.");

        await using var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await using (var writer = new NpgsqlCommand("SELECT NOT pg_catalog.pg_is_in_recovery()", db, tx))
            if (await writer.ExecuteScalarAsync(ct) is not true)
                throw new InvalidOperationException("Publication media recovery requires an offline primary database.");
        // Read the references after the handoff is drained. An older repeatable-read snapshot can omit an admitted commit.
        await PrepareStoppedOperationAsync(db, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, new CatalogVerificationOptions
        {
            Media = new() { ArticleMedia = true, PublicationMedia = true }
        });
        await ExecuteAsync(db, tx, """
            LOCK TABLE public.authoring_recovery_site, public.article, public.article_publication,
                public.article_publication_history, public.article_publication_media, public.article_revision_media, public.private_media
            IN SHARE MODE
            """, ct);
        if (await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct) != expectedSite)
            throw new InvalidOperationException("The database does not match the expected site.");
        await VerifyActivePublicationsAsync(db, tx, ct);
        await VerifyPublicationHistoryAsync(db, tx, ct);
        await VerifyPublicationMediaAsync(db, tx, ct);

        var forbidden = new List<string> { webRoot, Path.Combine(webRoot, "assets"), Path.Combine(webRoot, "dist") };
        if (Environment.GetEnvironmentVariable("FSUSBLOG_APPEARANCE_ROOT") is { Length: > 0 } appearance)
            forbidden.Add(appearance);
        using var sources = new MediaObjectDirectory(privateRoot, PublicationMediaObjectLimit, [.. forbidden, publicRoot]);
        using var objects = new MediaObjectDirectory(publicRoot, PublicationMediaObjectLimit, [.. forbidden, privateRoot]);

        var verified = await RecoverPublicationMediaObjectsAsync(db, tx, sources, objects, rebuild, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine(JsonSerializer.Serialize(verified, Json));
    }

    private static async Task<PublicationMediaRecovery> RecoverPublicationMediaObjectsAsync(NpgsqlConnection db,
        NpgsqlTransaction tx, MediaObjectDirectory sources, MediaObjectDirectory objects, bool rebuild, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            SELECT DISTINCT content_hash,asset_id,format,length,width,height
            FROM public.article_publication_media
            ORDER BY content_hash,asset_id
            """, db, tx);
        await using var rows = await command.ExecuteReaderAsync(ct);
        string? verifiedDigest = null;
        long checkedSources = 0;
        long checkedObjects = 0;
        long rebuiltObjects = 0;
        while (await rows.ReadAsync(ct))
        {
            var digest = rows.GetFieldValue<byte[]>(0);
            var source = rows.GetGuid(1);
            var image = new PublishedArticleImage(Convert.ToHexStringLower(digest), rows.GetInt16(2),
                rows.GetInt32(3), rows.GetInt32(4), rows.GetInt32(5));
            if (!image.Valid())
                throw new InvalidOperationException("A publication media record has invalid normalized image metadata.");

            var sourceBytes = await sources.Read($"{source:N}.media", image.Length, digest, ct);
            if (sourceBytes is null || !PublishedArticleImage.MatchesFormat(sourceBytes, image.Format))
                throw new IOException("A retained private source is missing or has an unexpected format.");
            checkedSources++;

            if (string.Equals(verifiedDigest, image.Digest, StringComparison.Ordinal)) continue;
            var leaf = image.Digest + ".media";
            var publicBytes = await objects.Read(leaf, image.Length, digest, ct);
            if (publicBytes is null && rebuild)
            {
                await objects.Materialize(leaf, sourceBytes, digest, ct);
                publicBytes = await objects.Read(leaf, image.Length, digest, ct);
                rebuiltObjects++;
            }
            if (publicBytes is null || !PublishedArticleImage.MatchesFormat(publicBytes, image.Format))
                throw new IOException("A committed public media object is missing or has an unexpected format.");
            verifiedDigest = image.Digest;
            checkedObjects++;
        }

        return new PublicationMediaRecovery(checkedSources, checkedObjects, rebuiltObjects);
    }

    private sealed record PublicationMediaRecovery(long CheckedSources, long CheckedObjects, long RebuiltObjects);
}
