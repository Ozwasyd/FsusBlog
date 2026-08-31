using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.SchemaMigration;
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
                    () => ContentAssetCutoverBackfill.ExecuteAsync(db, paths, CancellationToken.None));

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

    [Fact]
    public async Task RuntimeHasOneLedgerAndNoUrlDeleteIdentity()
    {
        AssetId assetId = AssetId.Parse("3f3b2e7a-1d2e-4f8a-9c5b-6a7b8c9d0e1f");
        IAssetStore validStore = Substitute.For<IAssetStore>();
        validStore.DeleteAsync(assetId, Arg.Any<CancellationToken>()).Returns(AssetDeleteResult.Deleted);
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
