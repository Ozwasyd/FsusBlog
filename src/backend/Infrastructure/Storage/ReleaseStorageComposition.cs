namespace FsusBlog.Server.Infrastructure.Storage;

internal static class ReleaseStorageComposition
{
    private const string DevelopmentReleaseId = "19700101000000-000000000000";

    public static ReleaseStorageLayout Create(
        IConfiguration configuration,
        IWebHostEnvironment environment)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(environment);

        string storageBase = Path.Combine(AppContext.BaseDirectory, "storage");
        string sharedRoot = Read(configuration, "ReleaseStorage:SharedRoot", "FSUSBLOG_SHARED_STORAGE_ROOT")
            ?? Path.Combine(storageBase, "shared");
        string derivedRoot = Read(configuration, "ReleaseStorage:DerivedRoot", "FSUSBLOG_RELEASE_DERIVED_ROOT")
            ?? Path.Combine(storageBase, "release-derived");
        string immutableAssetRoot = Read(configuration, "ReleaseStorage:ImmutableAssetRoot", "FSUSBLOG_RELEASE_ASSET_ROOT")
            ?? Path.Combine(storageBase, "release-assets");
        string instanceRoot = Read(configuration, "ReleaseStorage:InstanceRoot", "FSUSBLOG_INSTANCE_STORAGE_ROOT")
            ?? Path.Combine(storageBase, "instances");
        string releaseId = Read(configuration, "FSUSBLOG_RELEASE_ID")
            ?? DevelopmentReleaseId;
        string slot = Read(configuration, "FSUSBLOG_RELEASE_SLOT")
            ?? "local";
        string instanceId = Read(configuration, "FSUSBLOG_DEPLOYMENT_GENERATION")
            ?? $"process-{Environment.ProcessId}";

        string webRoot = string.IsNullOrWhiteSpace(environment.WebRootPath)
            ? Path.Combine(environment.ContentRootPath, "wwwroot")
            : environment.WebRootPath;
        var layout = new ReleaseStorageLayout(
            sharedRoot,
            derivedRoot,
            immutableAssetRoot,
            instanceRoot,
            releaseId,
            slot,
            instanceId,
            webRoot);

        RejectPopulatedLegacyUploadsRoot(webRoot);
        EnsureRuntimeDirectories(layout.Paths);
        return layout;
    }

    private static string? Read(IConfiguration configuration, params string[] keys)
    {
        foreach (string key in keys)
        {
            string? value = configuration[key];
            if (!string.IsNullOrWhiteSpace(value))
            {
                return value.Trim();
            }
        }

        return null;
    }

    private static void RejectPopulatedLegacyUploadsRoot(string webRoot)
    {
        string legacyRoot = Path.Combine(Path.GetFullPath(webRoot), "uploads");
        if (Directory.Exists(legacyRoot) && Directory.EnumerateFileSystemEntries(legacyRoot).Any())
        {
            throw new InvalidOperationException(
                $"Legacy upload root '{legacyRoot}' still contains entries. Stop writes, run the one-time asset migration, and remove the legacy root before startup.");
        }
    }

    private static void EnsureRuntimeDirectories(ReleaseStoragePaths paths)
    {
        Directory.CreateDirectory(paths.PublicAssetRoot);
        CreateRestrictedDirectory(paths.PrivateAssetRoot);
        CreateRestrictedDirectory(paths.UploadSessionRoot);
        CreateRestrictedDirectory(paths.UploadCommitRoot);
    }

    private static void CreateRestrictedDirectory(string path)
    {
        Directory.CreateDirectory(path);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(
                path,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }
}
