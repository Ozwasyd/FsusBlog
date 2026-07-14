using System.Buffers.Binary;
using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleDetailAedsArtifactStoreBehaviorTests
{
    [Fact]
    public async Task WriteThenRead_RoundTripsV3FrameFromMemory()
    {
        await WithArtifactRootAsync(async root =>
        {
            var store = CreateStore(root);
            byte[] frame = CreateArticleDetailV3Frame();

            await store.WriteAsync(42, frame);
            ArticleDetailAedsArtifact artifact = await store.TryReadAsync(42);

            Assert.True(artifact.Found);
            Assert.Equal(frame, artifact.Frame.ToArray());
            Assert.Equal(frame, await File.ReadAllBytesAsync(ArtifactPath(root, 42)));
        });
    }

    [Fact]
    public async Task MemoryEntry_IsServedBeforeTtlAndExpiresAtTheTtlBoundary()
    {
        await WithArtifactRootAsync(async root =>
        {
            var clock = new ManualTimeProvider(new DateTimeOffset(2026, 7, 11, 10, 0, 0, TimeSpan.Zero));
            var store = CreateStore(root, clock);
            byte[] frame = CreateArticleDetailV3Frame();
            await store.WriteAsync(42, frame);
            File.Delete(ArtifactPath(root, 42));

            clock.Advance(TimeSpan.FromSeconds(29));
            ArticleDetailAedsArtifact beforeExpiry = await store.TryReadAsync(42);
            clock.Advance(TimeSpan.FromSeconds(1));
            ArticleDetailAedsArtifact atExpiry = await store.TryReadAsync(42);

            Assert.True(beforeExpiry.Found);
            Assert.Equal(frame, beforeExpiry.Frame.ToArray());
            Assert.False(atExpiry.Found);
        });
    }

    [Fact]
    public async Task WriteAsync_AcceptsV3FrameAndRejectsLegacyArticleDetailFrame()
    {
        await WithArtifactRootAsync(async root =>
        {
            var store = CreateStore(root);
            byte[] v3Frame = CreateArticleDetailV3Frame();
            byte[] legacyFrame = new AedsEncoder().Encode(AedsFrameType.ArticleDetail, [0x01, 0x02, 0x03]);

            await store.WriteAsync(42, v3Frame);

            Assert.True((await store.TryReadAsync(42)).Found);
            await Assert.ThrowsAsync<InvalidDataException>(() => store.WriteAsync(43, legacyFrame));
            Assert.False(File.Exists(ArtifactPath(root, 43)));
        });
    }

    [Fact]
    public async Task TryReadAsync_ReturnsMissForLegacyDiskFrame()
    {
        await WithArtifactRootAsync(async root =>
        {
            var store = CreateStore(root);
            string path = ArtifactPath(root, 42);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            await File.WriteAllBytesAsync(
                path,
                new AedsEncoder().Encode(AedsFrameType.ArticleDetail, [0x01, 0x02, 0x03]));

            ArticleDetailAedsArtifact artifact = await store.TryReadAsync(42);

            Assert.False(artifact.Found);
        });
    }

    [Fact]
    public async Task WriteAsync_RejectsNonV3PayloadMagic()
    {
        await WithArtifactRootAsync(async root =>
        {
            var store = CreateStore(root);
            byte[] frame = CreateArticleDetailV3Frame();
            BinaryPrimitives.WriteUInt32LittleEndian(
                frame.AsSpan(AedsFrameHeader.Size, sizeof(uint)),
                0x21444142u);

            await Assert.ThrowsAsync<InvalidDataException>(() => store.WriteAsync(42, frame));
            Assert.False(File.Exists(ArtifactPath(root, 42)));
        });
    }

    [Fact]
    public async Task RemoveAsync_RemovesBothMemoryAndDiskCopies()
    {
        await WithArtifactRootAsync(async root =>
        {
            var store = CreateStore(root);
            await store.WriteAsync(42, CreateArticleDetailV3Frame());

            await store.RemoveAsync(42);

            Assert.False(File.Exists(ArtifactPath(root, 42)));
            Assert.False((await store.TryReadAsync(42)).Found);
        });
    }

    [Fact]
    public async Task ClearLegacyPublicArtifactsAsync_RemovesOnlyNonV3Frames()
    {
        await WithArtifactRootAsync(async root =>
        {
            string v3Path = ArtifactPath(root, 1);
            string legacyPath = ArtifactPath(root, 2);
            Directory.CreateDirectory(Path.GetDirectoryName(v3Path)!);
            await File.WriteAllBytesAsync(v3Path, CreateArticleDetailV3Frame());
            await File.WriteAllBytesAsync(
                legacyPath,
                new AedsEncoder().Encode(AedsFrameType.ArticleDetail, [0x01, 0x02, 0x03]));
            var service = new ArticleDetailAedsArtifactMaintenanceService(
                Substitute.For<ISqlSugarClient>(),
                new ArtifactTestWebHostEnvironment(root),
                Substitute.For<IServiceScopeFactory>(),
                Substitute.For<IArticleDetailAedsArtifactProjector>(),
                Substitute.For<IDbConcurrencyGate>(),
                NullLogger<ArticleDetailAedsArtifactMaintenanceService>.Instance);

            ArticleDetailAedsArtifactMaintenanceResult result = await service.ClearLegacyPublicArtifactsAsync();

            Assert.Equal(2, result.Scanned);
            Assert.Equal(1, result.Removed);
            Assert.Equal(1, result.Skipped);
            Assert.Equal(0, result.Failed);
            Assert.True(File.Exists(v3Path));
            Assert.False(File.Exists(legacyPath));
        });
    }

    private static ArticleDetailAedsFileArtifactStore CreateStore(string root, TimeProvider? timeProvider = null)
        => new(
            new ArtifactTestWebHostEnvironment(root),
            NullLogger<ArticleDetailAedsFileArtifactStore>.Instance,
            timeProvider);

    private static string ArtifactPath(string root, int articleId)
        => Path.Combine(root, "runtime-cache", "public", "articles", $"{articleId}.aeds");

    private static byte[] CreateArticleDetailV3Frame()
    {
        byte[] payload = new byte[sizeof(uint) + sizeof(int)];
        BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(0, sizeof(uint)), 0x41524433u);
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(sizeof(uint), sizeof(int)), 3);
        return new AedsEncoder().Encode(AedsFrameType.ArticleDetail, payload);
    }

    private static async Task WithArtifactRootAsync(Func<string, Task> action)
    {
        string root = Path.Combine(Path.GetTempPath(), "fsus-aeds-artifact-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            await action(root);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan elapsed) => _now = _now.Add(elapsed);
    }

    private sealed class ArtifactTestWebHostEnvironment(string root) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = nameof(ArticleDetailAedsArtifactStoreBehaviorTests);
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public string EnvironmentName { get; set; } = Environments.Production;
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
