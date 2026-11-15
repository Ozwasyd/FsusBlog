using System.Runtime.Versioning;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Operations;
using FsusBlog.V2.Server.Sessions;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;
using SkiaSharp;

namespace FsusBlog.V2.Integration.Tests;

[UnsupportedOSPlatform("windows")]
public sealed class PublishedMediaStorePostgresTests
{
    [PostgresFact]
    public async Task ExplicitSelectionBindsToOnePublicationAndSharesContentAddressedBytes()
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var lease = new InstanceLease(db.ConnectionString);
        await lease.Start(NullLogger.Instance, ct);
        using var media = new Files(db.DataSource, lease);
        media.VerifyDirectoryIsolation();
        await media.Publications.Refresh(ct);
        var author = await media.Author("release owner", ct);
        var outsider = await media.Author("other author", ct);
        var first = await media.Upload(author, "first.png", SKColors.SteelBlue, ct);
        var second = await media.Upload(author, "second.jpg", SKColors.Coral, ct, MediaFormat.Jpeg);
        var duplicate = await media.Upload(author, "duplicate.png", SKColors.SteelBlue, ct);
        var unattached = await media.Upload(author, "unattached.png", SKColors.SeaGreen, ct);
        var foreign = await media.Upload(outsider, "foreign.png", SKColors.Pink, ct);
        Assert.NotEqual(first.Id, duplicate.Id);
        Assert.Equal(first.Image.Hash, duplicate.Image.Hash);

        var original = await media.Draft(author, "Media selection", ct);
        var draft = await media.Attach(author, original, first, ct);
        draft = await media.Attach(author, draft, second, ct);
        draft = await media.Attach(author, draft, duplicate, ct);
        var key = Guid.NewGuid();
        var unpublished = await media.State(draft.Id, key, ct);
        Assert.Equal(new DatabaseState(draft.Revision, null, null, 0, 0, 0, 0), unpublished);

        await Reject(Rejection.Conflict, () => media.Publish(author, original, key, [first.Id], ct));
        await Reject(Rejection.Conflict, () => media.Publish(author, draft, key, [first.Id], ct, outsider.SessionId));
        await Reject(Rejection.NotFound, () => media.Publish(outsider, draft, key, [first.Id], ct));
        await Reject(Rejection.NotFound, () => media.Publish(author, draft, key, [unattached.Id], ct));
        await Reject(Rejection.NotFound, () => media.Publish(author, draft, key, [foreign.Id], ct));
        await Reject(Rejection.Invalid, () => media.Publish(author, draft, key, [], ct));
        await Reject(Rejection.Invalid, () => media.Publish(author, draft, key, [first.Id, first.Id], ct));
        await Reject(Rejection.Conflict, () => media.Publish(author, draft, key, [first.Id, duplicate.Id], ct));
        Assert.Equal(unpublished, await media.State(draft.Id, key, ct));
        Assert.Null(media.Publications.Snapshot!.Article(draft.Id));
        Assert.Empty(media.PublishedEntries());

        var published = await media.Publish(author, draft, key, [second.Id, first.Id], ct);
        Assert.True(published.Changed);
        Assert.Equal(draft.Revision + 1, published.Article.Revision);
        Assert.Equal(published.Article.Revision, published.Article.PublishedRevision);
        var state = await media.State(draft.Id, key, ct);
        var publication = state.Publication.GetValueOrDefault();
        Assert.True(publication > 0);
        Assert.Equal(new DatabaseState(published.Article.Revision, published.Article.Revision, state.Publication, 1, 1, 2, 1), state);
        var snapshot = media.Publications.Snapshot!.Article(draft.Id)!;
        Assert.Equal((published.Article.Revision, publication), (snapshot.Revision, snapshot.Publication));

