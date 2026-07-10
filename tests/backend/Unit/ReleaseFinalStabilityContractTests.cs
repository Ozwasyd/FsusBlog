using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ReleaseFinalStabilityContractTests
{
    [Fact]
    public void ArticleFrameCoalescingTest_UsesCoverageFriendlyCompletionBudget()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("tests/backend/Unit/ArticleEndpointServiceTests.cs");

        Assert.Contains("ConcurrentColdFrameWaitTimeout", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Task.WhenAll(tasks).WaitAsync(TimeSpan.FromSeconds(5))", source, StringComparison.Ordinal);
    }

    [Fact]
    public void PostgresSchemaMigrationFixture_UsesCoverageFriendlyConnectionBudgets()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("tests/backend/Fixtures/PostgresSchemaMigrationFixture.cs");

        Assert.Contains("Timeout=30", source, StringComparison.Ordinal);
        Assert.Contains("Command Timeout=60", source, StringComparison.Ordinal);
        Assert.Contains("TryRunDockerAsync(\"rm\", \"-f\", \"-v\", _containerName)", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Timeout=15;Command Timeout=30", source, StringComparison.Ordinal);
    }
}
