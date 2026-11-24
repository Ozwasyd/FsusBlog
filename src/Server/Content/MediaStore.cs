namespace FsusBlog.V2.Server.Content;

internal sealed class MediaFiles(string path, string publicRoot) : IDisposable
{
    private readonly MediaObjectDirectory objects = new(path, MediaImage.MaxBytes,
        [publicRoot, Path.Combine(publicRoot, "assets"), Path.Combine(publicRoot, "dist")]);

    internal string Root => objects.Root;
    internal Task<byte[]?> Read(Guid id, int length, byte[] hash, CancellationToken token) => objects.Read(Name(id), length, hash, token);
    internal Task Materialize(Guid id, MediaImage image, CancellationToken token) => objects.Materialize(Name(id), image.Bytes, image.Hash, token);
    internal Task Delete(Guid id, int length, byte[] hash, CancellationToken token) => objects.Delete(Name(id), length, hash, token);
    public void Dispose() => objects.Dispose();
    private static string Name(Guid id) => $"{id:N}.media";
}

internal sealed record MediaRecord(Guid Id, string Name, MediaFormat Format, int Length, int Width, int Height, DateTimeOffset CreatedAt);
internal readonly record struct MediaPosition(DateTimeOffset CreatedAt, Guid Id);

internal sealed class MediaStore(MediaFiles files)
{
    private const string Fields = "id,name,format,length,width,height,created_at";

    internal Task<List<MediaRecord>> List(NpgsqlConnection db, NpgsqlTransaction transaction, Guid owner, MediaPosition? before,
        CancellationToken token) =>
        SqlCommands.QueryList(db, transaction, token, $"""
            SELECT {Fields} FROM public.private_media WHERE owner_id=$1 AND phase=1
            AND ($2 OR (created_at,id) < ($3,$4)) ORDER BY created_at DESC,id DESC LIMIT 51
            """, ReadRecord, owner, before is null, before?.CreatedAt ?? DateTimeOffset.UnixEpoch, before?.Id ?? Guid.Empty);

    internal async Task<Guid> Reserve(NpgsqlConnection db, NpgsqlTransaction transaction, Guid owner, Guid commandId,
        MediaImage image, CancellationToken token)
    {
        var id = Guid.NewGuid();
        if (await SqlCommands.Execute(db, transaction, token, """
            INSERT INTO public.private_media (id,owner_id,command_id,request_hash,content_hash,name,format,length,width,height,phase)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0) ON CONFLICT (owner_id,command_id) DO NOTHING
            """, id, owner, commandId, image.RequestHash, image.Hash, image.Name, (short)image.Format, image.Bytes.Length, image.Width,
            image.Height) == 1) return id;

        return await SqlCommands.QueryRequired(db, transaction, token, """
            SELECT id,request_hash,phase FROM public.private_media WHERE owner_id=$1 AND command_id=$2 FOR UPDATE
            """, row =>
        {
            if (!CryptographicOperations.FixedTimeEquals(row.GetFieldValue<byte[]>(1), image.RequestHash))
                throw new BusinessException(Rejection.Conflict, "This upload key is already in use.");
            if ((MediaPhase)row.GetInt16(2) is MediaPhase.Removing or MediaPhase.Removed)
                throw new BusinessException(Rejection.Conflict, "This upload has been removed. Use a new key for a new upload.");
            return row.GetGuid(0);
        }, () => new BusinessException(Rejection.Conflict, "This upload key is already in use."), owner, commandId);
    }

    internal async Task<MediaRecord> Activate(NpgsqlConnection db, NpgsqlTransaction transaction, Guid owner, Guid id,
        MediaImage image, CancellationToken token)
    {
        var row = await Find(db, transaction, owner, id, locking: true, token);
        if (row is null || row.Phase is MediaPhase.Removing or MediaPhase.Removed)
            throw new BusinessException(Rejection.Conflict, "This upload is no longer available.");
        if (row.Phase == MediaPhase.Pending)
        {
            if (!CryptographicOperations.FixedTimeEquals(row.Digest, image.Hash) || row.Record.Length != image.Bytes.Length)
                throw new BusinessException(Rejection.Conflict, "Pending image does not match the saved upload.");
            await files.Materialize(id, image, token);
            await SetPhase(db, transaction, owner, id, MediaPhase.Ready, token);
        }
        else if (await files.Read(id, row.Record.Length, row.Digest, token) is null)
            throw new IOException("Committed private media is unavailable from storage.");
        return row.Record;
    }