        var manifest = await media.Manifest(draft.Id, publication, ct);
        Assert.Equal(new[] { 1, 2 }, manifest.Select(row => row.Ordinal));
        Assert.Equal(new[] { first.Id, second.Id }.Order(), manifest.Select(row => row.Asset));
        Verify(Assert.Single(manifest, row => row.Asset == first.Id), first, published.Article.Revision);
        Verify(Assert.Single(manifest, row => row.Asset == second.Id), second, published.Article.Revision);
        await media.VerifyPublicBytes(first, ct);
        await media.VerifyPublicBytes(second, ct);
        var leaves = media.PublishedEntries();
        Assert.Equal(new[] { FileName(first), FileName(second) }.Order(StringComparer.Ordinal).ToArray(), leaves);
        var replay = await media.Publish(author, draft, key, [first.Id, second.Id], ct);
        Assert.False(replay.Changed);
        Assert.Equal(published.Article, replay.Article);
        await Reject(Rejection.Conflict, () => media.Publish(author, draft, key, [first.Id, second.Id], ct, outsider.SessionId));
        await Reject(Rejection.Conflict, () => media.Publish(author, draft, key, [first.Id], ct));
        await Reject(Rejection.Conflict, () => media.Publications.Command(media.AuthorStore, author.Token, ArticleAction.Publish,
            new(draft.Id, draft.Revision, key, "", ""), ct));
        Assert.Equal(state, await media.State(draft.Id, key, ct));

        var another = await media.Draft(author, "Same bytes, separate publication", ct);
        another = await media.Attach(author, another, duplicate, ct);
        var anotherKey = Guid.NewGuid();
        var anotherRelease = await media.Publish(author, another, anotherKey, [duplicate.Id], ct);
        Assert.True(anotherRelease.Changed);
        var anotherState = await media.State(another.Id, anotherKey, ct);
        Assert.NotEqual(state.Publication, anotherState.Publication);
        var shared = Assert.Single(await media.Manifest(another.Id, anotherState.Publication!.Value, ct));
        Verify(shared, duplicate, anotherRelease.Article.Revision);
        Assert.Equal(leaves, media.PublishedEntries());

