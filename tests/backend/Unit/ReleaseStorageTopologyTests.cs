using System.Reflection;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

namespace FsusBlog.Server.Tests;

public sealed class ReleaseStorageTopologyTests
{
    public static TheoryData<string, string, string, string> OverlappingRootMatrix
    {
        get
        {
            var data = new TheoryData<string, string, string, string>();
            // shared root collides with web root → public/private assets under WebRoot
            data.Add("webroot", "derived", "assets", "instances");
            // shared nested under web root
            data.Add("shared-in-webroot", "derived", "assets", "instances");
            // shared equals derived base
            data.Add("shared", "shared", "assets", "instances");
            // shared equals immutable base
            data.Add("shared", "derived", "shared", "instances");
            // shared equals instance base
            data.Add("shared", "derived", "assets", "shared");
            // derived equals immutable
            data.Add("shared", "derived", "derived", "instances");
            // derived equals instance
            data.Add("shared", "derived", "assets", "derived");
            // immutable equals instance
            data.Add("shared", "derived", "assets", "assets");
            return data;
        }
    }

    [Theory]
    [MemberData(nameof(OverlappingRootMatrix))]
    public void Layout_RejectsOverlappingOrWebRootContainedAssetRoots(
        string sharedKind,
        string derivedKind,
        string immutableKind,
        string instanceKind)
    {
        string root = CreateTempDirectory();
        try
        {
            string webRoot = Path.Combine(root, "wwwroot");
            Directory.CreateDirectory(webRoot);

            string Resolve(string kind) => kind switch
            {
                "webroot" => webRoot,
                "shared-in-webroot" => Path.Combine(webRoot, "nested-shared"),
                "shared" => Path.Combine(root, "shared"),
                "derived" => Path.Combine(root, "derived"),
                "assets" => Path.Combine(root, "assets"),
                "instances" => Path.Combine(root, "instances"),
                _ => Path.Combine(root, kind)
            };

            Assert.ThrowsAny<Exception>(() => new ReleaseStorageLayout(
                Resolve(sharedKind),
                Resolve(derivedKind),
                Resolve(immutableKind),
                Resolve(instanceKind),
                "20260711000000-abcdef123456",
                "green",
                "generation-1",
                webRoot));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Layout_RejectsWhenAssetRootEqualsWebRoot()
    {
        string root = CreateTempDirectory();
        try
        {
            string webRoot = Path.Combine(root, "wwwroot");
            // Force PublicAssetRoot to land on webRoot by choosing shared so assets/public == webRoot.
            // SharedRoot/assets/public == webRoot means SharedRoot == parent of assets when structure matches.
            // Instead place webRoot equal to the computed public asset path by constructing paths carefully:
            string shared = Path.Combine(root, "shared");
            string publicAsset = Path.Combine(shared, "assets", "public");
            Directory.CreateDirectory(publicAsset);

            Assert.Throws<InvalidOperationException>(() => new ReleaseStorageLayout(
                shared,
                Path.Combine(root, "derived"),
                Path.Combine(root, "release-assets"),
                Path.Combine(root, "instances"),
                "20260711000000-abcdef123456",
                "green",
                "generation-1",
                publicAsset));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Layout_AcceptsDisjointRoots()
    {
        string root = CreateTempDirectory();
        try
        {
            var layout = new ReleaseStorageLayout(
                Path.Combine(root, "shared"),
                Path.Combine(root, "derived"),
                Path.Combine(root, "release-assets"),
                Path.Combine(root, "instances"),
                "20260711000000-abcdef123456",
                "blue",
                "generation-1",
                Path.Combine(root, "wwwroot"));

            Assert.Equal(
                Path.GetFullPath(Path.Combine(root, "shared", "assets", "public")),
                layout.Paths.PublicAssetRoot);
            Assert.Equal(
                Path.GetFullPath(Path.Combine(root, "shared", "assets", "private")),
                layout.Paths.PrivateAssetRoot);
            Assert.StartsWith(
                Path.GetFullPath(Path.Combine(root, "instances", "blue")),
                layout.Paths.UploadSessionRoot,
                StringComparison.Ordinal);
            Assert.StartsWith(
                Path.GetFullPath(Path.Combine(root, "instances", "blue")),
                layout.Paths.UploadCommitRoot,
                StringComparison.Ordinal);
            Assert.DoesNotContain(
                "UploadsRoot",
                typeof(ReleaseStoragePaths).GetProperties().Select(static property => property.Name));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void CompositionRoot_RegistersSingleReleaseStoragePathsInstanceForAssetConsumers()
    {
        string root = CreateTempDirectory();
        try
        {
            string webRoot = Path.Combine(root, "wwwroot");
            Directory.CreateDirectory(webRoot);
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["ReleaseStorage:SharedRoot"] = Path.Combine(root, "shared"),
                    ["ReleaseStorage:DerivedRoot"] = Path.Combine(root, "derived"),
                    ["ReleaseStorage:ImmutableAssetRoot"] = Path.Combine(root, "release-assets"),
                    ["ReleaseStorage:InstanceRoot"] = Path.Combine(root, "instances"),
                    ["FSUSBLOG_RELEASE_ID"] = "20260711000000-abcdef123456",
                    ["FSUSBLOG_RELEASE_SLOT"] = "green",
                    ["FSUSBLOG_DEPLOYMENT_GENERATION"] = "generation-test"
                })
                .Build();

            var environment = Substitute.For<IWebHostEnvironment>();
            environment.WebRootPath.Returns(webRoot);
            environment.ContentRootPath.Returns(root);
            environment.EnvironmentName.Returns("Development");
            environment.ApplicationName.Returns("ReleaseStorageTopologyTests");
            environment.WebRootFileProvider.Returns(new NullFileProvider());
            environment.ContentRootFileProvider.Returns(new NullFileProvider());

            var services = new ServiceCollection();
            services.AddSingleton<IConfiguration>(configuration);
            services.AddSingleton(environment);
            services.AddSingleton(typeof(ILogger<>), typeof(NullLogger<>));
            services.AddFsusRuntimeInfrastructureServices(configuration);

            using ServiceProvider provider = services.BuildServiceProvider(validateScopes: true);
            ReleaseStoragePaths first = provider.GetRequiredService<ReleaseStoragePaths>();
            ReleaseStoragePaths second = provider.GetRequiredService<ReleaseStoragePaths>();
            ReleaseStorageLayout layout = provider.GetRequiredService<ReleaseStorageLayout>();
            FileService fileService = provider.GetRequiredService<FileService>();
            IFileService fileServiceInterface = provider.GetRequiredService<IFileService>();

            Assert.Same(first, second);
            Assert.Same(first, layout.Paths);
            Assert.Same(first, fileService.StoragePaths);
            Assert.Same(fileService, fileServiceInterface);
            Assert.Equal(ServiceLifetime.Singleton, services.Single(static descriptor => descriptor.ServiceType == typeof(ReleaseStoragePaths)).Lifetime);
            Assert.Equal(ServiceLifetime.Singleton, services.Single(static descriptor => descriptor.ServiceType == typeof(ReleaseStorageLayout)).Lifetime);
            Assert.Equal(ServiceLifetime.Singleton, services.Single(static descriptor => descriptor.ServiceType == typeof(FileService)).Lifetime);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Composition_RejectsPopulatedLegacyUploadsRoot()
    {
        string root = CreateTempDirectory();
        try
        {
            string webRoot = Path.Combine(root, "wwwroot");
            string legacy = Path.Combine(webRoot, "uploads", "illustration");
            Directory.CreateDirectory(legacy);
            File.WriteAllText(Path.Combine(legacy, "stale.png"), "legacy");

            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["ReleaseStorage:SharedRoot"] = Path.Combine(root, "shared"),
                    ["ReleaseStorage:DerivedRoot"] = Path.Combine(root, "derived"),
                    ["ReleaseStorage:ImmutableAssetRoot"] = Path.Combine(root, "release-assets"),
                    ["ReleaseStorage:InstanceRoot"] = Path.Combine(root, "instances"),
                    ["FSUSBLOG_RELEASE_ID"] = "20260711000000-abcdef123456",
                    ["FSUSBLOG_RELEASE_SLOT"] = "green",
                    ["FSUSBLOG_DEPLOYMENT_GENERATION"] = "generation-test"
                })
                .Build();
            var environment = Substitute.For<IWebHostEnvironment>();
            environment.WebRootPath.Returns(webRoot);
            environment.ContentRootPath.Returns(root);

            InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
                () => ReleaseStorageComposition.Create(configuration, environment));
            Assert.Contains("Legacy upload root", exception.Message, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void AssetServices_SourceDoesNotReadWebRootContentRootOrLegacyUploadConstants()
    {
        string[] assetServiceSources =
        [
            Path.Combine("src", "backend", "Services", "FileService.cs"),
            Path.Combine("src", "backend", "Services", "Background", "ArticleAssetCleanupWorker.cs"),
            Path.Combine("src", "backend", "Infrastructure", "Operations", "AdminIntegrityOperations.cs")
        ];

        string repositoryRoot = BackendTestPaths.RepositoryRoot;
        foreach (string relative in assetServiceSources)
        {
            string source = File.ReadAllText(Path.Combine(repositoryRoot, relative));
            Assert.DoesNotContain("WebRootPath", source, StringComparison.Ordinal);
            Assert.DoesNotContain("ContentRootPath", source, StringComparison.Ordinal);
            Assert.DoesNotContain("wwwroot/uploads", source, StringComparison.Ordinal);
            Assert.DoesNotContain("wwwroot\\uploads", source, StringComparison.Ordinal);
            Assert.DoesNotContain(".upload-sessions", source, StringComparison.Ordinal);
            Assert.DoesNotContain("UploadsRoot", source, StringComparison.Ordinal);
            Assert.DoesNotContain("FSUSBLOG_SHARED_STORAGE_ROOT", source, StringComparison.Ordinal);
            Assert.DoesNotContain("FSUSBLOG_INSTANCE_STORAGE_ROOT", source, StringComparison.Ordinal);
        }

        string fileServiceSource = File.ReadAllText(Path.Combine(repositoryRoot, assetServiceSources[0]));
        Assert.Contains("ReleaseStoragePaths", fileServiceSource, StringComparison.Ordinal);
        Assert.Contains("PublicAssetRoot", fileServiceSource, StringComparison.Ordinal);
        Assert.Contains("UploadSessionRoot", fileServiceSource, StringComparison.Ordinal);
        Assert.Contains("UploadCommitRoot", fileServiceSource, StringComparison.Ordinal);
        Assert.Contains("expiration.bucket", fileServiceSource, StringComparison.Ordinal);
        Assert.Contains("TryReadExpirationIndexOwner", fileServiceSource, StringComparison.Ordinal);
        Assert.Contains("DeleteOwnedExpirationIndex", fileServiceSource, StringComparison.Ordinal);
    }

    [Fact]
    public void ReleaseStoragePaths_IsImmutableRecordWithoutUploadsRoot()
    {
        Assert.True(typeof(ReleaseStoragePaths).IsSealed);
        Assert.NotNull(typeof(ReleaseStoragePaths).GetMethod("<Clone>$")
            ?? typeof(ReleaseStoragePaths).GetMethod("printMembers", BindingFlags.Instance | BindingFlags.NonPublic));
        Assert.Null(typeof(ReleaseStoragePaths).GetProperty("UploadsRoot"));
        Assert.NotNull(typeof(ReleaseStoragePaths).GetProperty(nameof(ReleaseStoragePaths.PublicAssetRoot)));
        Assert.NotNull(typeof(ReleaseStoragePaths).GetProperty(nameof(ReleaseStoragePaths.PrivateAssetRoot)));
        Assert.NotNull(typeof(ReleaseStoragePaths).GetProperty(nameof(ReleaseStoragePaths.UploadSessionRoot)));
        Assert.NotNull(typeof(ReleaseStoragePaths).GetProperty(nameof(ReleaseStoragePaths.UploadCommitRoot)));
    }

    private static string CreateTempDirectory()
    {
        string path = Path.Combine(Path.GetTempPath(), "fsus-release-storage-topology", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

}
