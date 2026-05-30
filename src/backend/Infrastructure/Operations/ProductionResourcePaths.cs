namespace FsusBlog.Server.Infrastructure.Operations;

public static class ProductionResourcePaths
{
    public static string? ResolveIp2LocationBinPath(string baseDirectory)
    {
        string[] potentialPaths =
        [
            Path.Combine(baseDirectory, "wwwroot", "resources", "IP2LOCATION.BIN"),
            Path.Combine(baseDirectory, "resources", "IP2LOCATION.BIN"),
            Path.Combine(baseDirectory, "wwwroot", "resource", "IP2LOCATION.BIN")
        ];

        return potentialPaths.FirstOrDefault(File.Exists);
    }
}
