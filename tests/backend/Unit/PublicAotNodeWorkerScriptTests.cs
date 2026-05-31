using FsusBlog.Server.Infrastructure.PublicAot;

namespace FsusBlog.Server.Tests;

public sealed class PublicAotNodeWorkerScriptTests
{
    [Theory]
    [InlineData(int.MinValue, 1)]
    [InlineData(int.MinValue, 3)]
    [InlineData(-1, 4)]
    [InlineData(0, 4)]
    [InlineData(int.MaxValue, 7)]
    public void NodeWorkerPoolIndex_HandlesOverflowAndNeverReturnsNegative(int counter, int workerCount)
    {
        int index = PublicAotNodeSsrRenderer.CalculateWorkerIndexForTests(counter, workerCount);

        Assert.InRange(index, 0, workerCount - 1);
    }

    [Fact]
    public void ServerPublicSsrScript_ExposesLineProtocolWorkerCommands()
    {
        string repoRoot = FindRepoRoot();
        string rendererPath = Path.Combine(repoRoot, "src", "backend", "Infrastructure", "PublicAot", "PublicAotNodeSsrRenderer.cs");
        string source = File.ReadAllText(rendererPath);

        Assert.Contains("--worker", source);
        Assert.Contains("requestId", source);
        Assert.Contains("buildEntry", source);
        Assert.Contains("validateBundle", source);
        Assert.Contains("shutdown", source);
    }

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")) ||
                File.Exists(Path.Combine(current, "src", "backend", "Infrastructure", "PublicAot", "PublicAotNodeSsrRenderer.cs")))
            {
                return current;
            }

            DirectoryInfo? parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        throw new DirectoryNotFoundException("Unable to locate repository root.");
    }
}
