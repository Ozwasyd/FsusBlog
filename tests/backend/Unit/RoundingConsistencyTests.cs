using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed class RoundingConsistencyTests
{
    [Fact]
    public void Round2_UsesAwayFromZeroAtMidpoint()
    {
        Assert.Equal(1.13d, RoundingHelper.Round2(1.125d));
        Assert.Equal(-1.13d, RoundingHelper.Round2(-1.125d));
    }

    [Fact]
    public void ProductionMathRoundCalls_UseAwayFromZero()
    {
        string backendRoot = Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend");
        string[] files = Directory.GetFiles(backendRoot, "*.cs", SearchOption.AllDirectories);

        foreach (string file in files)
        {
            string relative = Path.GetRelativePath(BackendTestPaths.RepositoryRoot, file).Replace('\\', '/');
            string[] lines = File.ReadAllLines(file);
            for (int i = 0; i < lines.Length; i++)
            {
                string line = lines[i];
                if (!line.Contains("Math.Round(", StringComparison.Ordinal))
                {
                    continue;
                }

                Assert.True(
                    line.Contains("MidpointRounding.AwayFromZero", StringComparison.Ordinal),
                    $"{relative}:{i + 1} uses Math.Round without explicit AwayFromZero");
            }
        }
    }
}