    internal async Task<(MediaRecord Record, byte[] Bytes)?> Read(NpgsqlConnection db, NpgsqlTransaction transaction, Guid owner,
        Guid id, CancellationToken token)
    {
        var row = await Find(db, transaction, owner, id, locking: false, token);
        if (row?.Phase != MediaPhase.Ready) return null;
        return await files.Read(id, row.Record.Length, row.Digest, token) is { } bytes ? (row.Record, bytes) : null;
    }

    internal async Task<MediaRecord> VerifyReady(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, Guid id, CancellationToken token)
        => (await Read(db, tx, owner, id, token))?.Record ?? throw new BusinessException(Rejection.NotFound, "Private media not found.");

    internal async Task<bool> Tombstone(NpgsqlConnection db, NpgsqlTransaction transaction, Guid owner, Guid id, CancellationToken token)
    {
        var row = await Find(db, transaction, owner, id, locking: true, token);
        if (row is null) return false;
        if (row.Phase is MediaPhase.Pending or MediaPhase.Ready)
        {
            await ArticleMediaStore.EnsureUnreferenced(db, transaction, id, token);
            await SetPhase(db, transaction, owner, id, MediaPhase.Removing, token);
        }
        return true;
    }

    internal async Task FinishRemoval(NpgsqlConnection db, NpgsqlTransaction transaction, Guid owner, Guid id, CancellationToken token)
    {
        var row = await Find(db, transaction, owner, id, locking: true, token);
        if (row?.Phase != MediaPhase.Removing) return;
        await files.Delete(id, row.Record.Length, row.Digest, token);
        await SetPhase(db, transaction, owner, id, MediaPhase.Removed, token);
    }

    private static Task<SavedMedia?> Find(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, Guid id, bool locking,
        CancellationToken token) =>
        SqlCommands.QueryOne(db, tx, token,
            $"SELECT {Fields},content_hash,phase FROM public.private_media WHERE owner_id=$1 AND id=$2" + (locking ? " FOR UPDATE" : " FOR SHARE"),
            row => new SavedMedia(ReadRecord(row), row.GetFieldValue<byte[]>(7), (MediaPhase)row.GetInt16(8)), owner, id);

    private static Task SetPhase(NpgsqlConnection db, NpgsqlTransaction transaction, Guid owner, Guid id, MediaPhase phase,
        CancellationToken token) =>
        SqlCommands.Execute(db, transaction, token, "UPDATE public.private_media SET phase=$3 WHERE owner_id=$1 AND id=$2",
            owner, id, (short)phase);

    private static MediaRecord ReadRecord(NpgsqlDataReader row) => new(row.GetGuid(0), row.GetString(1), (MediaFormat)row.GetInt16(2),
        row.GetInt32(3), row.GetInt32(4), row.GetInt32(5), row.GetFieldValue<DateTimeOffset>(6));

    private sealed record SavedMedia(MediaRecord Record, byte[] Digest, MediaPhase Phase);
}

internal static class ArticleMediaStore
{
    internal const int Maximum = 32;

    internal static async Task<List<Guid>> Read(NpgsqlConnection db, NpgsqlTransaction tx, int article, long revision, CancellationToken ct)
    {
        var assets = await SqlCommands.QueryList(db, tx, ct,
            "SELECT asset_id FROM public.article_revision_media WHERE article_id=$1 AND revision=$2 ORDER BY asset_id LIMIT 33",
            r => r.GetGuid(0), article, revision);
        if (assets.Count > Maximum) throw new InvalidOperationException("Private attachment list exceeds its allowed size.");
        return assets;
    }

