using System.Runtime.Versioning;

namespace FsusBlog.V2.Integration.Tests;

[UnsupportedOSPlatform("windows")]
public sealed class PublishedMediaStorePostgresTests
{
    [PostgresFact]
    public async Task ExplicitSelectionBindsToOnePublicationAndSharesContentAddressedBytes()
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) return;
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        await using var lease = new InstanceLease(db.ConnectionString);
        await lease.Start(NullLogger.Instance, ct);
        using var media = new Files(db, lease, ct);
        media.VerifyDirectoryIsolation();
        await media.Publications.Refresh(ct);
        var author = await media.Author("release owner");
        var outsider = await media.Author("other author");
        var first = await media.Upload(author, "first.png", SKColors.SteelBlue);
        var second = await media.Upload(author, "second.jpg", SKColors.Coral, MediaFormat.Jpeg);
        var duplicate = await media.Upload(author, "duplicate.png", SKColors.SteelBlue);
        var unattached = await media.Upload(author, "unattached.png", SKColors.SeaGreen);
        var foreign = await media.Upload(outsider, "foreign.png", SKColors.Pink);
        Assert.NotEqual(first.Id, duplicate.Id);
        Assert.Equal(first.Image.Hash, duplicate.Image.Hash);

        var original = await media.Draft(author, "Media selection");
        var draft = await media.Attach(author, original, first);
        draft = await media.Attach(author, draft, second);
        draft = await media.Attach(author, draft, duplicate);
        draft = await media.SetCover(author, draft, second);
        var key = Guid.NewGuid();
        var unpublished = await media.State(draft.Id, key);
        Assert.Equal(new DatabaseState(draft.Revision, null, null, 0, 0, 0, 0), unpublished);

        foreach (var (rejection, actor, target, assets, session) in new (Rejection, MediaFixture.Session, ArticleState, Guid[], string?)[]
        {
            (Rejection.Conflict, author, original, [first.Id], null),
            (Rejection.Conflict, author, draft, [first.Id], outsider.SiteSessionId),
            (Rejection.NotFound, outsider, draft, [first.Id], null),
            (Rejection.NotFound, author, draft, [unattached.Id], null),
            (Rejection.NotFound, author, draft, [foreign.Id], null),
            (Rejection.Invalid, author, draft, [], null),
            (Rejection.Invalid, author, draft, [first.Id, first.Id], null),
            (Rejection.Conflict, author, draft, [first.Id, duplicate.Id], null),
        })
            await Denied(rejection, () => media.Publish(actor, target, key, assets, session));
        Assert.Equal(unpublished, await media.State(draft.Id, key));
        Assert.Null(media.Publications.Snapshot!.Article(draft.Id));
        Assert.Empty(media.PublishedEntries());

        var published = await media.Publish(author, draft, key, [second.Id, first.Id]);
        Assert.Equal((true, draft.Revision + 1, draft.Revision + 1), (published.Changed, published.Article.Revision, published.Article.PublishedRevision));
        var state = await media.State(draft.Id, key);
        var publication = state.Publication.GetValueOrDefault();
        Assert.True(publication > 0);
        Assert.Equal(new DatabaseState(published.Article.Revision, published.Article.Revision, state.Publication, 1, 1, 2, 1), state);
        var snapshot = media.Publications.Snapshot!.Article(draft.Id)!;
        Assert.Equal((published.Article.Revision, publication), (snapshot.Revision, snapshot.Publication));

        var manifest = await media.Manifest(draft.Id, publication);
        Assert.Equal(new[] { 1, 2 }, manifest.Select(row => row.Ordinal));
        Assert.Equal(new[] { first.Id, second.Id }.Order(), manifest.Select(row => row.Asset));
        Verify(Assert.Single(manifest, row => row.Asset == first.Id), first, published.Article.Revision);
        Verify(Assert.Single(manifest, row => row.Asset == second.Id), second, published.Article.Revision);
        await media.VerifyPublicBytes(first);
        await media.VerifyPublicBytes(second);
        var restoredSelection = await media.RestoreSelection(author, draft.Id, published.Article.Revision, publication);
        Assert.NotNull(restoredSelection);
        Assert.Equal(manifest.Select(row => row.Asset), restoredSelection.Select(row => row.AssetId));
        Assert.DoesNotContain(restoredSelection, row => row.AssetId == duplicate.Id);
        Assert.Equal(second.Id, Assert.Single(restoredSelection, row => row.IsCover).AssetId);
        await media.ReplacePrivateSource(first.Id, new byte[first.Image.Bytes.Length]);
        await Assert.ThrowsAsync<IOException>(() => media.RestoreSelection(author, draft.Id, published.Article.Revision, publication));
        await media.ReplacePrivateSource(first.Id, first.Image.Bytes);
        var leaves = media.PublishedEntries();
        Assert.Equal(new[] { FileName(first), FileName(second) }.Order(StringComparer.Ordinal).ToArray(), leaves);
        var replay = await media.Publish(author, draft, key, [first.Id, second.Id]);
        Assert.Equal((false, published.Article), (replay.Changed, replay.Article));
        await Denied(Rejection.Conflict, () => media.Publish(author, draft, key, [first.Id, second.Id], outsider.SiteSessionId));
        await Denied(Rejection.Conflict, () => media.Publish(author, draft, key, [first.Id]));
        await Denied(Rejection.Conflict, () => media.Publications.Command(media.AuthorStore, author.Token, ArticleAction.Publish,
            new(draft.Id, draft.Revision, key, "", ""), ct));
        Assert.Equal(state, await media.State(draft.Id, key));

        var another = await media.Attach(author, await media.Draft(author, "Same bytes, separate publication"), duplicate);
        var anotherKey = Guid.NewGuid();
        var anotherRelease = await media.Publish(author, another, anotherKey, [duplicate.Id]);
        Assert.True(anotherRelease.Changed);
        var anotherState = await media.State(another.Id, anotherKey);
        Assert.NotEqual(state.Publication, anotherState.Publication);
        Verify(Assert.Single(await media.Manifest(another.Id, anotherState.Publication!.Value)), duplicate, anotherRelease.Article.Revision);
        Assert.Equal(leaves, media.PublishedEntries());

        var ordinaryKey = Guid.NewGuid();
        var ordinary = await media.Publications.Command(media.AuthorStore, author.Token, ArticleAction.Publish,
            new(draft.Id, published.Article.Revision, ordinaryKey, "", ""), ct);
        Assert.True(ordinary.Changed);
        var ordinaryState = await media.State(draft.Id, ordinaryKey);
        Assert.Equal(new DatabaseState(ordinary.Article.Revision, ordinary.Article.Revision, ordinaryState.Publication, 2, 2, 2, 1), ordinaryState);
        Assert.NotEqual(state.Publication, ordinaryState.Publication);
        Assert.Empty(await media.Manifest(draft.Id, ordinaryState.Publication!.Value));
        Assert.Equal(manifest.Select(row => (row.Ordinal, row.Asset, row.Revision)),
            (await media.Manifest(draft.Id, publication)).Select(row => (row.Ordinal, row.Asset, row.Revision)));
    }

    [PostgresFact]
    public async Task SourceCorruptionAndOutboxFailurePreserveThePriorReleaseAndAllowExactRetry()
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) return;
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        await using var lease = new InstanceLease(db.ConnectionString);
        await lease.Start(NullLogger.Instance, ct);
        using var media = new Files(db, lease, ct);
        await media.Publications.Refresh(ct);
        var author = await media.Author("rollback owner");
        var first = await media.Upload(author, "active.png", SKColors.SteelBlue);
        var next = await media.Upload(author, "replacement.png", SKColors.SeaGreen);
        var draft = await media.Attach(author, await media.Draft(author, "Recoverable release"), first);
        var previous = await media.Publish(author, draft, Guid.NewGuid(), [first.Id]);
        var old = media.Publications.Snapshot!.Article(draft.Id)!;
        draft = await media.Attach(author, previous.Article, next);
        var key = Guid.NewGuid();
        var before = await media.State(draft.Id, key);
        Assert.Equal(new DatabaseState(draft.Revision, previous.Article.Revision, old.Publication, 1, 1, 1, 0), before);
        var original = next.Image.Bytes;
        var corrupted = original.ToArray();
        corrupted[^1] ^= 1;
        await media.ReplacePrivateSource(next.Id, corrupted);
        Assert.Contains("committed digest", (await Assert.ThrowsAsync<IOException>(() => media.Publish(author, draft, key, [next.Id]))).Message);
        await VerifyPreserved();
        Assert.Equal(new[] { FileName(first) }, media.PublishedEntries());
        await media.ReplacePrivateSource(next.Id, original);

        var badPublicPath = await media.CreatePublicTestLeaf(next, corrupted);
        try
        {
            Assert.Contains("committed digest", (await Assert.ThrowsAsync<IOException>(() => media.Publish(author, draft, key, [next.Id]))).Message);
            await VerifyPreserved();
            Assert.Equal(corrupted, await File.ReadAllBytesAsync(badPublicPath, ct));
            Assert.Equal(new[] { FileName(first), FileName(next) }.Order(StringComparer.Ordinal).ToArray(), media.PublishedEntries());
        }
        finally { File.Delete(badPublicPath); }

        // A NOT VALID fault leaves history untouched and rejects this transaction's new event.
        await db.Exec("ALTER TABLE public.blog_outbox ADD CONSTRAINT test_publish_media_outbox CHECK (kind <> 'publish') NOT VALID");
        var rejection = await Assert.ThrowsAsync<PostgresException>(() => media.Publish(author, draft, key, [next.Id]));
        Assert.Equal((PostgresErrorCodes.CheckViolation, "test_publish_media_outbox"), (rejection.SqlState, rejection.ConstraintName));
        await VerifyPreserved();
        await db.Exec("ALTER TABLE public.blog_outbox DROP CONSTRAINT test_publish_media_outbox");

        var retry = await media.Publish(author, draft, key, [next.Id]);
        Assert.True(retry.Changed);
        var after = await media.State(draft.Id, key);
        Assert.True(after.Publication > old.Publication);
        Assert.Equal(new DatabaseState(draft.Revision + 1, draft.Revision + 1, after.Publication, 2, 2, 2, 1), after);
        Verify(Assert.Single(await media.Manifest(draft.Id, after.Publication!.Value)), next, retry.Article.Revision);
        await media.VerifyPublicBytes(next);
        Assert.Equal(after.Publication, media.Publications.Snapshot!.Article(draft.Id)!.Publication);

        async Task VerifyPreserved()
        {
            Assert.Equal(before, await media.State(draft.Id, key));
            Assert.Equal(old, media.Publications.Snapshot!.Article(draft.Id));
            Verify(Assert.Single(await media.Manifest(draft.Id, old.Publication)), first, old.Revision);
            await media.VerifyPublicBytes(first);
        }
    }

    private static void Verify(ManifestRow row, Asset asset, long revision)
    {
        Assert.Equal((asset.Id, revision, (short)asset.Image.Format, asset.Image.Bytes.Length, asset.Image.Width, asset.Image.Height),
            (row.Asset, row.Revision, row.Format, row.Length, row.Width, row.Height));
        Assert.Equal(asset.Image.Hash, row.Hash);
    }

    private static string FileName(Asset asset) => $"{Convert.ToHexStringLower(asset.Image.Hash)}.media";

    private sealed record Asset(Guid Id, MediaImage Image);
    private sealed record DatabaseState(long Revision, long? PublishedRevision, long? Publication, long History, long Events, long Media, long Receipt);
    private sealed record ManifestRow(int Ordinal, Guid Asset, long Revision, byte[] Hash, short Format, int Length, int Width, int Height);

    private sealed class Files : IDisposable
    {
        private readonly ScratchDatabase _db;
        private readonly CancellationToken _ct;
        private readonly DirectoryInfo _root;
        private readonly string _privateDirectory, _publishedDirectory, _webDirectory;
        private readonly MediaFiles _privateFiles;
        private readonly MediaStore _private;
        private readonly PublishedMediaStore _published;
        internal Store AuthorStore { get; }
        internal Publications Publications { get; }

        internal Files(ScratchDatabase db, InstanceLease lease, CancellationToken ct)
        {
            (_db, _ct, _root) = (db, ct, Directory.CreateTempSubdirectory("fsusblog-media-publish-"));
            try
            {
                _privateDirectory = MediaFixture.CreateOwnedDirectory(_root.FullName, "private");
                _publishedDirectory = MediaFixture.CreateOwnedDirectory(_root.FullName, "published");
                _webDirectory = MediaFixture.CreateOwnedDirectory(_root.FullName, "web");
                _privateFiles = new(_privateDirectory, _webDirectory);
                try { _published = new(_privateFiles, _publishedDirectory, _webDirectory); }
                catch { _privateFiles.Dispose(); throw; }
                _private = new(_privateFiles);
                AuthorStore = new(db.DataSource, lease);
                Publications = PublicationFixture.Project(db.DataSource, lease);
            }
            catch { _root.Delete(recursive: true); throw; }
        }

        public void Dispose() { _published.Dispose(); _privateFiles.Dispose(); _root.Delete(recursive: true); }

        internal Task<MediaFixture.Session> Author(string name) => MediaFixture.CreateSession(_db.DataSource, name, _ct);

        internal async Task<Asset> Upload(MediaFixture.Session author, string name, SKColor color, MediaFormat format = MediaFormat.Png)
        {
            var image = MediaImage.Normalize(name, format, MediaFixture.SolidImage(format == MediaFormat.Png ? SKEncodedImageFormat.Png : SKEncodedImageFormat.Jpeg, color), _ct);
            return await AuthorStore.WithSession(author.Token, true, async (db, tx, actor) =>
            {
                var asset = await _private.Reserve(db, tx, actor.Id, Guid.NewGuid(), image, _ct);
                await _private.Activate(db, tx, actor.Id, asset, image, _ct);
                return new Asset(asset, image);
            }, _ct);
        }

        internal async Task<ArticleState> Draft(MediaFixture.Session author, string title) =>
            (await Publications.Command(AuthorStore, author.Token, ArticleAction.Save, new(0, 0, Guid.NewGuid(), title, "Test body."), _ct)).Article;

        internal Task<ArticleState> Attach(MediaFixture.Session author, ArticleState draft, Asset asset) =>
            AuthorStore.WithSession(author.Token, true, (db, tx, actor) => Store.SetPrivateAttachment(db, tx, actor,
                new(draft.Id, draft.Revision, Guid.NewGuid(), asset.Id, true), _ct), _ct);

        internal Task<ArticleState> SetCover(MediaFixture.Session author, ArticleState draft, Asset asset) =>
            AuthorStore.WithSession(author.Token, true, (db, tx, actor) => Store.SetCover(db, tx, actor,
                new(draft.Id, draft.Revision, Guid.NewGuid(), asset.Id), _ct), _ct);

        internal Task<(ArticleState Article, bool Changed)> Publish(MediaFixture.Session author, ArticleState draft, Guid key,
            IReadOnlyList<Guid> assets, string? session = null) =>
            Publications.PublishWithImages(AuthorStore, author.Token, session ?? author.SiteSessionId, _published, draft.Id, draft.Revision, key, assets, _ct);

        internal Task<IReadOnlyList<PublishedMediaReference>?> RestoreSelection(MediaFixture.Session owner, int article, long revision, long publication) =>
            _db.InTx((db, tx) => PublishedMediaStore.RestoreSelection(db, tx, _published, owner.Id, article, revision, publication, _ct), _ct);

        internal Task<DatabaseState> State(int article, Guid key) => _db.QueryRowAsync(_ct, """
            SELECT a.revision,a.published_revision,p.publication_id,
                (SELECT count(*) FROM public.article_publication_history WHERE article_id=$1),
                (SELECT count(*) FROM public.blog_outbox WHERE article_id=$1 AND kind='publish'),
                (SELECT count(*) FROM public.article_publication_media WHERE article_id=$1),
                (SELECT count(*) FROM public.article_command WHERE article_id=$1 AND command_id=$2),
                (SELECT count(*) FROM public.blog_outbox WHERE article_id=$1 AND kind='publish' AND processed_at IS NULL),
                (SELECT count(*) FROM public.article_revision WHERE article_id=$1)
            FROM public.article a LEFT JOIN public.article_publication p ON p.article_id=a.id WHERE a.id=$1
            """, row =>
        {
            var revision = row.GetInt64(0);
            Assert.Equal((0L, revision), (row.GetInt64(7), row.GetInt64(8)));
            return new DatabaseState(revision, row.IsDBNull(1) ? null : row.GetInt64(1), row.IsDBNull(2) ? null : row.GetInt64(2),
                row.GetInt64(3), row.GetInt64(4), row.GetInt64(5), row.GetInt64(6));
        }, article, key);

        internal Task<List<ManifestRow>> Manifest(int article, long publication) => _db.QueryRowsAsync(_ct, """
            SELECT ordinal::int, asset_id, revision, content_hash, format::smallint, length, width, height
            FROM public.article_publication_media WHERE article_id=$1 AND publication_id=$2 ORDER BY ordinal
            """, rows => new ManifestRow(rows.GetInt32(0), rows.GetGuid(1), rows.GetInt64(2), rows.GetFieldValue<byte[]>(3),
                rows.GetInt16(4), rows.GetInt32(5), rows.GetInt32(6), rows.GetInt32(7)), article, publication);

        internal Task ReplacePrivateSource(Guid id, byte[] bytes) =>
            MediaFixture.WriteReadOnlyFile(Path.Combine(_privateDirectory, $"{id:N}.media"), bytes, _ct);

        internal void VerifyDirectoryIsolation()
        {
            foreach (var dir in new[] { _webDirectory, _privateDirectory })
                Assert.Throws<InvalidOperationException>(() => { using var _ = new PublishedMediaStore(_privateFiles, dir, _webDirectory); });
        }

        internal string[] PublishedEntries() => Directory.EnumerateFileSystemEntries(_publishedDirectory)
            .Select(path => Path.GetRelativePath(_publishedDirectory, path)).Order(StringComparer.Ordinal).ToArray();

        internal async Task<string> CreatePublicTestLeaf(Asset asset, byte[] bytes)
        {
            var path = Path.Combine(_publishedDirectory, FileName(asset));
            await MediaFixture.WriteReadOnlyFile(path, bytes, _ct, createNew: true);
            return path;
        }

        internal async Task VerifyPublicBytes(Asset asset)
        {
            var path = Path.Combine(_publishedDirectory, FileName(asset));
            var stored = await File.ReadAllBytesAsync(path, _ct);
            Assert.Equal(UnixFileMode.UserRead, File.GetUnixFileMode(path));
            Assert.Equal(asset.Image.Bytes, stored);
            Assert.Equal(asset.Image.Hash, SHA256.HashData(stored));
        }
    }
}
