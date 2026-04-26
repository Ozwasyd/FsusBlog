using FsusBlog.Server.Infrastructure.Operations;
using System.Text.Json;

namespace FsusBlog.Server.Tests;

public sealed class ProductionHealthTests
{
    [Fact]
    public void LivenessReport_ReturnsLiveWithoutReadinessDependencies()
    {
        object report = ProductionLivenessProbe.CreateReport();

        string body = JsonSerializer.Serialize(report);
        Assert.Contains("\"status\":\"live\"", body, StringComparison.Ordinal);
    }

    [Fact]
    public void ResourcePathResolver_FindsIp2LocationBinUnderWwwrootResources()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), "fsusblog-health-" + Guid.NewGuid().ToString("N"));
        string resourceDir = Path.Combine(tempRoot, "wwwroot", "resources");
        Directory.CreateDirectory(resourceDir);
        string binPath = Path.Combine(resourceDir, "IP2LOCATION.BIN");
        File.WriteAllBytes(binPath, [1, 2, 3]);

        try
        {
            string? resolved = ProductionResourcePaths.ResolveIp2LocationBinPath(tempRoot);

            Assert.Equal(binPath, resolved);
        }
        finally
        {
            Directory.Delete(tempRoot, recursive: true);
        }
    }
}
