using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ContentAssetDeleteEndpointTests
{
    private const string CanonicalAssetId = "3f3b2e7a-1d2e-4f8a-9c5b-6a7b8c9d0e1f";

    [Theory]
    [InlineData("../images/hero.png")]
    [InlineData("/uploads/images/hero.png")]
    [InlineData("https://evil.example.test/uploads/images/hero.png")]
    public async Task HandleFileDeleteAsync_RejectsPathOrUrlWithoutCallingStore(string candidate)
    {
        IAssetStore store = Substitute.For<IAssetStore>();
        var aeds = new AedsEncoder();
        DefaultHttpContext context = CreateContext(candidate);

        BinaryFrameResult result = await BinaryEndpoints.HandleFileDeleteAsync(
            context,
            store,
            aeds,
            CancellationToken.None);
        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);

        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal(ErrorCode.Validation, PodBinaryCodec.ToErrorDetail(errorPod).Code);
        await store.DidNotReceiveWithAnyArgs().DeleteAsync(default, default);
    }

    [Theory]
    [InlineData(AssetDeleteResult.Deleted, AedsFrameType.EmptySuccess, ErrorCode.None)]
    [InlineData(AssetDeleteResult.Referenced, AedsFrameType.ApiError, ErrorCode.Conflict)]
    [InlineData(AssetDeleteResult.NotFound, AedsFrameType.ApiError, ErrorCode.NotFound)]
    public async Task HandleFileDeleteAsync_InvokesStronglyTypedStoreAndMapsOutcome(
        AssetDeleteResult outcome,
        AedsFrameType expectedFrameType,
        ErrorCode expectedError)
    {
        AssetId assetId = AssetId.Parse(CanonicalAssetId);
        IAssetStore store = Substitute.For<IAssetStore>();
        store.DeleteAsync(assetId, Arg.Any<CancellationToken>()).Returns(outcome);
        var aeds = new AedsEncoder();
        DefaultHttpContext context = CreateContext(CanonicalAssetId);

        BinaryFrameResult result = await BinaryEndpoints.HandleFileDeleteAsync(
            context,
            store,
            aeds,
            CancellationToken.None);
        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);

        Assert.Equal(expectedFrameType, decoded.FrameType);
        await store.Received(1).DeleteAsync(assetId, Arg.Any<CancellationToken>());
        if (expectedError != ErrorCode.None)
        {
            Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
            Assert.Equal(expectedError, PodBinaryCodec.ToErrorDetail(errorPod).Code);
        }
    }

    private static DefaultHttpContext CreateContext(string value)
    {
        IBinaryEndpointRequestContext requestContext = Substitute.For<IBinaryEndpointRequestContext>();
        requestContext.ReadFrameAsync(
                Arg.Any<HttpContext>(),
                Arg.Any<IAedsEncoder>(),
                AedsFrameType.FileDeleteRequest,
                Arg.Any<CancellationToken>(),
                Arg.Any<int?>())
            .Returns(BinaryRequestPayload.Success(PodBinaryCodec.EncodeStringMutationRequest(value)));
        var context = new DefaultHttpContext
        {
            RequestServices = new ServiceCollection()
                .AddSingleton(requestContext)
                .BuildServiceProvider()
        };
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static async Task<AedsDecodeResult> ExecuteAndDecodeAsync(
        BinaryFrameResult result,
        DefaultHttpContext context,
        AedsEncoder aeds)
    {
        await result.ExecuteAsync(context);
        Result<AedsDecodeResult> decoded = aeds.TryDecode(((MemoryStream)context.Response.Body).ToArray());
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        return decoded.Value;
    }
}

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class ContentAssetDeleteEndpointIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task HandleFileDeleteAsync_CanonicalAssetIdDeletesActualLedgerRowAndFile()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(ContentAsset),
            typeof(ContentAssetReference),
            typeof(ContentAssetCleanupQueueItem));
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-content-asset-endpoint-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            var paths = ReleaseStorageTestPaths.Create(root);
            string file = Path.Combine(paths.PublicAssetRoot, "illustration", "delete-me.png");
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            await File.WriteAllBytesAsync(file, [1, 2, 3]);
            AssetId assetId = AssetId.New();
            db.Insertable(new ContentAsset
            {
                AssetId = assetId.Value,
                StorageClass = "public",
                StorageKey = "illustration/delete-me.png",
                MimeType = "image/png",
                Extension = ".png",
                SizeBytes = 3,
                Sha256 = new string('c', 64),
                WidthPixels = 1,
                HeightPixels = 1,
                State = ContentAssetStates.Active,
                CreatedAtUtc = DateTime.UtcNow,
                UpdatedAtUtc = DateTime.UtcNow
            }).ExecuteCommand();
            var store = new LocalContentAssetStore(db, paths, NullLogger<LocalContentAssetStore>.Instance);
            var aeds = new AedsEncoder();
            DefaultHttpContext context = CreateContext(assetId.ToString());

            BinaryFrameResult result = await BinaryEndpoints.HandleFileDeleteAsync(
                context,
                store,
                aeds,
                CancellationToken.None);
            await result.ExecuteAsync(context);
            Result<AedsDecodeResult> decoded = aeds.TryDecode(((MemoryStream)context.Response.Body).ToArray());

            Assert.True(decoded.IsSuccess, decoded.Error.Message);
            Assert.Equal(AedsFrameType.EmptySuccess, decoded.Value.FrameType);
            Assert.False(File.Exists(file));
            Assert.Null(db.Queryable<ContentAsset>().InSingle(assetId.Value));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static DefaultHttpContext CreateContext(string value)
    {
        IBinaryEndpointRequestContext requestContext = Substitute.For<IBinaryEndpointRequestContext>();
        requestContext.ReadFrameAsync(
                Arg.Any<HttpContext>(),
                Arg.Any<IAedsEncoder>(),
                AedsFrameType.FileDeleteRequest,
                Arg.Any<CancellationToken>(),
                Arg.Any<int?>())
            .Returns(BinaryRequestPayload.Success(PodBinaryCodec.EncodeStringMutationRequest(value)));
        var context = new DefaultHttpContext
        {
            RequestServices = new ServiceCollection()
                .AddSingleton(requestContext)
                .BuildServiceProvider()
        };
        context.Response.Body = new MemoryStream();
        return context;
    }
}

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class ContentAssetUploadLedgerIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task CompleteUploadAsync_CreatesOneCanonicalLedgerAssetAndArticleReference()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(ContentAsset),
            typeof(ContentAssetReference),
            typeof(ContentAssetCleanupQueueItem));
        using ServiceProvider services = new ServiceCollection()
            .AddScoped<ISqlSugarClient>(_ => PostgresSqlSugarTestClient.Create(connectionString))
            .BuildServiceProvider();
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-content-asset-upload-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            byte[] png = CreatePng();
            string sha256 = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(png));
            var service = new FileService(
                ReleaseStorageTestPaths.Create(root),
                NullLogger<FileService>.Instance,
                services.GetRequiredService<IServiceScopeFactory>());
            Result<UploadInitDto> initialized = await service.InitUploadSessionAsync(41, new UploadInitRequestDto
            {
                FileName = "ledger.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = png.Length,
                ChunkSize = png.Length,
                Sha256 = sha256
            });
            Assert.True(initialized.IsSuccess, initialized.Error.Message);
            UploadInitDto session = initialized.Value!;
            var access = new UploadSessionAccess(session.UploadId, 41, session.UploadToken);
            var formFile = new FormFile(new MemoryStream(png, writable: false), 0, png.Length, "part", "part.png");
            Result<UploadPartAckDto> uploaded = await service.UploadPartAsync(
                access,
                0,
                0,
                formFile,
                sha256);
            Assert.True(uploaded.IsSuccess, uploaded.Error.Message);

            Result<UploadCompleteDto> first = await service.CompleteUploadAsync(access, sha256);
            Result<UploadCompleteDto> retry = await service.CompleteUploadAsync(access, sha256);

            Assert.True(first.IsSuccess, first.Error.Message);
            Assert.True(retry.IsSuccess, retry.Error.Message);
            Assert.Equal(first.Value!.RelativeUrl, retry.Value!.RelativeUrl);
            ContentAsset asset = Assert.Single(db.Queryable<ContentAsset>().ToList());
            Assert.Equal(Guid.ParseExact(session.UploadId, "N"), asset.AssetId);
            Assert.Equal("illustration/" + session.UploadId + ".png", asset.StorageKey);
            Assert.Equal("image/png", asset.MimeType);
            Assert.Equal(".png", asset.Extension);
            Assert.Equal(png.Length, asset.SizeBytes);
            Assert.Equal(sha256, asset.Sha256);
            Assert.Equal(1, asset.WidthPixels);
            Assert.Equal(1, asset.HeightPixels);
            Assert.Equal(41, asset.OwnerAdminPrincipalId);
            Assert.Equal(ContentAssetStates.Active, asset.State);

            var references = new ArticleAssetReferenceStore(db);
            var transaction = await db.Ado.UseTranAsync(
                async () =>
                {
                    ArticleAssetReferenceWrite[] writes = await new ArticleAssetReferenceWriteBoundary(db)
                        .ResolveAsync($"![uploaded]({first.Value.RelativeUrl})", null);
                    await references.ReplaceCurrentArticleAsync(1779, writes);
                });
            Assert.True(transaction.IsSuccess, transaction.ErrorMessage);
            ContentAssetReference reference = Assert.Single(db.Queryable<ContentAssetReference>().ToList());
            Assert.Equal(asset.AssetId, reference.AssetId);
            Assert.Equal(1779, reference.ArticleId);
            Assert.Equal(1, reference.ReferenceCount);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static byte[] CreatePng()
    {
        var bytes = new byte[24];
        new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }.CopyTo(bytes, 0);
        System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(16, 4), 1);
        System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(20, 4), 1);
        return bytes;
    }
}