        var ordinaryKey = Guid.NewGuid();
        var ordinary = await media.Publications.Command(media.AuthorStore, author.Token, ArticleAction.Publish,
            new(draft.Id, published.Article.Revision, ordinaryKey, "", ""), ct);
        Assert.True(ordinary.Changed);
        var ordinaryState = await media.State(draft.Id, ordinaryKey, ct);
        Assert.Equal(new DatabaseState(ordinary.Article.Revision, ordinary.Article.Revision, ordinaryState.Publication, 2, 2, 2, 1), ordinaryState);
        Assert.NotEqual(state.Publication, ordinaryState.Publication);
        Assert.Empty(await media.Manifest(draft.Id, ordinaryState.Publication!.Value, ct));
        Assert.Equal(manifest.Select(row => (row.Ordinal, row.Asset, row.Revision)),
            (await media.Manifest(draft.Id, publication, ct)).Select(row => (row.Ordinal, row.Asset, row.Revision)));
    }

    [PostgresFact]
    public async Task SourceCorruptionAndOutboxFailurePreserveThePriorReleaseAndAllowExactRetry()
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var lease = new InstanceLease(db.ConnectionString);
        await lease.Start(NullLogger.Instance, ct);
        using var media = new Files(db.DataSource, lease);
        await media.Publications.Refresh(ct);
        var author = await media.Author("rollback owner", ct);
        var first = await media.Upload(author, "active.png", SKColors.SteelBlue, ct);
        var next = await media.Upload(author, "replacement.png", SKColors.SeaGreen, ct);
        var draft = await media.Draft(author, "Recoverable release", ct);
        draft = await media.Attach(author, draft, first, ct);
        var previous = await media.Publish(author, draft, Guid.NewGuid(), [first.Id], ct);
        var old = media.Publications.Snapshot!.Article(draft.Id)!;
        draft = await media.Attach(author, previous.Article, next, ct);
        var key = Guid.NewGuid();
        var before = await media.State(draft.Id, key, ct);
        Assert.Equal(new DatabaseState(draft.Revision, previous.Article.Revision, old.Publication, 1, 1, 1, 0), before);
        var original = next.Image.Bytes;
        var corrupted = original.ToArray();
        corrupted[^1] ^= 1;
        await media.ReplacePrivateSource(next.Id, corrupted, ct);
        var badSource = await Assert.ThrowsAsync<IOException>(() => media.Publish(author, draft, key, [next.Id], ct));
        Assert.Contains("committed digest", badSource.Message);
        await VerifyPreserved();
        Assert.Equal(new[] { FileName(first) }, media.PublishedEntries());
        await media.ReplacePrivateSource(next.Id, original, ct);

        var badPublicPath = await media.CreatePublicTestLeaf(next, corrupted, ct);
        try
        {
            var badTarget = await Assert.ThrowsAsync<IOException>(() => media.Publish(author, draft, key, [next.Id], ct));
            Assert.Contains("committed digest", badTarget.Message);
            await VerifyPreserved();
            Assert.Equal(corrupted, await File.ReadAllBytesAsync(badPublicPath, ct));
            Assert.Equal(new[] { FileName(first), FileName(next) }.Order(StringComparer.Ordinal).ToArray(), media.PublishedEntries());
        }
        finally { File.Delete(badPublicPath); }

        // A NOT VALID fault leaves history untouched and rejects this transaction's new event.
        await media.Execute("ALTER TABLE public.blog_outbox ADD CONSTRAINT test_publish_media_outbox CHECK (kind <> 'publish') NOT VALID", ct);
        var rejection = await Assert.ThrowsAsync<PostgresException>(() => media.Publish(author, draft, key, [next.Id], ct));
        Assert.Equal(PostgresErrorCodes.CheckViolation, rejection.SqlState);
        Assert.Equal("test_publish_media_outbox", rejection.ConstraintName);
        await VerifyPreserved();
        await media.Execute("ALTER TABLE public.blog_outbox DROP CONSTRAINT test_publish_media_outbox", ct);

        var retry = await media.Publish(author, draft, key, [next.Id], ct);
        Assert.True(retry.Changed);
        var after = await media.State(draft.Id, key, ct);
        Assert.True(after.Publication > old.Publication);
        Assert.Equal(new DatabaseState(draft.Revision + 1, draft.Revision + 1, after.Publication, 2, 2, 2, 1), after);
        Verify(Assert.Single(await media.Manifest(draft.Id, after.Publication!.Value, ct)), next, retry.Article.Revision);
        await media.VerifyPublicBytes(next, ct);
        Assert.Equal(after.Publication, media.Publications.Snapshot!.Article(draft.Id)!.Publication);

        async Task VerifyPreserved()
        {
            Assert.Equal(before, await media.State(draft.Id, key, ct));
            Assert.Equal(old, media.Publications.Snapshot!.Article(draft.Id));
            Verify(Assert.Single(await media.Manifest(draft.Id, old.Publication, ct)), first, old.Revision);
            await media.VerifyPublicBytes(first, ct);
        }
    }

    private static async Task Reject(Rejection rejection, Func<Task> attempt) =>
        Assert.Equal(rejection, (await Assert.ThrowsAsync<BusinessException>(attempt)).Rejection);

    private static void Verify(ManifestRow row, Asset asset, long revision)
    {
        Assert.Equal((asset.Id, revision, (short)asset.Image.Format, asset.Image.Bytes.Length, asset.Image.Width, asset.Image.Height),
            (row.Asset, row.Revision, row.Format, row.Length, row.Width, row.Height));
        Assert.Equal(asset.Image.Hash, row.Hash);
    }

    private static string FileName(Asset asset) => $"{Convert.ToHexStringLower(asset.Image.Hash)}.media";

    private sealed record Actor(Guid Id, string Token)
    {
        internal string SessionId => SiteSessions.Id(Id, Store.TokenDigest(Token)!);
    }

    private sealed record Asset(Guid Id, MediaImage Image);
    private sealed record DatabaseState(long Revision, long? PublishedRevision, long? Publication, long History, long Events, long Media, long Receipt);
    private sealed record ManifestRow(int Ordinal, Guid Asset, long Revision, byte[] Hash, short Format, int Length, int Width, int Height);

    private sealed class Files : IDisposable
    {
        private readonly NpgsqlDataSource _db;
        private readonly DirectoryInfo _root;
        private readonly string _privateDirectory;
        private readonly string _publishedDirectory;
        private readonly string _webDirectory;
        private readonly MediaFiles _privateFiles;
        private readonly MediaStore _private;
        private readonly PublishedMediaStore _published;
        internal Store AuthorStore { get; }
        internal Publications Publications { get; }

        internal Files(NpgsqlDataSource db, InstanceLease lease)
        {
            _db = db;
            _root = Directory.CreateTempSubdirectory("fsusblog-media-publish-");
            var root = OperatingSystem.IsMacOS() && _root.FullName.StartsWith("/var/", StringComparison.Ordinal)
                ? "/private" + _root.FullName : _root.FullName;
            try
            {
                _privateDirectory = OwnedDirectory("private");
                _publishedDirectory = OwnedDirectory("published");
                _webDirectory = OwnedDirectory("web");
                _privateFiles = new(_privateDirectory, _webDirectory);
                try { _published = new(_privateFiles, _publishedDirectory, _webDirectory); }
                catch { _privateFiles.Dispose(); throw; }
                _private = new(_privateFiles);
                AuthorStore = new(db, lease);
                Publications = new(db, new WebPages("<body><!--fsus-public-content--></body>"), NullLogger<Publications>.Instance, lease);
            }
            catch { _root.Delete(recursive: true); throw; }

            string OwnedDirectory(string leaf)
            {
                var path = Path.Combine(root, leaf);
                Directory.CreateDirectory(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
                return path;
            }
        }

        public void Dispose()
        {
            _published.Dispose();
            _privateFiles.Dispose();
            _root.Delete(recursive: true);
        }

        internal async Task<Actor> Author(string name, CancellationToken ct)
        {
            var id = Guid.NewGuid();
            var secret = RandomNumberGenerator.GetBytes(32);
            await using var db = await _db.OpenConnectionAsync(ct);
            await using var user = Store.Sql(db, null, "INSERT INTO public.blog_user (id,name,can_author,enabled,generation) VALUES ($1,$2,true,true,1)", id, name);
            await user.ExecuteNonQueryAsync(ct);
            await using var ticket = Store.Sql(db, null, "INSERT INTO public.login_ticket (digest,user_id,expires_at) VALUES ($1,$2,now()+interval '1 minute')",
                SHA256.HashData(secret), id);
            await ticket.ExecuteNonQueryAsync(ct);
            var session = await AuthorStore.SignIn(Convert.ToHexStringLower(secret), ct);
            return new(id, session.Token);
        }

        internal async Task<Asset> Upload(Actor author, string name, SKColor color, CancellationToken ct,
            MediaFormat format = MediaFormat.Png)
        {
            using var bitmap = new SKBitmap(3, 2);
            bitmap.Erase(color);
            using var encoded = bitmap.Encode(format == MediaFormat.Png ? SKEncodedImageFormat.Png : SKEncodedImageFormat.Jpeg, 90);
            var image = MediaImage.Normalize(name, format, encoded.ToArray(), ct);
            return await AuthorStore.WithSession(author.Token, true, async (db, tx, actor) =>
            {
                var asset = await _private.Reserve(db, tx, actor.Id, Guid.NewGuid(), image, ct);
                await _private.Activate(db, tx, actor.Id, asset, image, ct);
                return new Asset(asset, image);
            }, ct);
        }

        internal async Task<ArticleState> Draft(Actor author, string title, CancellationToken ct) =>
            (await Publications.Command(AuthorStore, author.Token, ArticleAction.Save, new(0, 0, Guid.NewGuid(), title, "Test body."), ct)).Article;

        internal Task<ArticleState> Attach(Actor author, ArticleState draft, Asset asset, CancellationToken ct) =>
            AuthorStore.WithSession(author.Token, true, (db, tx, actor) => Store.SetPrivateAttachment(db, tx, actor,
                new(draft.Id, draft.Revision, Guid.NewGuid(), asset.Id, true), ct), ct);

        internal Task<(ArticleState Article, bool Changed)> Publish(Actor author, ArticleState draft, Guid key,
            IReadOnlyList<Guid> assets, CancellationToken ct, string? session = null) =>
            Publications.PublishWithImages(AuthorStore, author.Token, session ?? author.SessionId, _published, draft.Id, draft.Revision, key, assets, ct);

        internal async Task Execute(string sql, CancellationToken ct)
        {
            await using var command = _db.CreateCommand(sql);
            await command.ExecuteNonQueryAsync(ct);
        }

        internal async Task<DatabaseState> State(int article, Guid key, CancellationToken ct)
        {
            await using var db = await _db.OpenConnectionAsync(ct);
            await using var query = Store.Sql(db, null, """
                SELECT a.revision,a.published_revision,p.publication_id,
                    (SELECT count(*) FROM public.article_publication_history WHERE article_id=$1),
                    (SELECT count(*) FROM public.blog_outbox WHERE article_id=$1 AND kind='publish'),
                    (SELECT count(*) FROM public.article_publication_media WHERE article_id=$1),
                    (SELECT count(*) FROM public.article_command WHERE article_id=$1 AND command_id=$2),
                    (SELECT count(*) FROM public.blog_outbox WHERE article_id=$1 AND kind='publish' AND processed_at IS NULL),
                    (SELECT count(*) FROM public.article_revision WHERE article_id=$1)
                FROM public.article a LEFT JOIN public.article_publication p ON p.article_id=a.id WHERE a.id=$1
                """, article, key);
            await using var row = await query.ExecuteReaderAsync(ct);
            Assert.True(await row.ReadAsync(ct));
            var revision = row.GetInt64(0);
            Assert.Equal(0L, row.GetInt64(7));
            Assert.Equal(revision, row.GetInt64(8));
            return new(revision, row.IsDBNull(1) ? null : row.GetInt64(1), row.IsDBNull(2) ? null : row.GetInt64(2),
                row.GetInt64(3), row.GetInt64(4), row.GetInt64(5), row.GetInt64(6));
        }

        internal async Task<List<ManifestRow>> Manifest(int article, long publication, CancellationToken ct)
        {
            await using var db = await _db.OpenConnectionAsync(ct);
            await using var command = Store.Sql(db, null, """
                SELECT ordinal::int, asset_id, revision, content_hash, format::smallint, length, width, height
                FROM public.article_publication_media WHERE article_id=$1 AND publication_id=$2 ORDER BY ordinal
                """, article, publication);
            await using var rows = await command.ExecuteReaderAsync(ct);
            var result = new List<ManifestRow>();
            while (await rows.ReadAsync(ct))
                result.Add(new(rows.GetInt32(0), rows.GetGuid(1), rows.GetInt64(2), rows.GetFieldValue<byte[]>(3),
                    rows.GetInt16(4), rows.GetInt32(5), rows.GetInt32(6), rows.GetInt32(7)));
            return result;
        }

        internal async Task ReplacePrivateSource(Guid id, byte[] bytes, CancellationToken ct)
        {
            var path = Path.Combine(_privateDirectory, $"{id:N}.media");
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            try { await File.WriteAllBytesAsync(path, bytes, ct); }
            finally { File.SetUnixFileMode(path, UnixFileMode.UserRead); }
        }

        internal void VerifyDirectoryIsolation()
        {
            Assert.Throws<InvalidOperationException>(() =>
            {
                using var conflict = new PublishedMediaStore(_privateFiles, _webDirectory, _webDirectory);
            });
            Assert.Throws<InvalidOperationException>(() =>
            {
                using var conflict = new PublishedMediaStore(_privateFiles, _privateDirectory, _webDirectory);
            });
        }

        internal string[] PublishedEntries() => Directory.EnumerateFileSystemEntries(_publishedDirectory)
            .Select(path => Path.GetRelativePath(_publishedDirectory, path)).Order(StringComparer.Ordinal).ToArray();

        internal async Task<string> CreatePublicTestLeaf(Asset asset, byte[] bytes, CancellationToken ct)
        {
            var path = Path.Combine(_publishedDirectory, FileName(asset));
            await using var leaf = new FileStream(path, new FileStreamOptions
            {
                Mode = FileMode.CreateNew, Access = FileAccess.Write, UnixCreateMode = UnixFileMode.UserRead
            });
            await leaf.WriteAsync(bytes, ct);
            return path;
        }

        internal async Task VerifyPublicBytes(Asset asset, CancellationToken ct)
        {
            var path = Path.Combine(_publishedDirectory, FileName(asset));
            var stored = await File.ReadAllBytesAsync(path, ct);
            Assert.Equal(UnixFileMode.UserRead, File.GetUnixFileMode(path));
            Assert.Equal(asset.Image.Bytes, stored);
            Assert.Equal(asset.Image.Hash, SHA256.HashData(stored));
        }
    }
}
