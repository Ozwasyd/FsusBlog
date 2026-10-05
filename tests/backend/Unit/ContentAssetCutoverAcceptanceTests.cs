using System.Security.Cryptography;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Http;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class ContentAssetCutoverAcceptanceTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public void Migration_IsSingleTransactionalBackfillBeforeLegacyRetirement()
    {
        ISchemaMigrationDescriptor migration = ContentAssetCutoverMigrationDefinitions.BuildMigration();

        Assert.True(migration.Transactional);
        Assert.Contains(migration.Steps, static step => step is ContentAssetCutoverBackfillStep);
        int backfill = migration.Steps.ToList().FindIndex(static step => step is ContentAssetCutoverBackfillStep);
        int retirement = migration.Steps.ToList().FindLastIndex(static step => step is RawSqlStep);
        Assert.True(backfill >= 0 && retirement > backfill);
        Assert.Contains("DROP TABLE IF EXISTS", migration.Steps[retirement].Fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Backfill_IsFailClosedAndVerifiesPhysicalMetadata()
    {
        var cases = new[]
        {
            new BackfillFailureCase("illustration/missing.png", null, null, "missing_file:"),
            new BackfillFailureCase(
                "illustration/hash.png",
                CreatePng(),
                new string('0', 64),
                "hash_conflict:"),
            new BackfillFailureCase("illustration/media.png", [1, 2, 3, 4], null, "unrecognized_media:"),
            new BackfillFailureCase("../outside.png", null, null, "invalid_prototype_asset:")
        };

        foreach (BackfillFailureCase testCase in cases)
        {
            string databaseName = await fixture.CreateDatabaseAsync();
            string connectionString = fixture.BuildDatabaseConnectionString(databaseName);
            string storageRoot = Path.Combine(
                Path.GetTempPath(),
                $"fsusblog-content-asset-proof-{Guid.NewGuid():N}");
            Directory.CreateDirectory(storageRoot);
            try
            {
                using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
                PostgresSqlSugarTestClient.InitTables(
                    db,
                    typeof(ContentAsset),
                    typeof(ContentAssetCleanupQueueItem),
                    typeof(ContentAssetReference),
                    typeof(Article),
                    typeof(ArticleBody),
                    typeof(ArticleDraft),
                    typeof(ArticleRevision),
                    typeof(ArticleRevisionContentBlock));
                ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(storageRoot);
                Directory.CreateDirectory(Path.Combine(paths.PublicAssetRoot, "illustration"));
                if (testCase.FileBytes is not null)
                {
                    string filePath = Path.Combine(
                        paths.PublicAssetRoot,
                        testCase.StorageKey.Replace('/', Path.DirectorySeparatorChar));
                    Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);
                    await File.WriteAllBytesAsync(
                        filePath,
                        testCase.FileBytes);
                }

                db.Insertable(new ContentAsset
                {
                    AssetId = Guid.NewGuid(),
                    StorageClass = "public",
                    StorageKey = testCase.StorageKey,
                    MimeType = "image/png",
                    Extension = ".png",
                    SizeBytes = testCase.FileBytes?.LongLength ?? 0,
                    Sha256 = testCase.ExpectedHash ?? string.Empty,
                    WidthPixels = 1,
                    HeightPixels = 1,
                    State = ContentAssetStates.Active,
                    CreatedAtUtc = DateTime.UtcNow,
                    UpdatedAtUtc = DateTime.UtcNow
                }).ExecuteCommand();

                InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(
                    () => ContentAssetCutoverBackfill.ExecuteAsync(
                        db,
                        paths.PublicAssetRoot,
                        CancellationToken.None));

                Assert.Contains(testCase.ExpectedFailure, failure.ToString(), StringComparison.Ordinal);
                ContentAsset preserved = Assert.Single(db.Queryable<ContentAsset>().ToList());
                Assert.Equal(testCase.StorageKey, preserved.StorageKey);
            }
            finally
            {
                Directory.Delete(storageRoot, recursive: true);
            }
        }
    }

    [Fact]
    public void CanonicalSchemaUsesPostgreSqlUuidIdentityAndPreCodeFirstPrototypeConversion()
    {
        ISchemaMigrationDescriptor shape = ContentAssetCutoverMigrationDefinitions.BuildPrototypeShapeMigration();
        ISchemaMigrationDescriptor cutover = ContentAssetCutoverMigrationDefinitions.BuildMigration();
        string shapeSql = Assert.IsType<RawSqlStep>(Assert.Single(shape.Steps)).Fingerprint;
        string cutoverSql = string.Join('\n', cutover.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PreCodeFirst, shape.Phase);
        Assert.Contains("RENAME COLUMN asset_id TO id", shapeSql, StringComparison.Ordinal);
        Assert.Contains("ALTER COLUMN id TYPE uuid", shapeSql, StringComparison.Ordinal);
        Assert.Contains("id uuid PRIMARY KEY", cutoverSql, StringComparison.Ordinal);
        Assert.Contains("asset_id uuid NOT NULL REFERENCES content_asset(id)", cutoverSql, StringComparison.Ordinal);
        Assert.Equal(typeof(Guid), typeof(FsusBlog.Server.Entities.ContentAsset).GetProperty("AssetId")!.PropertyType);
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-asset-store-{Guid.NewGuid():N}");
        Assert.True(LocalContentAssetStore.TryResolveStoragePath(root, "illustration/hero.png", out string resolved));
        Assert.StartsWith(Path.GetFullPath(root), resolved, StringComparison.Ordinal);
        Assert.False(LocalContentAssetStore.TryResolveStoragePath(root, "../outside.png", out _));
    }

    [Theory]
    [InlineData("none")]
    [InlineData("after-backfill")]
    [InlineData("after-legacy-retirement")]
    public async Task Backfill_ReusesPrototypeRebuildsReferencesAndMovesCleanupByAssetId(string interruptionPoint)
    {
        string databaseName = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(databaseName);
        string storageRoot = Path.Combine(
            Path.GetTempPath(),
            $"fsusblog-content-asset-success-{Guid.NewGuid():N}");
        Directory.CreateDirectory(storageRoot);
        try
        {
            using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
            PostgresSqlSugarTestClient.InitTables(
                db,
                typeof(ContentAsset),
                typeof(ContentAssetCleanupQueueItem),
                typeof(ContentAssetReference),
                typeof(Article),
                typeof(ArticleBody),
                typeof(ArticleDraft),
                typeof(ArticleRevision),
                typeof(ArticleRevisionContentBlock));
            ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(storageRoot);
            Directory.CreateDirectory(Path.Combine(paths.PublicAssetRoot, "illustration"));

            byte[] png = CreatePng();
            string hash = Convert.ToHexString(SHA256.HashData(png)).ToLowerInvariant();
            Guid prototypeId = Guid.NewGuid();
            Guid orphanId = Guid.NewGuid();
            Guid preservedPrivateId = Guid.NewGuid();
            await File.WriteAllBytesAsync(
                Path.Combine(paths.PublicAssetRoot, "illustration", "shared.png"),
                png);
            await File.WriteAllBytesAsync(
                Path.Combine(paths.PublicAssetRoot, "illustration", $"{orphanId:N}.png"),
                png);
            await File.WriteAllBytesAsync(
                Path.Combine(paths.PublicAssetRoot, "illustration", "cleanup.png"),
                png);

            db.Insertable(new ContentAsset
            {
                AssetId = prototypeId,
                StorageClass = "public",
                StorageKey = "illustration/shared.png",
                MimeType = "image/png",
                Extension = ".png",
                SizeBytes = png.LongLength,
                Sha256 = hash,
                WidthPixels = 1,
                HeightPixels = 1,
                State = ContentAssetStates.Active,
                CreatedAtUtc = DateTime.UtcNow.AddDays(-1),
                UpdatedAtUtc = DateTime.UtcNow.AddDays(-1)
            }).ExecuteCommand();
            db.Insertable(new ContentAsset
            {
                AssetId = preservedPrivateId,
                StorageClass = "private",
                StorageKey = "private/opaque.bin",
                MimeType = "application/octet-stream",
                Extension = ".bin",
                SizeBytes = 3,
                State = ContentAssetStates.Active,
                CreatedAtUtc = DateTime.UtcNow.AddDays(-1),
                UpdatedAtUtc = DateTime.UtcNow.AddDays(-1)
            }).ExecuteCommand();

            await fixture.ExecuteAsync(connectionString, $"""
                CREATE TABLE article_asset_cleanup_queue (
                    normalized_url varchar(512) PRIMARY KEY,
                    not_before_utc timestamp NOT NULL,
                    attempt_count integer NOT NULL,
                    last_error varchar(512) NULL,
                    updated_at_utc timestamp NOT NULL
                );
                INSERT INTO article_asset_cleanup_queue(
                    normalized_url, not_before_utc, attempt_count, last_error, updated_at_utc)
                VALUES ('/uploads/illustration/cleanup.png', TIMESTAMP '2026-08-20 00:00:00', 4,
                    'legacy retry', TIMESTAMP '2026-08-19 00:00:00');
                CREATE TABLE article_asset_reference (
                    normalized_url varchar(512) NOT NULL,
                    source_kind varchar(16) NOT NULL,
                    source_key varchar(160) NOT NULL,
                    article_id integer NULL
                );
                CREATE TABLE asset_library_article_ref (
                    url varchar(512) NOT NULL,
                    article_id integer NOT NULL
                );
                CREATE TABLE asset_library_item (
                    url varchar(512) PRIMARY KEY,
                    sha256 varchar(64) NULL
                );
                INSERT INTO asset_library_item(url, sha256)
                VALUES ('/uploads/illustration/shared.png', '{hash}');
                INSERT INTO article(id, title, categoryid, views, createtime, metadata_updated_at, status, isdeleted)
                VALUES (1975001, 'Asset cutover', 0, 0, now(), now(), 2, false);
                INSERT INTO article_body(article_id, markdown_content, updated_at)
                VALUES (1975001,
                    '![first](/uploads/illustration/shared.png) ![second](/uploads/illustration/shared.png)', now());
                INSERT INTO article_draft(
                    owner_admin_principal_id, article_id, draft_key, title, categoryid, tag_ids,
                    markdown_content, status, server_revision, updated_at, created_at)
                VALUES (44, 1975001, 'asset-cutover', 'Draft', 0, '',
                    '![draft](/uploads/illustration/shared.png)', 2, 1, now(), now());
                WITH block AS (
                    INSERT INTO article_revision_content_block(content_hash, markdown_content, byte_length, created_at)
                    VALUES ('{new string('a', 64)}', '![revision](/uploads/illustration/shared.png)', 47, now())
                    RETURNING id
                )
                INSERT INTO article_revision(
                    article_id, revision_no, title, categoryid, tag_ids, content_block_id,
                    markdown_content, diff_summary, created_by_admin_principal_id, created_at)
                SELECT 1975001, 1, 'Revision', 0, '', id, '', '', 44, now() FROM block;
                INSERT INTO article_asset_reference(normalized_url, source_kind, source_key, article_id)
                VALUES ('/uploads/illustration/shared.png', 'article', '1975001', 1975001);
                INSERT INTO article_asset_reference(normalized_url, source_kind, source_key, article_id)
                VALUES ('/uploads/illustration/shared.png', 'draft', '44:asset-cutover', 1975001);
                INSERT INTO article_asset_reference(normalized_url, source_kind, source_key, article_id)
                VALUES ('/uploads/illustration/shared.png', 'revision', '1', 1975001);
                INSERT INTO asset_library_article_ref(url, article_id)
                VALUES ('/uploads/illustration/shared.png', 1975001);
                """);

            using IDisposable storageScope = ContentAssetCutoverBackfillContext.Push(paths.PublicAssetRoot);
            ISchemaMigrationDescriptor migration = ContentAssetCutoverMigrationDefinitions.BuildMigration();
            SchemaMigrationStep? interruptedStep = interruptionPoint switch
            {
                "none" => null,
                "after-backfill" => Assert.Single(migration.Steps.OfType<ContentAssetCutoverBackfillStep>()),
                "after-legacy-retirement" => migration.Steps[^1],
                _ => throw new ArgumentOutOfRangeException(nameof(interruptionPoint))
            };
            if (interruptedStep is not null)
            {
                ContentAsset[] originalAssets = db.Queryable<ContentAsset>()
                    .OrderBy(item => item.AssetId)
                    .ToArray();
                bool interruptionReached = false;
                InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(
                    () => SchemaMigrationTransactionExecutor.ExecuteAsync(
                        db,
                        migration,
                        async (step, token) =>
                        {
                            await step.ExecuteAsync(db, token);
                            if (ReferenceEquals(step, interruptedStep))
                            {
                                Assert.Equal(4, await db.Queryable<ContentAsset>().CountAsync());
                                Assert.Equal(3, await db.Queryable<ContentAssetReference>().CountAsync());
                                Assert.Equal(
                                    interruptionPoint == "after-backfill" ? 4 : 0,
                                    db.Ado.GetInt("""
                                        SELECT COUNT(*) FROM pg_tables
                                        WHERE schemaname = 'public' AND tablename IN (
                                            'article_asset_cleanup_queue', 'article_asset_reference',
                                            'asset_library_article_ref', 'asset_library_item');
                                        """));
                                interruptionReached = true;
                                throw new InvalidOperationException("controlled_cutover_interruption");
                            }
                        },
                        CancellationToken.None));

                Assert.True(interruptionReached);
                Assert.Contains("controlled_cutover_interruption", failure.ToString(), StringComparison.Ordinal);
                Assert.Equivalent(
                    originalAssets,
                    db.Queryable<ContentAsset>().OrderBy(item => item.AssetId).ToArray(),
                    strict: true);
                Assert.Empty(db.Queryable<ContentAssetReference>().ToList());
                Assert.Empty(db.Queryable<ContentAssetCleanupQueueItem>().ToList());
                Assert.True(await fixture.TableExistsAsync(connectionString, "article_asset_cleanup_queue"));
                Assert.True(await fixture.TableExistsAsync(connectionString, "article_asset_reference"));
                Assert.True(await fixture.TableExistsAsync(connectionString, "asset_library_article_ref"));
                Assert.True(await fixture.TableExistsAsync(connectionString, "asset_library_item"));
                Assert.Equal(3, db.Ado.GetInt("SELECT COUNT(*) FROM article_asset_reference;"));
                Assert.Equal(1, db.Ado.GetInt("SELECT COUNT(*) FROM asset_library_article_ref;"));
                Assert.Equal(hash, db.Ado.GetString("SELECT sha256 FROM asset_library_item;"));
                Assert.Equal(4, db.Ado.GetInt("SELECT attempt_count FROM article_asset_cleanup_queue;"));
                Assert.Equal(png, await File.ReadAllBytesAsync(Path.Combine(paths.PublicAssetRoot, "illustration", "shared.png")));
            }

            await SchemaMigrationTransactionExecutor.ExecuteAsync(
                db,
                migration,
                (step, token) => step.ExecuteAsync(db, token),
                CancellationToken.None);

            ContentAsset reused = await db.Queryable<ContentAsset>()
                .SingleAsync(item => item.StorageKey == "illustration/shared.png");
            string orphanStorageKey = $"illustration/{orphanId:N}.png";
            ContentAsset orphan = await db.Queryable<ContentAsset>()
                .SingleAsync(item => item.StorageKey == orphanStorageKey);
            ContentAsset cleanup = await db.Queryable<ContentAsset>()
                .SingleAsync(item => item.StorageKey == "illustration/cleanup.png");
            ContentAssetReference reference = await db.Queryable<ContentAssetReference>()
                .SingleAsync(item => item.SourceKind == "article" && item.SourceKey == "1975001");
            int referenceRowCount = await db.Queryable<ContentAssetReference>().CountAsync();

            Assert.Equal(prototypeId, reused.AssetId);
            Assert.Equal(orphanId, orphan.AssetId);
            Assert.Equal(3, referenceRowCount);
            Assert.Equal(
                preservedPrivateId,
                (await db.Queryable<ContentAsset>()
                    .SingleAsync(item => item.StorageKey == "private/opaque.bin"))
                .AssetId);
            Assert.Equal(2, reference.ReferenceCount);
            Assert.Equal("active", reused.State);
            Assert.Equal("pending_delete", cleanup.State);
            ContentAssetCleanupQueueItem cleanupQueue = await db.Queryable<ContentAssetCleanupQueueItem>()
                .SingleAsync(item => item.AssetId == cleanup.AssetId);
            Assert.Equal(4, cleanupQueue.AttemptCount);
            Assert.Equal(new DateTime(2026, 8, 20, 0, 0, 0, DateTimeKind.Utc), cleanupQueue.NotBeforeUtc);
            Assert.Equal("legacy retry", cleanupQueue.LastError);
            Assert.Equal(new DateTime(2026, 8, 19, 0, 0, 0, DateTimeKind.Utc), cleanupQueue.UpdatedAtUtc);
            Assert.False(await db.Queryable<ContentAssetCleanupQueueItem>()
                .AnyAsync(item => item.AssetId == reused.AssetId));
            Assert.False(await fixture.TableExistsAsync(connectionString, "article_asset_cleanup_queue"));
            Assert.False(await fixture.TableExistsAsync(connectionString, "article_asset_reference"));
            Assert.False(await fixture.TableExistsAsync(connectionString, "asset_library_article_ref"));
            Assert.False(await fixture.TableExistsAsync(connectionString, "asset_library_item"));
        }
        finally
        {
            Directory.Delete(storageRoot, recursive: true);
        }
    }

    [Fact]
    public async Task RuntimeHasOneLedgerAndNoUrlDeleteIdentity()
    {
        AssetId assetId = AssetId.Parse("3f3b2e7a-1d2e-4f8a-9c5b-6a7b8c9d0e1f");
        IAssetStore validStore = Substitute.For<IAssetStore>();
        validStore.DeleteAsync(assetId, Arg.Any<CancellationToken>())
            .Returns(new AssetDeleteOutcome(AssetDeleteResult.Deleted));
        var aeds = new AedsEncoder();
        DefaultHttpContext validContext = ContentAssetDeleteEndpointTests.CreateContext(assetId.ToString());

        var validResult = await BinaryEndpoints.HandleFileDeleteAsync(
            validContext,
            validStore,
            aeds,
            CancellationToken.None);
        AedsDecodeResult validFrame = await ContentAssetDeleteEndpointTests.ExecuteAndDecodeAsync(
            validResult,
            validContext,
            aeds);

        Assert.Equal(AedsFrameType.EmptySuccess, validFrame.FrameType);
        await validStore.Received(1).DeleteAsync(assetId, Arg.Any<CancellationToken>());

        foreach (string rejectedIdentity in new[]
        {
            "/uploads/illustration/hero.png",
            "https://example.test/uploads/illustration/hero.png"
        })
        {
            IAssetStore rejectedStore = Substitute.For<IAssetStore>();
            DefaultHttpContext rejectedContext = ContentAssetDeleteEndpointTests.CreateContext(rejectedIdentity);
            var rejectedResult = await BinaryEndpoints.HandleFileDeleteAsync(
                rejectedContext,
                rejectedStore,
                aeds,
                CancellationToken.None);
            AedsDecodeResult rejectedFrame = await ContentAssetDeleteEndpointTests.ExecuteAndDecodeAsync(
                rejectedResult,
                rejectedContext,
                aeds);

            Assert.Equal(AedsFrameType.ApiError, rejectedFrame.FrameType);
            Assert.True(PodBinaryCodec.TryDecodeApiError(rejectedFrame.Payload, out var errorPod));
            Assert.Equal(ErrorCode.Validation, PodBinaryCodec.ToErrorDetail(errorPod).Code);
            await rejectedStore.DidNotReceiveWithAnyArgs().DeleteAsync(default, default);
        }

        Assert.DoesNotContain(
            typeof(FileService).GetMethods(),
            static method => string.Equals(method.Name, "DeleteImageAsync", StringComparison.Ordinal));
        Assert.DoesNotContain(
            typeof(ArticleAssetCleanupPolicy).GetMethods(),
            static method => method.GetParameters().Any(parameter =>
                parameter.ParameterType == typeof(string)
                || parameter.ParameterType == typeof(IEnumerable<string>)));
        Assert.DoesNotContain(
            typeof(IArticleMutationSideEffectCoordinator).GetMethods().Where(static method =>
                method.Name is nameof(IArticleMutationSideEffectCoordinator.AfterPermanentlyDeletedAsync)
                    or nameof(IArticleMutationSideEffectCoordinator.AfterTrashClearedAsync)),
            static method => method.GetParameters().Any(parameter =>
                parameter.ParameterType == typeof(string)
                || parameter.ParameterType == typeof(IEnumerable<string>)
                || parameter.ParameterType == typeof(IReadOnlyDictionary<int, string>)));
        Assert.Contains(typeof(AuthoringAssetLibraryService).GetInterfaces(), static type => type == typeof(IAuthoringAssetQuery));
        Assert.Contains(typeof(AuthoringAssetLibraryService).GetInterfaces(), static type => type == typeof(IAuthoringAssetCommands));
    }

    [Fact]
    public void DeleteInterface_IsStronglyTypedAssetId()
    {
        System.Reflection.MethodInfo method = Assert.Single(typeof(IAssetStore).GetMethods());
        Assert.Equal(typeof(AssetId), method.GetParameters()[0].ParameterType);
        Assert.DoesNotContain(
            typeof(BinaryEndpoints).GetMethods(System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic),
            static method => method.Name.Contains("NormalizeImageDelete", StringComparison.Ordinal));
        Assert.NotNull(typeof(AuthoringAssetLibraryService));
    }

    [Theory]
    [InlineData("case-distinct")]
    [InlineData("exact-repeat")]
    [InlineData("missing-lower")]
    public async Task Backfill_PreservesCaseExactSourceEdgesAndRejectsMissingCaseVariant(string scenario)
    {
        string databaseName = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(databaseName);
        string storageRoot = Path.Combine(
            Path.GetTempPath(),
            $"fsusblog-content-asset-case-proof-{Guid.NewGuid():N}");
        Directory.CreateDirectory(storageRoot);
        try
        {
            using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
            PostgresSqlSugarTestClient.InitTables(
                db,
                typeof(ContentAsset),
                typeof(ContentAssetCleanupQueueItem),
                typeof(ContentAssetReference),
                typeof(Article),
                typeof(ArticleBody),
                typeof(ArticleDraft),
                typeof(ArticleRevision),
                typeof(ArticleRevisionContentBlock));
            ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(storageRoot);
            string illustrationRoot = Path.Combine(paths.PublicAssetRoot, "illustration");
            Directory.CreateDirectory(illustrationRoot);
            byte[] png = CreateCompletePng();
            string upperPath = Path.Combine(illustrationRoot, "Case.png");
            string lowerPath = Path.Combine(illustrationRoot, "case.png");
            await File.WriteAllBytesAsync(upperPath, png);
            if (scenario == "case-distinct")
            {
                await File.WriteAllBytesAsync(lowerPath, png);
                Assert.Equal(2, Directory.EnumerateFiles(illustrationRoot).Count());
            }
            else
            {
                Assert.Contains(scenario, new[] { "exact-repeat", "missing-lower" });
                Assert.False(File.Exists(lowerPath));
            }
            string markdown = scenario == "exact-repeat"
                ? "![upper](/uploads/illustration/Case.png) ![repeat](/uploads/illustration/Case.png)"
                : "![upper](/uploads/illustration/Case.png) ![lower](/uploads/illustration/case.png)";
            await fixture.ExecuteAsync(connectionString, $"""
                CREATE TABLE article_asset_cleanup_queue (
                    normalized_url varchar(512) PRIMARY KEY,
                    not_before_utc timestamp NOT NULL,
                    attempt_count integer NOT NULL,
                    last_error varchar(512) NULL,
                    updated_at_utc timestamp NOT NULL
                );
                CREATE TABLE article_asset_reference (
                    normalized_url varchar(512) NOT NULL,
                    source_kind varchar(16) NOT NULL,
                    source_key varchar(160) NOT NULL,
                    article_id integer NULL
                );
                CREATE TABLE asset_library_article_ref (
                    url varchar(512) NOT NULL,
                    article_id integer NOT NULL
                );
                CREATE TABLE asset_library_item (
                    url varchar(512) PRIMARY KEY,
                    sha256 varchar(64) NULL
                );
                INSERT INTO article(id, title, categoryid, views, createtime, metadata_updated_at, status, isdeleted)
                VALUES (1975002, 'Case-exact asset cutover', 0, 0, now(), now(), 2, false);
                INSERT INTO article_body(article_id, markdown_content, updated_at)
                VALUES (1975002, '{markdown}', now());
                """);

            using IDisposable storageScope = ContentAssetCutoverBackfillContext.Push(paths.PublicAssetRoot);
            ISchemaMigrationDescriptor migration = ContentAssetCutoverMigrationDefinitions.BuildMigration();
            if (scenario == "missing-lower")
            {
                InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(
                    () => SchemaMigrationTransactionExecutor.ExecuteAsync(
                        db, migration, (step, token) => step.ExecuteAsync(db, token), CancellationToken.None));
                Assert.Contains("missing_file:/uploads/illustration/case.png", failure.ToString(), StringComparison.Ordinal);
                Assert.Empty(db.Queryable<ContentAsset>().ToList());
                Assert.Empty(db.Queryable<ContentAssetReference>().ToList());
                Assert.Empty(db.Queryable<ContentAssetCleanupQueueItem>().ToList());
                Assert.Equal(markdown, db.Ado.GetString("SELECT markdown_content FROM article_body WHERE article_id = 1975002;"));
                Assert.Equal(1, db.Ado.GetInt("SELECT COUNT(*) FROM article WHERE id = 1975002;"));
                Assert.True(await fixture.TableExistsAsync(connectionString, "article_asset_cleanup_queue"));
                Assert.True(await fixture.TableExistsAsync(connectionString, "article_asset_reference"));
                Assert.True(await fixture.TableExistsAsync(connectionString, "asset_library_article_ref"));
                Assert.True(await fixture.TableExistsAsync(connectionString, "asset_library_item"));
                Assert.Equal(png, await File.ReadAllBytesAsync(upperPath));
                Assert.False(File.Exists(lowerPath));
                return;
            }

            await SchemaMigrationTransactionExecutor.ExecuteAsync(
                db, migration, (step, token) => step.ExecuteAsync(db, token), CancellationToken.None);
            ContentAsset[] assets = await db.Queryable<ContentAsset>().ToArrayAsync();
            ContentAssetReference[] references = await db.Queryable<ContentAssetReference>().ToArrayAsync();
            int expectedEdges = scenario == "case-distinct" ? 2 : 1;
            Assert.Equal(expectedEdges, assets.Length);
            Assert.Equal(expectedEdges, assets.Select(static asset => asset.AssetId).Distinct().Count());
            Assert.Equal(expectedEdges, references.Length);
            Assert.Equal(expectedEdges, references.Select(static reference => reference.AssetId).Distinct().Count());
            Assert.Equal(assets.Select(static asset => asset.AssetId).Order(),
                references.Select(static reference => reference.AssetId).Order());
            Assert.Contains(assets, static asset => asset.StorageKey == "illustration/Case.png");
            Assert.Equal(scenario == "case-distinct",
                assets.Any(static asset => asset.StorageKey == "illustration/case.png"));
            string expectedHash = Convert.ToHexString(SHA256.HashData(png)).ToLowerInvariant();
            Assert.All(assets, asset =>
            {
                Assert.Equal("public", asset.StorageClass);
                Assert.Equal(png.LongLength, asset.SizeBytes);
                Assert.Equal(expectedHash, asset.Sha256);
                Assert.Equal("image/png", asset.MimeType);
                Assert.Equal(".png", asset.Extension);
                Assert.Equal(1, asset.WidthPixels);
                Assert.Equal(1, asset.HeightPixels);
            });
            Assert.All(references, reference =>
            {
                Assert.Equal("article", reference.SourceKind);
                Assert.Equal("1975002", reference.SourceKey);
                Assert.Equal(1975002, reference.ArticleId);
                Assert.Equal(scenario == "case-distinct" ? 1 : 2, reference.ReferenceCount);
            });
            Assert.Empty(db.Queryable<ContentAssetCleanupQueueItem>().ToList());
            Assert.False(await fixture.TableExistsAsync(connectionString, "article_asset_cleanup_queue"));
            Assert.False(await fixture.TableExistsAsync(connectionString, "article_asset_reference"));
            Assert.False(await fixture.TableExistsAsync(connectionString, "asset_library_article_ref"));
            Assert.False(await fixture.TableExistsAsync(connectionString, "asset_library_item"));
        }
        finally
        {
            Directory.Delete(storageRoot, recursive: true);
        }
    }

    [Fact]
    public async Task Backfill_OnlyCanonicalNFileNameReusesIdentityAndRetryKeepsNewIds()
    {
        string databaseName = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(databaseName);
        string storageRoot = Path.Combine(
            Path.GetTempPath(),
            $"fsusblog-content-asset-filename-proof-{Guid.NewGuid():N}");
        Directory.CreateDirectory(storageRoot);
        try
        {
            using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
            PostgresSqlSugarTestClient.InitTables(
                db,
                typeof(ContentAsset),
                typeof(ContentAssetCleanupQueueItem),
                typeof(ContentAssetReference),
                typeof(Article),
                typeof(ArticleBody),
                typeof(ArticleDraft),
                typeof(ArticleRevision),
                typeof(ArticleRevisionContentBlock));
            ReleaseStoragePaths paths = ReleaseStorageTestPaths.Create(storageRoot);
            string illustrationRoot = Path.Combine(paths.PublicAssetRoot, "illustration");
            Directory.CreateDirectory(illustrationRoot);
            Guid fileNameId = Guid.NewGuid();
            string canonicalKey = $"illustration/{fileNameId:N}.png";
            string dashedKey = $"illustration/{fileNameId:D}.png";
            string ordinaryKey = "illustration/ordinary.png";
            string[] storageKeys = [canonicalKey, dashedKey, ordinaryKey];
            byte[] png = CreateCompletePng();
            foreach (string storageKey in storageKeys)
            {
                await File.WriteAllBytesAsync(
                    Path.Combine(paths.PublicAssetRoot, storageKey),
                    png);
            }

            IReadOnlyList<string> originalSchema = await fixture.CaptureSchemaSnapshotAsync(connectionString);
            using IDisposable storageScope = ContentAssetCutoverBackfillContext.Push(paths.PublicAssetRoot);
            ISchemaMigrationDescriptor migration = ContentAssetCutoverMigrationDefinitions.BuildMigration();
            ContentAssetCutoverBackfillStep backfill = Assert.Single(
                migration.Steps.OfType<ContentAssetCutoverBackfillStep>());
            var interruptedIds = new Dictionary<string, Guid>(StringComparer.Ordinal);
            InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(
                () => SchemaMigrationTransactionExecutor.ExecuteAsync(
                    db,
                    migration,
                    async (step, token) =>
                    {
                        await step.ExecuteAsync(db, token);
                        if (ReferenceEquals(step, backfill))
                        {
                            foreach (ContentAsset asset in await db.Queryable<ContentAsset>().ToArrayAsync())
                            {
                                interruptedIds.Add(asset.StorageKey, asset.AssetId);
                            }
                            throw new InvalidOperationException("controlled_filename_cutover_interruption");
                        }
                    },
                    CancellationToken.None));

            Assert.Contains("controlled_filename_cutover_interruption", failure.ToString(), StringComparison.Ordinal);
            Assert.Equal(3, interruptedIds.Count);
            Assert.Equal(fileNameId, interruptedIds[canonicalKey]);
            Assert.NotEqual(fileNameId, interruptedIds[dashedKey]);
            Assert.NotEqual(Guid.Empty, interruptedIds[ordinaryKey]);
            Assert.Equal(3, interruptedIds.Values.Distinct().Count());
            Assert.Empty(db.Queryable<ContentAsset>().ToList());
            Assert.Empty(db.Queryable<ContentAssetReference>().ToList());
            Assert.Empty(db.Queryable<ContentAssetCleanupQueueItem>().ToList());
            Assert.Equal(originalSchema, await fixture.CaptureSchemaSnapshotAsync(connectionString));

            await SchemaMigrationTransactionExecutor.ExecuteAsync(
                db, migration, (step, token) => step.ExecuteAsync(db, token), CancellationToken.None);
            ContentAsset[] committed = await db.Queryable<ContentAsset>().ToArrayAsync();
            Assert.Equal(3, committed.Length);
            string expectedHash = Convert.ToHexString(SHA256.HashData(png)).ToLowerInvariant();
            Assert.All(committed, asset =>
            {
                Assert.Equal(interruptedIds[asset.StorageKey], asset.AssetId);
                Assert.Equal(png.LongLength, asset.SizeBytes);
                Assert.Equal(expectedHash, asset.Sha256);
                Assert.Equal("image/png", asset.MimeType);
                Assert.Equal(".png", asset.Extension);
                Assert.Equal(1, asset.WidthPixels);
                Assert.Equal(1, asset.HeightPixels);
            });
            Assert.Empty(db.Queryable<ContentAssetReference>().ToList());
            Assert.Empty(db.Queryable<ContentAssetCleanupQueueItem>().ToList());

            await SchemaMigrationTransactionExecutor.ExecuteAsync(
                db, migration, (step, token) => step.ExecuteAsync(db, token), CancellationToken.None);
            ContentAsset[] replayed = await db.Queryable<ContentAsset>().ToArrayAsync();
            Assert.Equal(3, replayed.Length);
            Assert.All(replayed, asset => Assert.Equal(interruptedIds[asset.StorageKey], asset.AssetId));
            foreach (string storageKey in storageKeys)
            {
                Assert.Equal(png, await File.ReadAllBytesAsync(Path.Combine(paths.PublicAssetRoot, storageKey)));
            }
        }
        finally
        {
            Directory.Delete(storageRoot, recursive: true);
        }
    }

    private static byte[] CreateCompletePng()
        => Convert.FromBase64String(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==");

    private sealed record BackfillFailureCase(
        string StorageKey,
        byte[]? FileBytes,
        string? ExpectedHash,
        string ExpectedFailure);

    private static byte[] CreatePng()
    {
        var bytes = new byte[24];
        new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }.CopyTo(bytes, 0);
        System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(16, 4), 1);
        System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(20, 4), 1);
        return bytes;
    }
}