    internal static async Task Copy(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, int article, long source,
        long revision, ArticleMediaCommand? change, CancellationToken ct, ArticleCoverCommand? cover = null)
    {
        if (change is null)
        {
            if (await SqlCommands.Execute(db, tx, ct, """
                INSERT INTO public.article_revision_media(article_id,revision,asset_id)
                SELECT article_id,$3,asset_id FROM public.article_revision_media WHERE article_id=$1 AND revision=$2
                """, article, source, revision) > 0 || cover is not null)
                await CopyCover(db, tx, article, source, revision, cover, ct);
            return;
        }
        var assets = await Read(db, tx, article, source, ct);
        if (change.Attach)
        {
            if (assets.Count >= Maximum || assets.Contains(change.AssetId))
                throw new BusinessException(Rejection.Conflict, "This asset is already attached or the attachment limit was reached.");
            if (await SqlCommands.Scalar(db, tx, ct,
                "SELECT id FROM public.private_media WHERE id=$1 AND owner_id=$2 AND phase=1 FOR UPDATE",
                change.AssetId, owner) is null) throw Missing();
            assets.Add(change.AssetId);
        }
        else if (!assets.Remove(change.AssetId)) throw Missing();

        if (assets.Count == 0) return;
        await SqlCommands.Execute(db, tx, ct, """
            INSERT INTO public.article_revision_media (article_id,revision,asset_id)
            SELECT $1,$2,asset FROM pg_catalog.unnest($3) AS refs(asset)
            """, article, revision, assets.ToArray());
        await CopyCover(db, tx, article, source, revision, cover, ct);
    }

    private static async Task CopyCover(NpgsqlConnection db, NpgsqlTransaction tx, int article, long source,
        long revision, ArticleCoverCommand? change, CancellationToken ct)
    {
        if (change is { AssetId: var value } && value == Guid.Empty) return;
        if (change is null && !await CurrentSchema.HasArticleCoverAsync(db, tx, ct)) return;
        var selection = change is null ? "(select asset_id from public.article_revision_cover where article_id=$1 and revision=$3)" : "$3";
        if (await SqlCommands.Execute(db, tx, ct, $"""
            INSERT INTO public.article_revision_cover(article_id,revision,asset_id)
            SELECT article_id,revision,asset_id FROM public.article_revision_media
            WHERE article_id=$1 AND revision=$2 AND asset_id={selection}
            """, article, revision, (object?)change?.AssetId ?? source) != 1 && change is not null) throw Missing();
    }

    internal static async Task WriteCoverHeaders(NpgsqlConnection db, NpgsqlTransaction tx, HttpResponse response,
        int article, long current, CancellationToken ct, long? source = null)
    {
        if (!await CurrentSchema.HasArticleCoverAsync(db, tx, ct)) return;
        response.Headers[WireHeaders.ArticleCover] = "none";
        if (source is not null) response.Headers[WireHeaders.SourceArticleCover] = "none";
        await SqlCommands.ReadAll(db, tx, ct,
            "SELECT revision,asset_id FROM public.article_revision_cover WHERE article_id=$1 AND revision IN ($2,$3)",
            rows => response.Headers[rows.GetInt64(0) == current ? WireHeaders.ArticleCover : WireHeaders.SourceArticleCover] = rows.GetGuid(1).ToString("D"),
            article, current, source ?? current);
    }

    internal static async Task<bool> Contains(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, int article,
        long revision, Guid asset, CancellationToken ct) =>
        await SqlCommands.Scalar(db, tx, ct, """
            SELECT a.id FROM public.article a JOIN public.article_revision_media r ON r.article_id=a.id AND r.revision=a.revision
            WHERE a.owner_id=$1 AND a.id=$2 AND a.revision=$3 AND NOT a.deleted AND r.asset_id=$4 FOR SHARE OF a
            """, owner, article, revision, asset) is not null && !await ArchivedArticleAuthority.IsLockedArchived(db, tx, article, ct);

