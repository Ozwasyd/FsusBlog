using System.Runtime.Versioning;

namespace FsusBlog.V2.Integration.Tests;

public sealed partial class PublishedArticleMediaHttpPostgresTests
{
    [PublicationMediaRecoveryFact]
    public async Task RestoredPrivateBackupRebuildsVerifiedCurrentAndHistoricalImageObjects()
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) return;
        var maintenance = new NpgsqlConnectionStringBuilder(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!);
        if (maintenance.Host is null || !Path.IsPathFullyQualified(maintenance.Host) || maintenance.Host.Contains(','))
            throw new InvalidOperationException("Published-media recovery tests require one native PostgreSQL Unix socket.");
        await using var source = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromMinutes(3));
        var owner = await MediaFixture.CreateSession(source.DataSource, "public image backup owner", ct);
        var site = await source.Scalar<Guid>("SELECT site_id FROM public.authoring_recovery_site WHERE singleton");
        var root = Directory.CreateTempSubdirectory("fsusblog-public-image-recovery-");
        using (new MediaFixture.DirectoryCleanup(root))
        {
            var privateRoot = MediaFixture.CreateOwnedDirectory(root.FullName, "private-source");
            var publicRoot = MediaFixture.CreateOwnedDirectory(root.FullName, "public-source");
            var restoredPrivate = MediaFixture.CreateOwnedDirectory(root.FullName, "private-restore");
            var restoredPublic = MediaFixture.CreateOwnedDirectory(root.FullName, "public-restore");
            var web = MediaFixture.CreateOwnedDirectory(root.FullName, "web");
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
                    MediaFixture.SolidImage(SKEncodedImageFormat.Png, SKColors.SteelBlue), ct);
                current = await Upload(client, owner, "current-private.png", "image/png",
                    MediaFixture.SolidImage(SKEncodedImageFormat.Png, SKColors.SeaGreen), ct);
                Assert.NotEqual(historical.Digest, current.Digest);
                var draft = await SaveDraft(client, owner, "Media recovery", "Original published body.", ct);
                var first = await AttachAndPublish(client, owner, draft, historical.Id, ct);
                historicalPublication = await PublicationId(source, first, ct);
                var second = await AttachAndPublish(client, owner, first, current.Id, ct);
                currentPublication = await PublicationId(source, second, ct);
                article = second.Id;
                Assert.True(historicalPublication < currentPublication);
                expectedManifest = await client.GetByteArrayAsync(ManifestPath(article, currentPublication), ct);
                Assert.Equal(current.Digest, Assert.Single(Wire.DecodePublicArticleMedia(expectedManifest).Images).Digest);
                expectedImage = await client.GetByteArrayAsync(RawPath(article, currentPublication, current.Digest), ct);
                Assert.Equal(current.Bytes, expectedImage);
                await AssertArchivedRoutesHidden(client, article, historicalPublication, historical.Digest, ct);

                var live = await InvokeMigration(source.ConnectionString, "rebuild", site, restoredPrivate, restoredPublic, web, ct);
                AssertFailed(live, "Stop the serving process before changing the database schema.");
            }

            foreach (var image in new[] { historical, current })
            {
                var file = $"{image.Id:N}.media";
                var bytes = await File.ReadAllBytesAsync(Path.Combine(privateRoot, file), ct);
                Assert.Equal(image.Bytes, bytes);
                await MediaFixture.WriteReadOnlyFile(Path.Combine(restoredPrivate, file), bytes, ct, createNew: true);
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
                await using (var conn = await restored.OpenConnectionAsync(ct))
                    Assert.Equal(site, Assert.IsType<Guid>(await FixtureSql.ScalarAsync(conn, null, ct,
                        "SELECT site_id FROM public.authoring_recovery_site WHERE singleton")));

                AssertFailed(await Recover("rebuild", Guid.NewGuid()), "does not match the expected site");
                AssertFailed(await Recover("verify"), "A committed public media object is missing");
                Assert.Empty(Directory.EnumerateFileSystemEntries(restoredPublic));

                var firstObject = string.CompareOrdinal(historical.Digest, current.Digest) < 0 ? historical : current;
                var sourceLeaf = Path.Combine(restoredPrivate, $"{firstObject.Id:N}.media");
                File.Delete(sourceLeaf);
                AssertFailed(await Recover("rebuild"), "A retained private source is missing");
                Assert.Empty(Directory.EnumerateFileSystemEntries(restoredPublic));
                await MediaFixture.WriteReadOnlyFile(sourceLeaf, firstObject.Bytes, ct, createNew: true);

                AssertRecovery(await Recover("rebuild"), rebuilt: 2);
                await VerifyRetainedFiles(restoredPublic, historical, current, ct);
                AssertRecovery(await Recover("verify"), rebuilt: 0);
                AssertRecovery(await Recover("rebuild"), rebuilt: 0);
                await VerifyRetainedFiles(restoredPublic, historical, current, ct);

                var historicalObject = Path.Combine(restoredPublic, historical.Digest + ".media");
                var corrupt = historical.Bytes.ToArray();
                corrupt[^1] ^= 1;
                File.Delete(historicalObject);
                await MediaFixture.WriteReadOnlyFile(historicalObject, corrupt, ct, createNew: true);
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
                await FixtureSql.ExecuteAsync(control, null, CancellationToken.None, $"DROP DATABASE {name} WITH (FORCE)");
            }

            Dictionary<string, string> Config(string privatePath, string publicPath)
            {
                var settings = MediaFixture.PublicSettings(privatePath, publicPath);
                settings["FSUSBLOG_WEB_DIST"] = web;
                return settings;
            }
        }
    }

    private static async Task AssertArchivedRoutesHidden(HttpClient client, int article, long release, string digest, CancellationToken ct)
    {
        var raw = RawPath(article, release, digest);
        await AssertEmptyImageResponse(client, HttpMethod.Get, raw, HttpStatusCode.NotFound, ct);
        await AssertEmptyImageResponse(client, HttpMethod.Head, raw, HttpStatusCode.NotFound, ct);
        await AssertHiddenManifest(client, ManifestPath(article, release), ct);
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

    private static Task<FixtureProcess.Result> InvokeMigration(string dsn, string operation, Guid site, string privateRoot,
        string publicRoot, string web, CancellationToken ct) =>
        FixtureProcess.Run(FixtureProcess.Migration(dsn, "article-public-media", operation, site.ToString("D"), privateRoot, publicRoot, web), ct);

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
    internal const string MigrationPath = "FSUSBLOG_TEST_CLI_DLL";
    internal const string PostgresPath = "PG_TOOLS_DIR";

    public PublicationMediaRecoveryFactAttribute()
    {
        if (new[] { ScratchDatabase.Variable, MigrationPath, PostgresPath }
            .Any(variable => string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(variable))))
            Skip = $"Set {ScratchDatabase.Variable}, {MigrationPath}, and {PostgresPath} for native published-image recovery.";
    }
}
