using System.Globalization;
using System.Net;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Content;
using Npgsql;
using SkiaSharp;

namespace FsusBlog.V2.Integration.Tests;

public sealed partial class PublishedArticleMediaHttpPostgresTests
{
    [PublicationMediaRecoveryFact]
    public async Task RestoredPrivateBackupRebuildsVerifiedCurrentAndHistoricalImageObjects()
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(3));
        var ct = deadline.Token;
        var maintenance = new NpgsqlConnectionStringBuilder(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!);
        if (maintenance.Host is null || !Path.IsPathFullyQualified(maintenance.Host) || maintenance.Host.Contains(','))
            throw new InvalidOperationException("Published-media recovery tests require one native PostgreSQL Unix socket.");
        await using var source = await ScratchDatabase.Create(maintenance.ConnectionString, ct);
        var owner = await CreateSession(source.DataSource, "public image backup owner", ct);
        var site = await SiteId(source.DataSource, ct);
        var root = Directory.CreateTempSubdirectory("fsusblog-public-image-recovery-");
        try
        {
            var privateRoot = OwnedDirectory(root, "private-source");
            var publicRoot = OwnedDirectory(root, "public-source");
            var restoredPrivate = OwnedDirectory(root, "private-restore");
            var restoredPublic = OwnedDirectory(root, "public-restore");
            var web = OwnedDirectory(root, "web");
            await File.WriteAllTextAsync(Path.Combine(web, "index.html"),
                "<html lang=\"en\"><head><title>Fsu's Blog</title></head><body><!--fsus-public-content--></body></html>", ct);

            Asset historical, current;
            int article;
            long historicalPublication, currentPublication;
            byte[] expectedManifest, expectedImage;
            await using (var server = await ServerProcess.Start(source.ConnectionString, ct, Config(privateRoot, publicRoot)))
            {
                var client = server.Client;
                historical = await Upload(client, owner, "historical-private.png", "image/png",
                    Image(SKEncodedImageFormat.Png, SKColors.SteelBlue), ct);
                current = await Upload(client, owner, "current-private.png", "image/png",
                    Image(SKEncodedImageFormat.Png, SKColors.SeaGreen), ct);
                Assert.NotEqual(historical.Digest, current.Digest);
                var draft = await PostDraft(client, WireRoutes.Save,
                    Wire.EncodeArticleCommand(new(0, 0, Guid.NewGuid(), "Media recovery", "Original published body.")), owner, ct);
                var first = await Release(await Attach(client, owner, draft, historical.Id, ct), historical);
                historicalPublication = await PublicationId(source.DataSource, first, ct);
                var second = await Release(await Attach(client, owner, first, current.Id, ct), current);
                currentPublication = await PublicationId(source.DataSource, second, ct);
                article = second.Id;
                Assert.True(historicalPublication < currentPublication);
                expectedManifest = await client.GetByteArrayAsync(ManifestPath(article, currentPublication), ct);
                Assert.Equal(current.Digest, Assert.Single(Wire.DecodePublicArticleMedia(expectedManifest).Images).Digest);
                expectedImage = await client.GetByteArrayAsync(RawPath(article, currentPublication, current.Digest), ct);
                Assert.Equal(current.Bytes, expectedImage);
                await AssertArchivedRoutesHidden(client, article, historicalPublication, historical.Digest, ct);

                var live = await InvokeMigration(source.ConnectionString, "rebuild", site, restoredPrivate, restoredPublic, web, ct);
                AssertFailed(live, "Stop the serving process before changing the database schema.");

                Task<Draft> Release(Draft revision, Asset image) =>
                    PostDraft(client, WireRoutes.ArticlePublishImages,
                        Wire.EncodeArticlePublishImages(new(revision.Id, revision.Revision, Guid.NewGuid(), [image.Id])), owner, ct);
            }

            foreach (var image in new[] { historical, current })
            {
                var file = $"{image.Id:N}.media";
                var bytes = await File.ReadAllBytesAsync(Path.Combine(privateRoot, file), ct);
                Assert.Equal(image.Bytes, bytes);
                await CreateReadOnlyLeaf(Path.Combine(restoredPrivate, file), bytes, ct);
            }

            var name = $"fsusv2_media_restore_{Guid.NewGuid():N}";
            var restore = new NpgsqlConnectionStringBuilder(maintenance.ConnectionString) { Database = name };
            await using var control = new NpgsqlConnection(maintenance.ConnectionString);
            await control.OpenAsync(ct);
            await FixtureSql.ExecuteAsync(control, null, ct, $"CREATE DATABASE {name} TEMPLATE template0");
            try
            {
                var dump = Path.Combine(root.FullName, "site.dump");
                AssertSuccess(await RunPostgres("pg_dump", new NpgsqlConnectionStringBuilder(source.ConnectionString),
                    ["--no-password", "--format=custom", "--file", dump], ct));
                AssertSuccess(await RunPostgres("pg_restore", restore,
                    ["--no-password", "--single-transaction", "--exit-on-error", "--no-owner", "--no-privileges", "--dbname", name, dump], ct));
                await using var restored = NpgsqlDataSource.Create(restore.ConnectionString);
                Assert.Equal(site, await SiteId(restored, ct));

                var wrongSite = await Recover("rebuild", Guid.NewGuid());
                AssertFailed(wrongSite, "does not match the expected site");
                var missing = await Recover("verify");
                AssertFailed(missing, "A committed public media object is missing");
                Assert.Empty(Directory.EnumerateFileSystemEntries(restoredPublic));

                var firstObject = string.CompareOrdinal(historical.Digest, current.Digest) < 0 ? historical : current;
                var sourceLeaf = Path.Combine(restoredPrivate, $"{firstObject.Id:N}.media");
                File.Delete(sourceLeaf);
                AssertFailed(await Recover("rebuild"), "A retained private source is missing");
                Assert.Empty(Directory.EnumerateFileSystemEntries(restoredPublic));
                await CreateReadOnlyLeaf(sourceLeaf, firstObject.Bytes, ct);

                AssertRecovery(await Recover("rebuild"), rebuilt: 2);
                await VerifyRetainedFiles(restoredPublic, historical, current, ct);
                AssertRecovery(await Recover("verify"), rebuilt: 0);
                AssertRecovery(await Recover("rebuild"), rebuilt: 0);
                await VerifyRetainedFiles(restoredPublic, historical, current, ct);

                var historicalObject = Path.Combine(restoredPublic, historical.Digest + ".media");
                var corrupt = historical.Bytes.ToArray();
                corrupt[^1] ^= 1;
                File.Delete(historicalObject);
                await CreateReadOnlyLeaf(historicalObject, corrupt, ct);
                AssertFailed(await Recover("verify"), "Media bytes do not match their committed digest.");
                AssertFailed(await Recover("rebuild"), "Media bytes do not match their committed digest.");
                Assert.Equal(corrupt, await File.ReadAllBytesAsync(historicalObject, ct));
                Assert.Equal(current.Bytes, await File.ReadAllBytesAsync(Path.Combine(restoredPublic, current.Digest + ".media"), ct));
                File.Delete(historicalObject);
                AssertRecovery(await Recover("rebuild"), rebuilt: 1);
                AssertRecovery(await Recover("verify"), rebuilt: 0);
                await VerifyRetainedFiles(restoredPublic, historical, current, ct);

                await using var recoveredServer = await ServerProcess.Start(restore.ConnectionString, ct, Config(restoredPrivate, restoredPublic));
                var client = recoveredServer.Client;
                Assert.Equal(expectedManifest, await client.GetByteArrayAsync(ManifestPath(article, currentPublication), ct));
                Assert.Equal(expectedImage, await client.GetByteArrayAsync(RawPath(article, currentPublication, current.Digest), ct));
                await AssertImage(client, RawPath(article, currentPublication, current.Digest), current, ct);
                await AssertArchivedRoutesHidden(client, article, historicalPublication, historical.Digest, ct);

                Task<FixtureProcess.Result> Recover(string operation, Guid? expectedSite = null) =>
                    InvokeMigration(restore.ConnectionString, operation, expectedSite ?? site, restoredPrivate, restoredPublic, web, ct);

            }
            finally
            {
                await using var drop = new NpgsqlCommand($"DROP DATABASE {name} WITH (FORCE)", control);
                await drop.ExecuteNonQueryAsync();
            }

            Dictionary<string, string> Config(string privatePath, string publicPath) => new()
            {
                ["FSUSBLOG_WEB_DIST"] = web,
                [MediaEndpoints.StorageSetting] = privatePath,
                [PublishedMediaEndpoints.StorageSetting] = publicPath
            };
        }
        finally { root.Delete(recursive: true); }
    }

    private static async Task AssertArchivedRoutesHidden(HttpClient client, int article, long release, string digest, CancellationToken ct)
    {
        var raw = RawPath(article, release, digest);
        await AssertEmptyImageResponse(client, HttpMethod.Get, raw, HttpStatusCode.NotFound, ct);
        await AssertEmptyImageResponse(client, HttpMethod.Head, raw, HttpStatusCode.NotFound, ct);
        using var manifest = await client.GetAsync(ManifestPath(article, release), ct);
        Assert.Equal(HttpStatusCode.NotFound, manifest.StatusCode);
        Assert.True(manifest.Headers.CacheControl?.NoStore);
        Assert.Empty(await manifest.Content.ReadAsByteArrayAsync(ct));
    }

    [UnsupportedOSPlatform("windows")]
    private static async Task VerifyRetainedFiles(string directory, Asset historical, Asset current, CancellationToken ct)
    {
        var expected = new[] { historical, current }.OrderBy(image => image.Digest, StringComparer.Ordinal).ToArray();
        var actual = Directory.GetFileSystemEntries(directory).Order(StringComparer.Ordinal).ToArray();
        Assert.Equal(expected.Select(image => image.Digest + ".media"), actual.Select(path => Path.GetFileName(path)!));
        for (var i = 0; i < actual.Length; i++)
        {
            Assert.Equal(UnixFileMode.UserRead, File.GetUnixFileMode(actual[i]));
            var bytes = await File.ReadAllBytesAsync(actual[i], ct);
            Assert.Equal(expected[i].Digest, Convert.ToHexStringLower(SHA256.HashData(bytes)));
            Assert.Equal(expected[i].Bytes, bytes);
        }
    }

    private static async Task<Guid> SiteId(NpgsqlDataSource source, CancellationToken ct)
    {
        await using var db = await source.OpenConnectionAsync(ct);
        return Assert.IsType<Guid>(await FixtureSql.ScalarAsync(db, null, ct, "SELECT site_id FROM public.authoring_recovery_site WHERE singleton"));
    }

    [UnsupportedOSPlatform("windows")]
    private static async Task CreateReadOnlyLeaf(string path, byte[] bytes, CancellationToken ct)
    {
        await using (var file = new FileStream(path, new FileStreamOptions
        {
            Mode = FileMode.CreateNew, Access = FileAccess.Write, UnixCreateMode = UnixFileMode.UserRead
        }))
            await file.WriteAsync(bytes, ct);
        File.SetUnixFileMode(path, UnixFileMode.UserRead);
    }

    private static Task<FixtureProcess.Result> InvokeMigration(string dsn, string operation, Guid site, string privateRoot,
        string publicRoot, string web, CancellationToken ct)
    {
        var dotnet = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ??
            Environment.GetEnvironmentVariable("DOTNET_BIN") ?? "dotnet";
        var migrate = Environment.GetEnvironmentVariable(PublicationMediaRecoveryFactAttribute.MigrationPath)!;
        if (!Path.IsPathFullyQualified(migrate) || !File.Exists(migrate))
            throw new InvalidOperationException("Supply the absolute path to the built migration CLI.");
        var command = FixtureProcess.Command(dotnet, [migrate, "article-public-media", operation, site.ToString("D"), privateRoot, publicRoot, web]);
        command.Environment["FSUSBLOG_DB"] = dsn;
        return FixtureProcess.Run(command, ct);
    }

    private static Task<FixtureProcess.Result> RunPostgres(string executable, NpgsqlConnectionStringBuilder settings,
        string[] args, CancellationToken ct)
    {
        var tools = Environment.GetEnvironmentVariable(PublicationMediaRecoveryFactAttribute.PostgresPath)!;
        if (!Path.IsPathFullyQualified(tools))
            throw new InvalidOperationException("Supply the absolute directory of native PostgreSQL tools.");
        var command = FixtureProcess.Command(Path.Combine(tools, executable), args);
        foreach (var name in new[] { "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGPASSFILE", "PGOPTIONS" })
            command.Environment.Remove(name);
        command.Environment["PGHOST"] = settings.Host;
        command.Environment["PGPORT"] = settings.Port.ToString(CultureInfo.InvariantCulture);
        command.Environment["PGUSER"] = settings.Username;
        command.Environment["PGDATABASE"] = settings.Database;
        command.Environment["PGPASSWORD"] = settings.Password;
        command.Environment["PGCONNECT_TIMEOUT"] = "5";
        command.Environment["PGSSLMODE"] = "disable";
        return FixtureProcess.Run(command, ct);
    }

    private static void AssertSuccess(FixtureProcess.Result result) => Assert.True(result.Code == 0, result.Output + result.Error);

    private static void AssertRecovery(FixtureProcess.Result result, int rebuilt)
    {
        AssertSuccess(result);
        using var report = JsonDocument.Parse(result.Output);
        var json = report.RootElement;
        Assert.Equal(2, json.GetProperty("checkedSources").GetInt32());
        Assert.Equal(2, json.GetProperty("checkedObjects").GetInt32());
        Assert.Equal(rebuilt, json.GetProperty("rebuiltObjects").GetInt32());
    }

    private static void AssertFailed(FixtureProcess.Result result, string reason)
    {
        Assert.NotEqual(0, result.Code);
        Assert.Contains(reason, result.Output + result.Error, StringComparison.OrdinalIgnoreCase);
    }
}

internal sealed class PublicationMediaRecoveryFactAttribute : FactAttribute
{
    internal const string MigrationPath = "FSUSBLOG_TEST_MIGRATE_DLL";
    internal const string PostgresPath = "PG_TOOLS_DIR";

    public PublicationMediaRecoveryFactAttribute()
    {
        if (new[] { ScratchDatabase.Variable, MigrationPath, PostgresPath }
            .Any(variable => string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(variable))))
            Skip = $"Set {ScratchDatabase.Variable}, {MigrationPath}, and {PostgresPath} for native published-image recovery.";
    }
}
