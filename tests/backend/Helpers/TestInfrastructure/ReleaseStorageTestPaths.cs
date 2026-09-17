using FsusBlog.Server.Infrastructure.Storage;

namespace FsusBlog.Server.Tests;

internal static class ReleaseStorageTestPaths
{
    public static ReleaseStoragePaths Create(string root)
        => new ReleaseStorageLayout(
            Path.Combine(root, "shared"),
            Path.Combine(root, "derived"),
            Path.Combine(root, "release-assets"),
            Path.Combine(root, "instances"),
            "19700101000000-000000000000",
            "local",
            "tests",
            Path.Combine(root, "wwwroot")).Paths;
}
