using System.Security.Claims;
using System.Security.Cryptography;

using FsusBlog.Core.Common;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using SqlSugar;

namespace FsusBlog.Server.Tests;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class CurrentUploadAssetCleanupBindingTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task InterfaceConsumer_RecordsAndReobservesOriginalDurableQueue()
    {
        await using var upload = await CreateAsync();
        var native = await upload.NativeObservationAsync();
        int checks = 0;
        void RequireCurrent() => checks++;
        var before = await upload.Reader.ObserveCurrentAsync(native, upload.Principal, upload.Access,
            upload.Sha256, RequireCurrent);
        Assert.True(before.IsSuccess, before.Error.Message);
        Assert.Equal(FileService.AttachmentCleanupStatus.SchedulingRequired, before.Value!.Status);
        Assert.Equal(0, await upload.Db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
        var recorded = await upload.Reader.RecordCurrentAsync(native, upload.Principal, upload.Access,
            upload.Sha256, RequireCurrent);
        Assert.True(recorded.IsSuccess, recorded.Error.Message);
        Assert.Equal(FileService.AttachmentCleanupStatus.Recorded, recorded.Value!.Status);
        var queue = await upload.Db.Queryable<ContentAssetCleanupQueueItem>().SingleAsync();
        Assert.Equal(recorded.Value.NotBeforeUtc!.Value.UtcDateTime, queue.NotBeforeUtc);
        Assert.Equal(recorded.Value.QueueUpdatedAtUtc!.Value.UtcDateTime, queue.UpdatedAtUtc);
        var stale = await upload.Reader.RecordCurrentAsync(native, upload.Principal, upload.Access,
            upload.Sha256, RequireCurrent);
        Assert.True(stale.IsSuccess);
        Assert.Equal(FileService.AttachmentCleanupStatus.StateChanged, stale.Value!.Status);
        // The native observer intentionally requires active assets: reuse only the actual
        // original cleanup observation, never invent a refreshed native upload observation.
        var pendingNative = await upload.Files.ObserveCommittedUploadAsync(upload.Access, upload.Sha256);
        Assert.False(pendingNative.IsSuccess);
        Assert.Equal("upload_asset_ledger_mismatch", pendingNative.Error.Message);
        var repeated = await upload.Reader.RecordCurrentAsync(native, upload.Principal, upload.Access,
            upload.Sha256, RequireCurrent, recorded.Value);
        var observed = await upload.Reader.ObserveCurrentAsync(native, upload.Principal, upload.Access,
            upload.Sha256, RequireCurrent, recorded.Value);
        Assert.True(repeated.IsSuccess, repeated.Error.Message);
        Assert.True(observed.IsSuccess, observed.Error.Message);
        Assert.Equal(recorded.Value, repeated.Value);
        Assert.Equal(recorded.Value, observed.Value);
        Assert.Equal(10, checks);
        Assert.Equal(1, await upload.Db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
        await upload.AssertBytesUnchangedAsync();
    }

    [Fact]
    public async Task RestoredReference_PreservesOriginalRefusalAndCancelsQueue()
    {
        await using var upload = await CreateAsync();
        var native = await upload.NativeObservationAsync();
        var recorded = await upload.Reader.RecordCurrentAsync(native, upload.Principal, upload.Access,
            upload.Sha256, RequireUnchanged);
        Assert.Equal(FileService.AttachmentCleanupStatus.Recorded, recorded.Value!.Status);
        await upload.RestoreDraftAsync();
        var late = await upload.Reader.RecordCurrentAsync(native, upload.Principal, upload.Access,
            upload.Sha256, RequireUnchanged, recorded.Value);
        Assert.True(late.IsSuccess, late.Error.Message);
        Assert.Equal(FileService.AttachmentCleanupStatus.RetainedReferences, late.Value!.Status);
        Assert.Null(late.Value.NotBeforeUtc);
        Assert.Equal(1, await upload.Db.Queryable<ContentAssetReference>().CountAsync());
        Assert.Equal(0, await upload.Db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
        await upload.AssertBytesUnchangedAsync();
    }

    [Fact]
    public async Task WrongPrincipal_StopsBeforeAnyRecording()
    {
        await using var upload = await CreateAsync();
        var native = await upload.NativeObservationAsync();
        var identity = (ClaimsIdentity)upload.Principal.Identity!;
        identity.RemoveClaim(upload.Principal.FindFirst("admin_id")!);
        identity.AddClaim(new("admin_id", "8"));
        var error = await Assert.ThrowsAsync<CurrentUploadAssetCleanupBindingRejectedException>(() =>
            upload.Reader.RecordCurrentAsync(native, upload.Principal, upload.Access, upload.Sha256, RequireUnchanged));
        Assert.Equal("attachment_cleanup_current_owner_changed", error.ReasonCode);
        Assert.Equal(0, await upload.Db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
        await upload.AssertBytesUnchangedAsync();
    }

    [Fact]
    public async Task LateOwnerChange_SuppressesObservationAfterRealCommit()
    {
        await using var upload = await CreateAsync();
        var native = await upload.NativeObservationAsync();
        int calls = 0;
        void RequireCurrent()
        {
            if (++calls == 2)
            {
                ((ClaimsIdentity)upload.Principal.Identity!).RemoveClaim(upload.Principal.FindFirst("admin_id")!);
            }
        }
        await Assert.ThrowsAsync<CurrentUploadAssetCleanupBindingRejectedException>(() => upload.Reader.RecordCurrentAsync(
            native, upload.Principal, upload.Access, upload.Sha256, RequireCurrent));
        Assert.Equal(2, calls);
        // The original writer really committed; rejection does not fabricate rollback.
        Assert.Equal(1, await upload.Db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
        Assert.Equal(ContentAssetStates.PendingDelete, (await upload.Db.Queryable<ContentAsset>().SingleAsync()).State);
        await upload.AssertBytesUnchangedAsync();
    }

    [Fact]
    public async Task WrongToken_PreservesOriginalNotFound()
    {
        await using var upload = await CreateAsync();
        var native = await upload.NativeObservationAsync();
        var result = await upload.Reader.RecordCurrentAsync(native, upload.Principal,
            upload.Access with
            {
                UploadToken = "wrong-token"
            }, upload.Sha256, RequireUnchanged);
        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.NotFound, result.Error.Code);
        Assert.Equal(0, await upload.Db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
        await upload.AssertBytesUnchangedAsync();
    }

    [Fact]
    public async Task CancellationBeforeBinding_CannotSchedule()
    {
        await using var upload = await CreateAsync();
        var native = await upload.NativeObservationAsync();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => upload.Reader.RecordCurrentAsync(
            native, upload.Principal, upload.Access, upload.Sha256, RequireUnchanged, cancellationToken: cancellation.Token));
        Assert.Equal(0, await upload.Db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
        await upload.AssertBytesUnchangedAsync();
    }

    [Fact]
    public async Task WrongCleanupCoordinates_RefuseBeforeScheduling()
    {
        await using var upload = await CreateAsync();
        var native = await upload.NativeObservationAsync();
        var cleanup = await upload.ObserveAsync();
        var result = await upload.Reader.RecordCurrentAsync(native, upload.Principal, upload.Access,
            upload.Sha256, RequireUnchanged, cleanup with
            {
                OwnerAdminPrincipalId = 8
            });
        Assert.False(result.IsSuccess);
        Assert.Equal("attachment_cleanup_business_binding_invalid", result.Error.Message);
        Assert.Equal(0, await upload.Db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
        await upload.AssertBytesUnchangedAsync();
    }

    [Fact]
    public async Task StaleVersion_PreservesStateChangedWithoutScheduling()
    {
        await using var upload = await CreateAsync();
        var native = await upload.NativeObservationAsync();
        var cleanup = await upload.ObserveAsync();
        var result = await upload.Reader.RecordCurrentAsync(native, upload.Principal, upload.Access,
            upload.Sha256, RequireUnchanged, cleanup with
            {
                AssetVersionSha256 = new string('0', 64)
            });
        Assert.True(result.IsSuccess);
        Assert.Equal(FileService.AttachmentCleanupStatus.StateChanged, result.Value!.Status);
        Assert.Equal(0, await upload.Db.Queryable<ContentAssetCleanupQueueItem>().CountAsync());
        await upload.AssertBytesUnchangedAsync();
    }

    private static void RequireUnchanged()
    {
    }

    private async Task<UploadContext> CreateAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(ContentAsset), typeof(ContentAssetReference), typeof(ContentAssetCleanupQueueItem));
        string root = Path.Combine(Path.GetTempPath(), "fsus-business-cleanup-" + Guid.NewGuid().ToString("N"));
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
        public IFileService Files => Service;
        public CurrentUploadAssetCleanupBindingReader Reader => new(Files);
        public ClaimsPrincipal Principal
        {
            get;
        } = new(new ClaimsIdentity(
            [new("admin_id", "7"), new("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind)], "task-native-postgres"));

        public async Task<UploadAssetObservation> NativeObservationAsync()
        {
            var result = await Files.ObserveCommittedUploadAsync(Access, Sha256);
            Assert.True(result.IsSuccess, result.Error.Message);
            return result.Value!;
        }

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
