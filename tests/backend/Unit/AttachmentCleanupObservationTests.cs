using System.Security.Cryptography;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using SqlSugar;

using FsusBlog.Core.Common;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;

namespace FsusBlog.Server.Tests;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AttachmentCleanupObservationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task UnreferencedCompletedUpload_RequiresCanonicalScheduling()
    {
        await using var upload = await CreateAsync();
        var original = await upload.Service.ObserveCommittedUploadAsync(upload.Access, upload.Sha256);
        Assert.True(original.IsSuccess, original.Error.Message);
        var observed = await upload.ObserveAsync();
        Assert.Equal(FileService.AttachmentCleanupStatus.SchedulingRequired, observed.Status);
        Assert.Equal(original.Value!.AssetVersionSha256, observed.AssetVersionSha256);
        Assert.Equal(original.Value.ReferenceLedgerSha256, observed.ReferenceObservationSha256);
        var bound = await upload.ObserveAsync(observed);
        Assert.Equal(FileService.AttachmentCleanupStatus.SchedulingRequired, bound.Status);
        Assert.Null(bound.NotBeforeUtc);
        Assert.Equal(0, await upload.Db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
        await upload.AssertBytesUnchangedAsync();
    }

    [Fact]
    public async Task LastReferenceRemoved_ObservesOriginalQueueWithoutRescheduling()
    {
        await using var upload = await CreateAsync();
        await upload.RestoreDraftAsync();
        DateTime before = DateTime.UtcNow;
        await upload.RemoveDraftAsync();
        DateTime after = DateTime.UtcNow;
        var queued = await upload.ObserveAsync();
        Assert.Equal(FileService.AttachmentCleanupStatus.ObservationRequired, queued.Status);
        Assert.Equal(ContentAssetStates.PendingDelete, queued.AssetState);
        Assert.InRange(queued.NotBeforeUtc!.Value.UtcDateTime,
            before + ArticleAssetReferenceStore.CleanupDelay,
            after + ArticleAssetReferenceStore.CleanupDelay);
        var recorded = await upload.ObserveAsync(queued);
        Assert.Equal(FileService.AttachmentCleanupStatus.Recorded, recorded.Status);
        Assert.Equal(queued.NotBeforeUtc, recorded.NotBeforeUtc);
        Assert.Equal(queued.QueueUpdatedAtUtc, recorded.QueueUpdatedAtUtc);
        Assert.Equal(upload.AssetId, recorded.AssetId);
        Assert.Equal(upload.Access.OwnerAdminPrincipalId, recorded.OwnerAdminPrincipalId);
        await upload.AssertBytesUnchangedAsync();
    }

    [Fact]
    public async Task RepeatedObservation_ReusesDurableSchedule()
    {
        await using var upload = await CreateAsync();
        await upload.RestoreDraftAsync();
        await upload.RemoveDraftAsync();
        var observed = await upload.ObserveAsync();
        var first = await upload.ObserveAsync(observed);
        var repeated = await upload.ObserveAsync(first);
        Assert.Equal(FileService.AttachmentCleanupStatus.Recorded, first.Status);
        Assert.Equal(first, repeated);
        Assert.Equal(1, await upload.Db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
        await upload.AssertBytesUnchangedAsync();
    }

    [Fact]
    public async Task StillReferenced_RefusesRecorded()
    {
        await using var upload = await CreateAsync();
        await upload.RestoreDraftAsync();
        var original = await upload.Service.ObserveCommittedUploadAsync(upload.Access, upload.Sha256);
        Assert.True(original.IsSuccess, original.Error.Message);
        var observed = await upload.ObserveAsync();
        Assert.Equal(original.Value!.AssetVersionSha256, observed.AssetVersionSha256);
        Assert.Equal(original.Value.ReferenceLedgerSha256, observed.ReferenceObservationSha256);
        var bound = await upload.ObserveAsync(observed);
        Assert.Equal(FileService.AttachmentCleanupStatus.RetainedReferences, bound.Status);
        Assert.Equal(1, bound.ReferenceSourceCount);
        Assert.Equal(0, await upload.Db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
    }

    [Fact]
    public async Task RestoredReference_CancelsReceipt()
    {
        await using var upload = await CreateAsync();
        await upload.RestoreDraftAsync();
        await upload.RemoveDraftAsync();
        var queued = await upload.ObserveAsync();
        Assert.Equal(FileService.AttachmentCleanupStatus.Recorded, (await upload.ObserveAsync(queued)).Status);
        await upload.RestoreDraftAsync();
        var late = await upload.ObserveAsync(queued);
        Assert.Equal(FileService.AttachmentCleanupStatus.RetainedReferences, late.Status);
        Assert.Equal(ContentAssetStates.Active, late.AssetState);
        Assert.Null(late.NotBeforeUtc);
        Assert.NotEqual(queued.AssetVersionSha256, late.AssetVersionSha256);
        Assert.NotEqual(queued.ReferenceObservationSha256, late.ReferenceObservationSha256);
        Assert.Equal(0, await upload.Db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
        await upload.AssertBytesUnchangedAsync();
    }

    [Fact]
    public async Task ChangedAssetVersion_RequiresObservation()
    {
        await using var upload = await CreateAsync();
        var before = await upload.ObserveAsync();
        await upload.RestoreDraftAsync();
        await upload.RemoveDraftAsync();
        var late = await upload.ObserveAsync(before);
        Assert.Equal(FileService.AttachmentCleanupStatus.StateChanged, late.Status);
        Assert.NotEqual(before.AssetVersionSha256, late.AssetVersionSha256);
        Assert.Equal(FileService.AttachmentCleanupStatus.Recorded, (await upload.ObserveAsync(late)).Status);
    }

    [Fact]
    public async Task ChangedQueueMarker_RefusesRecorded()
    {
        await using var upload = await CreateAsync();
        await upload.RestoreDraftAsync();
        await upload.RemoveDraftAsync();
        var queued = await upload.ObserveAsync();
        await upload.Db.Updateable<ContentAssetCleanupQueueItem>()
            .SetColumns(item => item.LastError == ContentAssetCleanupMarkers.DeletePending)
            .Where(item => item.AssetId == upload.AssetId.Value)
            .ExecuteCommandAsync();
        var changed = await upload.ObserveAsync(queued);
        Assert.Equal(FileService.AttachmentCleanupStatus.StateChanged, changed.Status);
        Assert.Equal(ContentAssetCleanupMarkers.DeletePending, changed.LastError);
        await upload.AssertBytesUnchangedAsync();
    }

    [Fact]
    public async Task TransactionFailure_RefusesReceipt()
    {
        await using var upload = await CreateAsync();
        // A real PostgreSQL read failure in the observer's transaction, confined to this case's database.
        await upload.Db.Ado.ExecuteCommandAsync("ALTER TABLE content_asset_cleanup_queue RENAME TO task_cleanup_queue_unavailable;");
        try
        {
            var failed = await upload.Service.ObserveAttachmentCleanupAsync(upload.Access, upload.Sha256);
            Assert.False(failed.IsSuccess);
            Assert.Equal(ErrorCode.InfraFailure, failed.Error.Code);
            Assert.Equal("attachment_cleanup_observation_failed", failed.Error.Message);
        }
        finally
        {
            await upload.Db.Ado.ExecuteCommandAsync("ALTER TABLE task_cleanup_queue_unavailable RENAME TO content_asset_cleanup_queue;");
        }
        Assert.Equal(FileService.AttachmentCleanupStatus.SchedulingRequired, (await upload.ObserveAsync()).Status);
        await upload.AssertBytesUnchangedAsync();
    }

    [Fact]
    public async Task CancellationBeforeObservation_Throws()
    {
        await using var upload = await CreateAsync();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => upload.Service.ObserveAttachmentCleanupAsync(
            upload.Access, upload.Sha256, cancellationToken: cancellation.Token));
        Assert.Equal(0, await upload.Db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
    }

    [Fact]
    public async Task CancellationAfterQueueRead_Throws()
    {
        await using var upload = await CreateAsync();
        await upload.RestoreDraftAsync();
        await upload.RemoveDraftAsync();
        var queued = await upload.ObserveAsync();
        using var cancellation = new CancellationTokenSource();
        int queueReads = 0;
        upload.Db.Aop.OnLogExecuted = (sql, _) =>
        {
            if (sql.Contains("content_asset_cleanup_queue", StringComparison.Ordinal)
                && ++queueReads == 2)
            {
                cancellation.Cancel();
            }
        };
        try
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => upload.Service.ObserveAttachmentCleanupAsync(
                upload.Access, upload.Sha256, queued.AssetVersionSha256,
                queued.ReferenceObservationSha256, cancellation.Token));
            Assert.Equal(2, queueReads);
        }
        finally
        {
            upload.Db.Aop.OnLogExecuted = null;
        }
        Assert.Equal(FileService.AttachmentCleanupStatus.Recorded, (await upload.ObserveAsync(queued)).Status);
    }

    [Fact]
    public async Task MissingAuthorityAndAbortedSession_RefuseReceipt()
    {
        await using var upload = await CreateAsync();
        var wrongOwner = await upload.Service.ObserveAttachmentCleanupAsync(
            upload.Access with
            {
                OwnerAdminPrincipalId = 8
            }, upload.Sha256);
        var wrongToken = await upload.Service.ObserveAttachmentCleanupAsync(
            upload.Access with
            {
                UploadToken = "wrong-token"
            }, upload.Sha256);
        Assert.False(wrongOwner.IsSuccess);
        Assert.False(wrongToken.IsSuccess);
        Assert.Equal(ErrorCode.NotFound, wrongOwner.Error.Code);
        Assert.Equal(ErrorCode.NotFound, wrongToken.Error.Code);
        var withoutLedger = new FileService(ReleaseStorageTestPaths.Create(upload.Root), NullLogger<FileService>.Instance);
        var unavailable = await withoutLedger.ObserveAttachmentCleanupAsync(upload.Access, upload.Sha256);
        Assert.False(unavailable.IsSuccess);
        Assert.Equal(ErrorCode.InfraFailure, unavailable.Error.Code);
        var aborted = await upload.Service.AbortUploadAsync(upload.Access);
        Assert.True(aborted.IsSuccess, aborted.Error.Message);
        Assert.True(aborted.Value);
        var late = await upload.Service.ObserveAttachmentCleanupAsync(upload.Access, upload.Sha256);
        Assert.False(late.IsSuccess);
        Assert.Equal(ErrorCode.NotFound, late.Error.Code);
        Assert.Equal(0, await upload.Db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
        await upload.AssertBytesUnchangedAsync();
    }

    private async Task<UploadContext> CreateAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(ContentAsset), typeof(ContentAssetReference), typeof(ContentAssetCleanupQueueItem));
        string root = Path.Combine(Path.GetTempPath(), "fsus-attachment-cleanup-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        ServiceProvider services = new ServiceCollection().AddSingleton<ISqlSugarClient>(db).BuildServiceProvider();
        try
        {
            var service = new FileService(ReleaseStorageTestPaths.Create(root), NullLogger<FileService>.Instance,
                services.GetRequiredService<IServiceScopeFactory>());
            byte[] bytes = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB14AAAAASUVORK5CYII=");
            string sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes));
            var initialized = await service.InitUploadSessionAsync(7, new UploadInitRequestDto
            {
                FileName = "source.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = bytes.Length,
                ChunkSize = 512 * 1024,
                Sha256 = sha256
            });
            Assert.True(initialized.IsSuccess, initialized.Error.Message);
            var access = new UploadSessionAccess(initialized.Value!.UploadId, 7, initialized.Value.UploadToken);
            using var stream = new MemoryStream(bytes);
            var part = new FormFile(stream, 0, bytes.Length, "file", "source.png");
            var uploaded = await service.UploadPartAsync(access, 0, 0, part, sha256);
            Assert.True(uploaded.IsSuccess, uploaded.Error.Message);
            var completed = await service.CompleteUploadAsync(access, sha256);
            Assert.True(completed.IsSuccess, completed.Error.Message);
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

    private sealed record UploadContext(
        string Root, SqlSugarClient Db, ServiceProvider Services, FileService Service,
        UploadSessionAccess Access, byte[] Bytes, string Sha256) : IAsyncDisposable
    {
        public AssetId AssetId => AssetId.FromGuid(Guid.ParseExact(Access.UploadId, "N"));

        public async Task<FileService.AttachmentCleanupObservation> ObserveAsync(
            FileService.AttachmentCleanupObservation? expected = null)
        {
            var result = await Service.ObserveAttachmentCleanupAsync(Access, Sha256,
                expected?.AssetVersionSha256, expected?.ReferenceObservationSha256);
            Assert.True(result.IsSuccess, result.Error.Message);
            return result.Value!;
        }

        public async Task RestoreDraftAsync()
        {
            var transaction = await Db.Ado.UseTranAsync(() => new ArticleAssetReferenceStore(Db)
                .ReplaceDraftAsync(Access.OwnerAdminPrincipalId, "cleanup-case", null,
                    [new ArticleAssetReferenceWrite(AssetId, 1, "test attachment")]));
            Assert.True(transaction.IsSuccess);
        }

        public async Task RemoveDraftAsync()
        {
            var transaction = await Db.Ado.UseTranAsync(() => new ArticleAssetReferenceStore(Db)
                .RemoveDraftAsync(Access.OwnerAdminPrincipalId, "cleanup-case"));
            Assert.True(transaction.IsSuccess);
        }

        public async Task AssertBytesUnchangedAsync()
        {
            string path = Path.Combine(ReleaseStorageTestPaths.Create(Root).PublicAssetRoot,
                "illustration", Access.UploadId + ".png");
            Assert.Equal(Bytes, await File.ReadAllBytesAsync(path));
            Assert.Equal(1, await Db.Queryable<ContentAsset>().CountAsync());
        }

        public async ValueTask DisposeAsync()
        {
            await Services.DisposeAsync();
            Db.Dispose();
            Directory.Delete(Root, recursive: true);
        }
    }
}
