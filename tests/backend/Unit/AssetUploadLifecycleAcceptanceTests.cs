using FsusBlog.Core.Common;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AssetUploadLifecycleAcceptanceTests(PostgresSchemaMigrationFixture postgres)
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public Task ActualOriginalUpload_ProducesOneExactLedgerAndNativeObject(bool multipart)
        => Run("happy-" + multipart, async fixture =>
        {
            await fixture.UploadAllAsync();
            await fixture.AssertUnpublishedAsync();
            var complete = await fixture.Service.CompleteUploadAsync(fixture.Access, fixture.Sha256);
            Assert.True(complete.IsSuccess, complete.Error.Message);
            await fixture.AssertCommittedAsync();
        }, AssetUploadLifecycleTestFixture.CreatePng(multipart));

    [Fact]
    public Task OutOfOrderAndDuplicateChunks_KeepExactProgressAndResume()
        => Run("out-of-order-and-duplicate", async fixture =>
        {
            int[] order = Enumerable.Range(0, fixture.Session.TotalParts).Reverse().ToArray();
            await fixture.UploadAllAsync(order);
            string original = AssetUploadLifecycleTestFixture.Hash(await File.ReadAllBytesAsync(fixture.WorkingFile));
            var duplicate = await fixture.UploadAsync(0);
            Assert.True(duplicate.IsSuccess, duplicate.Error.Message);
            Assert.Equal(fixture.Session.TotalParts, duplicate.Value!.UploadedPartCount);
            Assert.Equal(original, AssetUploadLifecycleTestFixture.Hash(await File.ReadAllBytesAsync(fixture.WorkingFile)));
            var map = await fixture.Service.GetUploadPartMapAsync(fixture.Access);
            Assert.True(map.IsSuccess, map.Error.Message);
            var complete = await fixture.Service.CompleteUploadAsync(fixture.Access, fixture.Sha256);
            Assert.True(complete.IsSuccess, complete.Error.Message);
            await fixture.AssertCommittedAsync();
        });

    [Theory]
    [InlineData("offset")]
    [InlineData("length")]
    [InlineData("hash")]
    [InlineData("owner")]
    [InlineData("token")]
    public Task FailedChunk_DoesNotAcknowledgeOrPublishAndCanRetry(string mutation)
        => Run("failed-chunk-" + mutation, async fixture =>
        {
            var bad = mutation switch
            {
                "offset" => await fixture.UploadAsync(0, offset: 1),
                "length" => await fixture.UploadAsync(0, replacement: [1]),
                "hash" => await fixture.UploadAsync(0, digest: new string('a', 64)),
                "owner" => await fixture.UploadAsync(0, access: fixture.Access with { OwnerAdminPrincipalId = 8 }),
                "token" => await fixture.UploadAsync(0, access: fixture.Access with { UploadToken = "incorrect-token" }),
                _ => throw new InvalidOperationException()
            };
            Assert.False(bad.IsSuccess);
            var status = await fixture.Service.GetUploadStatusAsync(fixture.Access);
            Assert.Equal(0, status.Value!.UploadedPartCount);
            Assert.Equal(0, status.Value.UploadedBytes);
            await fixture.AssertUnpublishedAsync();
            await fixture.RecordAsync("failed-chunk-not-acknowledged");
            await fixture.UploadAllAsync();
            Assert.True((await fixture.Service.CompleteUploadAsync(fixture.Access, fixture.Sha256)).IsSuccess);
            await fixture.AssertCommittedAsync();
        });

    [Theory]
    [InlineData("bad-payload-digest")]
    [InlineData("changed-payload")]
    public Task FailedRetransmission_DoesNotCorruptAcknowledgedChunk(string mutation)
        => Run("failed-retransmission-" + mutation, async fixture =>
        {
            await fixture.UploadAllAsync();
            string before = AssetUploadLifecycleTestFixture.Hash(await File.ReadAllBytesAsync(fixture.WorkingFile));
            byte[] changed = fixture.Bytes.AsSpan(0, fixture.Session.ChunkSize).ToArray();
            changed[^1] ^= 1;
            var duplicate = await fixture.UploadAsync(0, replacement: changed,
                digest: mutation == "bad-payload-digest" ? new string('a', 64) : null);
            Assert.False(duplicate.IsSuccess);
            Assert.Equal(before, AssetUploadLifecycleTestFixture.Hash(await File.ReadAllBytesAsync(fixture.WorkingFile)));
            var complete = await fixture.Service.CompleteUploadAsync(fixture.Access, fixture.Sha256);
            Assert.True(complete.IsSuccess, complete.Error.Message);
            await fixture.AssertCommittedAsync();
        });

    [Theory]
    [InlineData("missing-part")]
    [InlineData("digest")]
    [InlineData("owner")]
    [InlineData("token")]
    public Task FailedCommit_DoesNotPublishAndOriginalSessionCanComplete(string mutation)
        => Run("failed-commit-" + mutation, async fixture =>
        {
            await fixture.UploadAllAsync(mutation == "missing-part" ? [0] : null);
            var access = mutation switch
            {
                "owner" => fixture.Access with { OwnerAdminPrincipalId = 8 },
                "token" => fixture.Access with { UploadToken = "incorrect-token" },
                _ => fixture.Access
            };
            var bad = await fixture.Service.CompleteUploadAsync(access, mutation == "digest" ? new string('a', 64) : fixture.Sha256);
            Assert.False(bad.IsSuccess);
            await fixture.AssertUnpublishedAsync();
            await fixture.RecordAsync("failed-commit-unpublished");
            await fixture.UploadAllAsync();
            Assert.True((await fixture.Service.CompleteUploadAsync(fixture.Access, fixture.Sha256)).IsSuccess);
            await fixture.AssertCommittedAsync();
        });

    [Fact]
    public Task RepeatedAndConcurrentCommits_AreOneExactObjectAndLedger()
        => Run("repeated-and-concurrent-commit", async fixture =>
        {
            await fixture.UploadAllAsync();
            var results = await Task.WhenAll(Enumerable.Range(0, 8)
                .Select(_ => fixture.Service.CompleteUploadAsync(fixture.Access, fixture.Sha256)));
            Assert.All(results, result => Assert.True(result.IsSuccess, result.Error.Message));
            Assert.Single(results.Select(result => result.Value!.Url).Distinct(StringComparer.Ordinal));
            Assert.True((await fixture.Service.CompleteUploadAsync(fixture.Access, fixture.Sha256)).IsSuccess);
            await fixture.AssertCommittedAsync();
        });

    [Theory]
    [InlineData("owner")]
    [InlineData("digest")]
    [InlineData("state")]
    public Task CompletedRetry_CannotClaimSuccessWithTamperedLedger(string mutation)
        => Run("completed-ledger-" + mutation, async fixture =>
        {
            await fixture.UploadAllAsync();
            Assert.True((await fixture.Service.CompleteUploadAsync(fixture.Access, fixture.Sha256)).IsSuccess);
            await fixture.AssertCommittedAsync();
            if (mutation == "owner")
                await fixture.Db.Updateable<ContentAsset>().SetColumns(row => row.OwnerAdminPrincipalId == 8)
                    .Where(row => row.AssetId == fixture.AssetGuid).ExecuteCommandAsync();
            else if (mutation == "digest")
            {
                string changedSha256 = new('a', 64);
                await fixture.Db.Updateable<ContentAsset>().SetColumns(row => row.Sha256 == changedSha256)
                    .Where(row => row.AssetId == fixture.AssetGuid).ExecuteCommandAsync();
            }
            else
                await fixture.Db.Updateable<ContentAsset>().SetColumns(row => row.State == ContentAssetStates.PendingDelete)
                    .Where(row => row.AssetId == fixture.AssetGuid).ExecuteCommandAsync();
            var retry = await fixture.Service.CompleteUploadAsync(fixture.Access, fixture.Sha256);
            Assert.False(retry.IsSuccess);
            Assert.Equal(fixture.Bytes, await File.ReadAllBytesAsync(fixture.PublicFile));
            Assert.Single(await fixture.Db.Queryable<ContentAsset>().ToListAsync());
            await fixture.RecordAsync("tampered-ledger-retry-refused");
        });

    [Fact]
    public Task MalformedMediaMetadata_NeverPromotesUnregisteredPublicObject()
    {
        byte[] bytes = AssetUploadLifecycleTestFixture.CreatePng();
        bytes.AsSpan(16, 4).Clear();
        return Run("malformed-media-metadata", async fixture =>
        {
            await fixture.UploadAllAsync();
            var result = await fixture.Service.CompleteUploadAsync(fixture.Access, fixture.Sha256);
            Assert.False(result.IsSuccess);
            await fixture.AssertUnpublishedAsync();
        }, bytes);
    }

    [Fact]
    public Task CancellationBeforeMutation_LeavesOriginalSessionUsable()
        => Run("pre-cancelled-operations", async fixture =>
        {
            using var cancellation = new CancellationTokenSource();
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.UploadAsync(0, cancellationToken: cancellation.Token));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Service.CompleteUploadAsync(fixture.Access, fixture.Sha256, cancellation.Token));
            await fixture.AssertUnpublishedAsync();
            await fixture.UploadAllAsync();
            Assert.True((await fixture.Service.CompleteUploadAsync(fixture.Access, fixture.Sha256)).IsSuccess);
            await fixture.AssertCommittedAsync();
        });

    private Task Run(string scenario, Func<AssetUploadLifecycleTestFixture, Task> execute, byte[]? bytes = null)
        => AssetUploadLifecycleTestFixture.RunAsync(postgres, scenario, execute, bytes);
}
