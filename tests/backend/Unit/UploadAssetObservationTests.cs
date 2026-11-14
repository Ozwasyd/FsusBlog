using System.Security.Cryptography;

using FsusBlog.Core.Common;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using SqlSugar;

namespace FsusBlog.Server.Tests;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class UploadAssetObservationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task OriginalUploadAndLedger_ProduceStableBytesAndVersionObservation()
    {
        await using var context = await CreateAsync();
        Result<UploadAssetObservation> result = await context.ObserveAsync();
        Assert.True(result.IsSuccess, result.Error.Message);
        UploadAssetObservation observed = result.Value!;
        Assert.Equal(AssetId.FromGuid(Guid.ParseExact(context.Access.UploadId, "N")), observed.Asset.Id);
        Assert.Equal(context.Bytes.Length, observed.Asset.SizeBytes);
        Assert.Equal(context.Sha256, observed.Asset.Sha256);
        Assert.Equal(7L, observed.Asset.OwnerAdminPrincipalId);
        Assert.Equal("/uploads/" + observed.Asset.StorageKey.Value, observed.PublicUrl);
        Assert.Empty(observed.References);
        Assert.Equal(64, observed.AssetVersionSha256.Length);
        Assert.Equal(64, observed.ReferenceLedgerSha256.Length);
        Result<UploadAssetObservation> repeat = await context.ObserveAsync();
        Assert.Equal(observed.Asset, repeat.Value!.Asset);
        Assert.Equal(observed.AssetVersionSha256, repeat.Value.AssetVersionSha256);
        Assert.Equal(observed.ReferenceLedgerSha256, repeat.Value.ReferenceLedgerSha256);

        DateTime updated = DateTime.UtcNow.AddSeconds(1);
        await context.Db.Updateable<ContentAsset>()
            .SetColumns(asset => asset.UpdatedAtUtc == updated)
            .Where(asset => asset.AssetId == observed.Asset.Id.Value)
            .ExecuteCommandAsync();
        Result<UploadAssetObservation> newer = await context.ObserveAsync();
        Assert.True(newer.IsSuccess, newer.Error.Message);
        Assert.NotEqual(observed.AssetVersionSha256, newer.Value!.AssetVersionSha256);
        Assert.Equal(observed.ReferenceLedgerSha256, newer.Value.ReferenceLedgerSha256);
    }

    [Fact]
    public async Task CanonicalReferenceChange_ChangesOnlyItsObservedDigest()
    {
        await using var context = await CreateAsync();
        UploadAssetObservation before = (await context.ObserveAsync()).Value!;
        await context.Db.Insertable(new ContentAssetReference
        {
            AssetId = before.Asset.Id.Value,
            SourceKind = ContentAssetSourceKinds.Revision,
            SourceKey = "revision:42",
            ArticleId = 1,
            ReferenceCount = 2
        }).ExecuteCommandAsync();
        Result<UploadAssetObservation> after = await context.ObserveAsync();
        Assert.True(after.IsSuccess, after.Error.Message);
        Assert.Equal(before.AssetVersionSha256, after.Value!.AssetVersionSha256);
        Assert.NotEqual(before.ReferenceLedgerSha256, after.Value.ReferenceLedgerSha256);
        AssetReference reference = Assert.Single(after.Value.References);
        Assert.Equal(2, reference.ReferenceCount);
        Assert.Equal("revision:42", reference.SourceKey);
    }

    [Theory]
    [InlineData("wrong-owner")]
    [InlineData("wrong-token")]
    [InlineData("wrong-digest")]
    [InlineData("missing-ledger")]
    [InlineData("pending-delete")]
    [InlineData("ledger-owner-drift")]
    [InlineData("bytes-drift")]
    [InlineData("missing-bytes")]
    [InlineData("linked-bytes")]
    public async Task UnqualifiedCurrentFacts_NeverProduceObservation(string mutation)
    {
        await using var context = await CreateAsync();
        AssetId assetId = AssetId.FromGuid(Guid.ParseExact(context.Access.UploadId, "N"));
        string path = Path.Combine(context.Service.StoragePaths.PublicAssetRoot, "illustration", context.Access.UploadId + ".png");
        UploadSessionAccess access = context.Access;
        string digest = context.Sha256;
        switch (mutation)
        {
            case "wrong-owner":
                access = access with
                {
                    OwnerAdminPrincipalId = 8
                };
                break;
            case "wrong-token":
                access = access with
                {
                    UploadToken = "incorrect-token"
                };
                break;
            case "wrong-digest":
                digest = new string('a', 64);
                break;
            case "missing-ledger":
                await context.Db.Deleteable<ContentAsset>().Where(asset => asset.AssetId == assetId.Value).ExecuteCommandAsync();
                break;
            case "pending-delete":
                await context.Db.Updateable<ContentAsset>().SetColumns(asset => asset.State == ContentAssetStates.PendingDelete)
                    .Where(asset => asset.AssetId == assetId.Value).ExecuteCommandAsync();
                break;
            case "ledger-owner-drift":
                await context.Db.Updateable<ContentAsset>().SetColumns(asset => asset.OwnerAdminPrincipalId == 8)
                    .Where(asset => asset.AssetId == assetId.Value).ExecuteCommandAsync();
                break;
            case "bytes-drift":
                byte[] changed = (byte[])context.Bytes.Clone();
                changed[^1] ^= 1;
                await File.WriteAllBytesAsync(path, changed);
                break;
            case "missing-bytes":
                File.Delete(path);
                break;
            case "linked-bytes":
                string outside = Path.Combine(context.Root, "outside.png");
                File.Move(path, outside);
                File.CreateSymbolicLink(path, outside);
                break;
            default:
                throw new InvalidOperationException("unknown_mutation");
        }
        Result<UploadAssetObservation> result = await context.Service.ObserveCommittedUploadAsync(access, digest);
        Assert.False(result.IsSuccess);
        Assert.Null(result.Value);
    }

    [Fact]
    public async Task OriginalFilesystemOnlyConstructor_CannotClaimLedgerObservation()
    {
        await using var context = await CreateAsync();
        var service = new FileService(context.Service.StoragePaths, NullLogger<FileService>.Instance);
        Result<UploadAssetObservation> result = await service.ObserveCommittedUploadAsync(context.Access, context.Sha256);
        Assert.False(result.IsSuccess);
        Assert.Equal("upload_asset_ledger_unavailable", result.Error.Message);
    }

    [Fact]
    public async Task Cancellation_PrecedesAnySessionOrAssetObservation()
    {
        await using var context = await CreateAsync();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => context.Service.ObserveCommittedUploadAsync(
            default, "invalid", cancellation.Token));
    }

    private async Task<UploadContext> CreateAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(ContentAsset), typeof(ContentAssetReference), typeof(ContentAssetCleanupQueueItem));
        string root = Path.Combine(Path.GetTempPath(), "fsus-upload-observation-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        ServiceProvider services = new ServiceCollection().AddSingleton<ISqlSugarClient>(db).BuildServiceProvider();
        try
        {
            var service = new FileService(ReleaseStorageTestPaths.Create(root), NullLogger<FileService>.Instance,
                services.GetRequiredService<IServiceScopeFactory>());
            byte[] bytes = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB14AAAAASUVORK5CYII=");
            string sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes));
            Result<FsusBlog.Shared.Contracts.Outputs.UploadInitDto> initialized = await service.InitUploadSessionAsync(7, new UploadInitRequestDto
            {
                FileName = "source.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = bytes.Length,
                ChunkSize = bytes.Length,
                Sha256 = sha256
            });
            Assert.True(initialized.IsSuccess, initialized.Error.Message);
            var access = new UploadSessionAccess(initialized.Value!.UploadId, 7, initialized.Value.UploadToken);
            using var stream = new MemoryStream(bytes);
            var file = new FormFile(stream, 0, bytes.Length, "file", "source.png");
            var uploaded = await service.UploadPartAsync(access, 0, 0, file, sha256);
            Assert.True(uploaded.IsSuccess, uploaded.Error.Message);
            var complete = await service.CompleteUploadAsync(access, sha256);
            Assert.True(complete.IsSuccess, complete.Error.Message);
            return new UploadContext(root, db, services, service, access, bytes, sha256);
        }
        catch
        {
            await services.DisposeAsync();
            db.Dispose();
            Directory.Delete(root, recursive: true);
            throw;
        }
    }

    private sealed record UploadContext(string Root, SqlSugarClient Db, ServiceProvider Services, FileService Service,
        UploadSessionAccess Access, byte[] Bytes, string Sha256) : IAsyncDisposable
    {
        public Task<Result<UploadAssetObservation>> ObserveAsync()
            => Service.ObserveCommittedUploadAsync(Access, Sha256);

        public async ValueTask DisposeAsync()
        {
            await Services.DisposeAsync();
            Db.Dispose();
            Directory.Delete(Root, recursive: true);
        }
    }
}