    internal static async Task EnsureUnreferenced(NpgsqlConnection db, NpgsqlTransaction tx, Guid asset, CancellationToken ct)
    {
        if (await SqlCommands.Scalar(db, tx, ct, "SELECT EXISTS (SELECT FROM public.article_revision_media WHERE asset_id=$1)", asset) is true)
            throw new BusinessException(Rejection.Conflict, "A retained article revision references this private asset.");
    }

    internal static BusinessException Missing() => new(Rejection.NotFound, "Private article attachment not found.");
}

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
            if (canonical[i] == Guid.Empty || i > 0 && canonical[i] == canonical[i - 1])
                throw new BusinessException(Rejection.Invalid, "Selected image IDs must be valid and distinct.");
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
        foreach (var asset in Assets) { asset.TryWriteBytes(field, bigEndian: true, out _); sha.AppendData(field); }
        return sha.GetHashAndReset();
    }
}

internal sealed record PublishedMediaReference(Guid AssetId, byte[] Digest, MediaFormat Format,
    int Length, int Width, int Height, bool IsCover = false);

internal sealed class PublishedMediaStore(MediaFiles privateFiles, string publicRoot, string webRoot,
    params string[] otherForbiddenRoots) : IDisposable
{
    private readonly ConcurrencyLimiter reads = new(new ConcurrencyLimiterOptions { PermitLimit = 4, QueueLimit = 0 });
    private readonly MediaObjectDirectory objects = new(publicRoot, MediaImage.MaxBytes,
        [privateFiles.Root, webRoot, Path.Combine(webRoot, "assets"), Path.Combine(webRoot, "dist"), .. otherForbiddenRoots]);

    internal async Task<IReadOnlyList<PublishedMediaReference>> Prepare(NpgsqlConnection db, NpgsqlTransaction tx,
        Guid owner, int article, long revision, PublishedMediaSelection selection, CancellationToken ct)
    {
        var images = await ReadSelected(db, tx, owner, article, revision, selection, ct);
        if (await CurrentSchema.HasPublicationCoverAsync(db, tx, ct) &&
            await SqlCommands.Scalar(db, tx, ct,
                "SELECT asset_id FROM public.article_revision_cover WHERE article_id=$1 AND revision=$2", article, revision) is Guid cover)
            for (var index = 0; index < images.Length; index++)
                if (images[index].AssetId == cover) images[index] = images[index] with { IsCover = true };
        await Materialize(images, ct);
        return images;
    }

    private async Task Materialize(IEnumerable<PublishedMediaReference> images, CancellationToken ct)
    {
        foreach (var image in images)
        {
            var bytes = await privateFiles.Read(image.AssetId, image.Length, image.Digest, ct);
            if (bytes is null || !PublishedArticleImage.MatchesFormat(bytes, (int)image.Format))
                throw new IOException("The retained private source is missing or has an unexpected format.");
            await objects.Materialize(Name(image.Digest), bytes, image.Digest, ct);
        }
    }

    internal static async Task<IReadOnlyList<PublishedMediaReference>?> RestoreSelection(NpgsqlConnection db,
        NpgsqlTransaction tx, PublishedMediaStore? media, Guid owner, int article, long revision, long publication, CancellationToken ct)
    {
        if (!await CurrentSchema.HasPublicationMediaAsync(db, tx, ct)) return null;
        List<PublishedMediaReference> prior = [];
        var hasCover = await CurrentSchema.HasPublicationCoverAsync(db, tx, ct);
        await SqlCommands.ReadAll(db, tx, ct, $"""
            select m.asset_id,m.content_hash,m.format,m.length,m.width,m.height,m.ordinal,{(hasCover ? "c.asset_id is not null" : "false")}
            from public.article_publication_media m {CoverJoin(hasCover)}
            where m.article_id=$1 and m.publication_id=$2 and m.revision=$3 order by m.ordinal limit 33
            """, rows =>
        {
            if (prior.Count == ArticleMediaStore.Maximum || rows.GetInt32(6) != prior.Count + 1) throw RestoreMediaConflict();
            prior.Add(new(rows.GetGuid(0), rows.GetFieldValue<byte[]>(1), (MediaFormat)rows.GetInt16(2),
                rows.GetInt32(3), rows.GetInt32(4), rows.GetInt32(5), rows.GetBoolean(7)));
        }, article, publication, revision);
        if (prior.Count == 0) return null;
        if (media is null) throw RestoreMediaConflict();
        var verified = (await ReadSelected(db, tx, owner, article, revision,
            PublishedMediaSelection.Create(prior.Select(image => image.AssetId).ToArray()), ct)).ToDictionary(image => image.AssetId);
        foreach (var original in prior)
            if (!verified.TryGetValue(original.AssetId, out var image) ||
                (original.Format, original.Length, original.Width, original.Height) != (image.Format, image.Length, image.Width, image.Height) ||
                !original.Digest.AsSpan().SequenceEqual(image.Digest)) throw RestoreMediaConflict();
        await media.Materialize(prior, ct);
        return prior;
    }

    internal static string CoverJoin(bool hasCover) => hasCover
        ? "left join public.article_publication_cover c on (c.article_id,c.publication_id,c.asset_id)=(m.article_id,m.publication_id,m.asset_id)"
        : "";

    private static BusinessException RestoreMediaConflict() => new(Rejection.Conflict, "The former publication images are unavailable.");

    private static async Task<PublishedMediaReference[]> ReadSelected(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner,
        int article, long revision, PublishedMediaSelection selection, CancellationToken ct)
    {
        var images = new Dictionary<Guid, PublishedMediaReference>(selection.Assets.Length);
        await SqlCommands.ReadAll(db, tx, ct, """
            SELECT m.id,m.content_hash,m.format,m.length,m.width,m.height
            FROM public.article_revision_media AS r JOIN public.private_media AS m ON m.id=r.asset_id
            WHERE r.article_id=$1 AND r.revision=$2 AND m.owner_id=$3 AND m.id=ANY($4) AND m.phase=1
            ORDER BY m.id FOR SHARE OF m
            """, rows =>
        {
            var image = new PublishedMediaReference(rows.GetGuid(0), rows.GetFieldValue<byte[]>(1),
                (MediaFormat)rows.GetInt16(2), rows.GetInt32(3), rows.GetInt32(4), rows.GetInt32(5));
            images.Add(image.AssetId, image);
        }, article, revision, owner, selection.Assets);
        if (images.Count != selection.Assets.Length) throw ArticleMediaStore.Missing();

        var total = 0L;
        var digests = new HashSet<string>(StringComparer.Ordinal);
        var ordered = new PublishedMediaReference[selection.Assets.Length];
        for (var ordinal = 0; ordinal < ordered.Length; ordinal++)
        {
            var image = images[selection.Assets[ordinal]];
            if (image.Digest.Length != 32 || image.Length is < 1 or > MediaImage.MaxBytes ||
                image.Format is not (MediaFormat.Png or MediaFormat.Jpeg or MediaFormat.Webp))
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
            await SqlCommands.Execute(db, tx, ct, """
                INSERT INTO public.article_publication_media
                    (article_id,publication_id,revision,ordinal,asset_id,content_hash,format,length,width,height)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                """, articleId, publicationId, revision, ordinal + 1, image.AssetId, image.Digest, (short)image.Format,
                image.Length, image.Width, image.Height);
            if (image.IsCover)
                await SqlCommands.Execute(db, tx, ct,
                    "INSERT INTO public.article_publication_cover (article_id,publication_id,asset_id) VALUES ($1,$2,$3)",
                    articleId, publicationId, image.AssetId);
        }
    }

    internal RateLimitLease AdmitRead() => reads.AttemptAcquire();

    internal async Task<byte[]?> ReadPublic(PublishedArticleImage image, CancellationToken ct)
    {
        var bytes = await objects.Read(image.Digest + ".media", image.Length, Convert.FromHexString(image.Digest), ct);
        return bytes is not null && PublishedArticleImage.MatchesFormat(bytes, image.Format) ? bytes : null;
    }

    public void Dispose() { reads.Dispose(); objects.Dispose(); }
    private static string Name(byte[] digest) => Convert.ToHexStringLower(digest) + ".media";
}
