using System.Buffers.Binary;
using System.Security.Cryptography;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Content;

internal sealed class PublishedMediaSelection
{
    private PublishedMediaSelection(Guid[] assets) => Assets = assets;

    internal Guid[] Assets { get; }

    internal static PublishedMediaSelection Create(IReadOnlyList<Guid> assets)
    {
        if (assets.Count is < 1 or > ArticleMediaStore.Maximum)
            throw new BusinessException(Rejection.Invalid, "Select one to 32 attached images.");
        var canonical = assets.ToArray();
        Array.Sort(canonical);
        for (var i = 0; i < canonical.Length; i++)
        {
            if (canonical[i] == Guid.Empty || i > 0 && canonical[i] == canonical[i - 1])
                throw new BusinessException(Rejection.Invalid, "Selected image IDs must be valid and distinct.");
        }
        return new PublishedMediaSelection(canonical);
    }

    internal byte[] Fingerprint(Edit edit)
    {
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        sha.AppendData("fsusblog:publish-article-images:v1\0"u8);
        Span<byte> field = stackalloc byte[16];
        BinaryPrimitives.WriteInt32LittleEndian(field, edit.Id);
        BinaryPrimitives.WriteInt64LittleEndian(field[4..], edit.ExpectedRevision);
        sha.AppendData(field[..12]);
        foreach (var asset in Assets)
        {
            asset.TryWriteBytes(field, bigEndian: true, out _);
            sha.AppendData(field);
        }
        return sha.GetHashAndReset();
    }
}

internal sealed record PublishedMediaReference(Guid AssetId, byte[] Digest, MediaFormat Format,
    int Length, int Width, int Height);

internal sealed class PublishedMediaStore(MediaFiles privateFiles, string publicRoot, string webRoot,
    params string[] otherForbiddenRoots) : IDisposable
{
    private readonly MediaObjectDirectory objects = new(publicRoot, MediaImage.MaxBytes,
        [privateFiles.Root, webRoot, Path.Combine(webRoot, "assets"), Path.Combine(webRoot, "dist"), .. otherForbiddenRoots]);

    internal async Task<IReadOnlyList<PublishedMediaReference>> Prepare(NpgsqlConnection db, NpgsqlTransaction tx,
        Identity owner, Edit edit, PublishedMediaSelection selection, CancellationToken ct)
    {
        var images = await ReadSelected(db, tx, owner.Id, edit, selection, ct);
        foreach (var image in images)
        {
            var bytes = await privateFiles.Read(image.AssetId, image.Length, image.Digest, ct);
            if (bytes is null || !MatchesFormat(bytes, image.Format))
                throw new IOException("The retained private source is missing or has an unexpected format.");
            await objects.Materialize(Name(image.Digest), bytes, image.Digest, ct);
        }
        return images;
    }

    private static async Task<PublishedMediaReference[]> ReadSelected(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner,
        Edit edit, PublishedMediaSelection selection, CancellationToken ct)
    {
        await using var query = Store.Sql(db, tx, """
            SELECT m.id,m.content_hash,m.format,m.length,m.width,m.height
            FROM public.article_revision_media AS r
            JOIN public.private_media AS m ON m.id=r.asset_id
            WHERE r.article_id=$1 AND r.revision=$2 AND m.owner_id=$3 AND m.id=ANY($4) AND m.phase=1
            ORDER BY m.id
            FOR SHARE OF m
            """, edit.Id, edit.ExpectedRevision, owner, selection.Assets);
        await using var rows = await query.ExecuteReaderAsync(ct);
        var images = new Dictionary<Guid, PublishedMediaReference>(selection.Assets.Length);
        while (await rows.ReadAsync(ct))
        {
            var image = new PublishedMediaReference(rows.GetGuid(0), rows.GetFieldValue<byte[]>(1),
                (MediaFormat)rows.GetInt16(2), rows.GetInt32(3), rows.GetInt32(4), rows.GetInt32(5));
            images.Add(image.AssetId, image);
        }
        if (images.Count != selection.Assets.Length) throw ArticleMediaStore.Missing();

        var total = 0L;
        var digests = new HashSet<string>(StringComparer.Ordinal);
        var ordered = new PublishedMediaReference[selection.Assets.Length];
        for (var ordinal = 0; ordinal < ordered.Length; ordinal++)
        {
            var image = images[selection.Assets[ordinal]];
            if (image.Digest.Length != 32 || image.Length is < 1 or > MediaImage.MaxBytes ||
                image.Format is not (MediaFormat.Png or MediaFormat.Jpeg))
                throw new IOException("The retained private source has invalid metadata.");
            if ((total += image.Length) > CurrentSchema.PublicationMediaMaximumBytes)
                throw new BusinessException(Rejection.Invalid, "Selected images exceed the 40 MiB publication limit.");
            if (!digests.Add(Convert.ToHexStringLower(image.Digest)))
                throw new BusinessException(Rejection.Conflict, "Two selected images contain the same image bytes.");
            ordered[ordinal] = image;
        }
        return ordered;
    }

    internal static async Task Attach(NpgsqlConnection db, NpgsqlTransaction tx, int articleId, long publicationId,
        long revision, IReadOnlyList<PublishedMediaReference> images, CancellationToken ct)
    {
        for (var ordinal = 0; ordinal < images.Count; ordinal++)
        {
            var image = images[ordinal];
            await using var insert = Store.Sql(db, tx, """
                INSERT INTO public.article_publication_media
                    (article_id,publication_id,revision,ordinal,asset_id,content_hash,format,length,width,height)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                """, articleId, publicationId, revision, ordinal + 1, image.AssetId, image.Digest, (short)image.Format,
                image.Length, image.Width, image.Height);
            await insert.ExecuteNonQueryAsync(ct);
        }
    }

    public void Dispose() => objects.Dispose();

    private static string Name(byte[] digest) => Convert.ToHexStringLower(digest) + ".media";

    private static bool MatchesFormat(ReadOnlySpan<byte> bytes, MediaFormat format) => format switch
    {
        MediaFormat.Png => bytes.StartsWith((ReadOnlySpan<byte>)[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        MediaFormat.Jpeg => bytes.StartsWith((ReadOnlySpan<byte>)[0xff, 0xd8, 0xff]),
        _ => false
    };
}
