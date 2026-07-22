using System.Security.Cryptography;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Storage;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicArtifactStorageContractTests
{
    [Fact]
    public void RuntimeCompositionRegistersOneReplaceableSingletonStorageBoundary()
    {
        var services = new ServiceCollection();
        services.AddFsusRuntimeServices(new ConfigurationBuilder().Build());

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static candidate => candidate.ServiceType == typeof(IPublicArtifactStorage));
        Assert.Equal(ServiceLifetime.Singleton, descriptor.Lifetime);
        Assert.Contains(
            services,
            static candidate => candidate.ServiceType == typeof(LocalPublicArtifactStorage)
                && candidate.Lifetime == ServiceLifetime.Singleton);
    }

    [Fact]
    public async Task AtomicWritePublishesPayloadAndMetadataWithoutTemporaryResidue()
    {
        await WithStorageRootAsync(async (root, storage) =>
        {
            byte[] payload = "<main>home</main>"u8.ToArray();
            PublicArtifactKey key = PublicArtifactKey.PublicAotDocument("home", "aot:home", "frontend-v1", "renderer-v1");

            PublicArtifactDescriptor descriptor = await storage.WriteAsync(key, LocalPublicArtifactStorage.HtmlMediaType, payload);
            PublicArtifactReadResult? stored = await storage.TryReadAsync(key, LocalPublicArtifactStorage.HtmlMediaType, descriptor.Sha256Hex);

            Assert.NotNull(stored);
            Assert.Equal(payload, stored.Content.ToArray());
            Assert.Equal(payload.LongLength, descriptor.Bytes);
            Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(payload)), descriptor.Sha256Hex);
            Assert.Empty(Directory.EnumerateFiles(root, "*.tmp", SearchOption.AllDirectories));
        });
    }

    [Fact]
    public async Task ReadRejectsHashMediaTypeAndFrontendAssetVersionMismatch()
    {
        await WithStorageRootAsync(async (_, storage) =>
        {
            byte[] payload = [1, 2, 3, 4];
            string hash = Convert.ToHexStringLower(SHA256.HashData(payload));
            PublicArtifactKey key = PublicArtifactKey.HydrationSidecar("home", hash, "frontend-v1");
            await storage.WriteAsync(key, LocalPublicArtifactStorage.AedsMediaType, payload);

            Assert.Null(await storage.TryReadAsync(key, "application/octet-stream"));
            Assert.Null(await storage.TryReadAsync(key, LocalPublicArtifactStorage.AedsMediaType, "0".PadLeft(64, '0')));
            Assert.Null(await storage.TryReadAsync(
                PublicArtifactKey.HydrationSidecar("home", hash, "frontend-v2"),
                LocalPublicArtifactStorage.AedsMediaType,
                hash));
        });
    }

    [Fact]
    public async Task MissingOrTamperedSidecarFailsClosed()
    {
        await WithStorageRootAsync(async (_, storage) =>
        {
            byte[] payload = [5, 6, 7, 8];
            string hash = Convert.ToHexStringLower(SHA256.HashData(payload));
            PublicArtifactKey key = PublicArtifactKey.HydrationSidecar("article:42", hash, "frontend-v1");

            Assert.Null(await storage.TryReadAsync(key, LocalPublicArtifactStorage.AedsMediaType, hash));
            await storage.WriteAsync(key, LocalPublicArtifactStorage.AedsMediaType, payload);
            string path = storage.ResolvePathForTests(key);
            await File.WriteAllBytesAsync(path, [9, 9, 9, 9]);

            Assert.False(storage.IsValid(key, LocalPublicArtifactStorage.AedsMediaType, hash));
        });
    }

    [Fact]
    public async Task TwoClientsSharingOneRootReadDocumentSidecarAndArticleArtifacts()
    {
        await WithStorageRootAsync(async (root, first) =>
        {
            var second = CreateStorage(root);
            byte[] document = "<main>shared</main>"u8.ToArray();
            byte[] sidecar = [10, 11, 12];
            byte[] article = [20, 21, 22];
            string sidecarHash = Convert.ToHexStringLower(SHA256.HashData(sidecar));
            PublicArtifactKey documentKey = PublicArtifactKey.PublicAotDocument("home", "aot:home", "frontend-shared", "renderer-v1");
            PublicArtifactKey sidecarKey = PublicArtifactKey.HydrationSidecar("home", sidecarHash, "frontend-shared");
            PublicArtifactKey articleKey = PublicArtifactKey.ArticleDetail(42);

            await first.WriteAsync(documentKey, LocalPublicArtifactStorage.HtmlMediaType, document);
            await first.WriteAsync(sidecarKey, LocalPublicArtifactStorage.AedsMediaType, sidecar);
            await first.WriteAsync(articleKey, LocalPublicArtifactStorage.AedsMediaType, article);

            Assert.Equal(document, (await second.TryReadAsync(documentKey, LocalPublicArtifactStorage.HtmlMediaType))!.Content.ToArray());
            Assert.Equal(sidecar, (await second.TryReadAsync(sidecarKey, LocalPublicArtifactStorage.AedsMediaType, sidecarHash))!.Content.ToArray());
            Assert.Equal(article, (await second.TryReadAsync(articleKey, LocalPublicArtifactStorage.AedsMediaType))!.Content.ToArray());

            await second.RemoveAsync(articleKey);
            Assert.Null(await first.TryReadAsync(articleKey, LocalPublicArtifactStorage.AedsMediaType));
        });
    }

    [Fact]
    public async Task RemoveIsIdempotentWhenArtifactDirectoryIsAlreadyAbsent()
    {
        await WithStorageRootAsync(async (_, storage) =>
        {
            PublicArtifactKey key = PublicArtifactKey.ArticleDetail(42);
            byte[] payload = [20, 21, 22];
            await storage.WriteAsync(key, LocalPublicArtifactStorage.AedsMediaType, payload);
            string artifactDirectory = Path.GetDirectoryName(storage.ResolvePathForTests(key))!;
            Directory.Delete(artifactDirectory, recursive: true);

            await storage.RemoveAsync(key);
            await storage.RemoveAsync(key);
        });
    }

    private static async Task WithStorageRootAsync(Func<string, LocalPublicArtifactStorage, Task> action)
    {
        string root = Path.Combine(Path.GetTempPath(), "fsus-public-artifact-storage", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(root, "wwwroot"));
        try
        {
            await action(root, CreateStorage(root));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static LocalPublicArtifactStorage CreateStorage(string root)
        => new(
            new ArtifactTestWebHostEnvironment(root),
            NullLogger<LocalPublicArtifactStorage>.Instance);

    private sealed class ArtifactTestWebHostEnvironment(string root) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = nameof(PublicArtifactStorageContractTests);
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public string EnvironmentName { get; set; } = Environments.Production;
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
