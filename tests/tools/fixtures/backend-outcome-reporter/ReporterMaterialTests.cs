#nullable enable

using System.Text.Json;

using Xunit;
using Xunit.Abstractions;
using Xunit.Sdk;

namespace FsusBlog.BackendOutcomeReporterFixture;

public sealed class ReporterMaterialTests
{
    [ObservedTheory]
    [InlineData(1)]
    [InlineData(2)]
    public void NativeTheory(int value)
    {
        ObserveEqual(value, value);
    }

    [ObservedFact]
    public void NativeFailure()
    {
        ObserveEqual(1, 2);
    }

    private static void ObserveEqual(int expected, int actual)
    {
        string nativeCaseId = ObservedCaseContext.Current.Value
            ?? throw new InvalidOperationException("native xUnit case context is required");
        string status = "unobserved";
        try
        {
            Assert.Equal(expected, actual);
            status = "passed";
        }
        catch (Xunit.Sdk.EqualException)
        {
            status = "failed";
            throw;
        }
        finally
        {
            string directory = Environment.GetEnvironmentVariable("FSUSBLOG_BACKEND_ASSERTION_OBSERVATIONS")
                ?? throw new InvalidOperationException("task observation directory is required");
            string contextJson = Environment.GetEnvironmentVariable("FSUSBLOG_BACKEND_OUTCOME_CONTEXT")
                ?? throw new InvalidOperationException("task observation context is required");
            string replayDirectory = Environment.GetEnvironmentVariable("FSUSBLOG_BACKEND_REPLAY_MATERIAL")
                ?? throw new InvalidOperationException("original replay material is required");
            JsonElement plan = JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(Path.Combine(replayDirectory, "plan.json")));
            JsonElement manifest = JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(Path.Combine(replayDirectory, "queue-manifest.json")));
            Dictionary<string, object?> identity = JsonSerializer.Deserialize<Dictionary<string, object?>>(contextJson)
                ?? throw new InvalidOperationException("task observation context is invalid");
            identity["producerId"] = plan.GetProperty("producer").GetProperty("id").GetString();
            identity["sourceCommit"] = plan.GetProperty("source").GetProperty("commit").GetString();
            identity["worktreeFingerprint"] = plan.GetProperty("source").GetProperty("worktreeFingerprint").GetString();
            identity["schedulerRunId"] = plan.GetProperty("run").GetProperty("id").GetString();
            identity["replayPlanDigest"] = plan.GetProperty("planDigest").GetString();
            string canonicalTestId = manifest.GetProperty("slots").EnumerateArray()
                .SelectMany(slot => slot.GetProperty("collections").EnumerateArray())
                .SelectMany(collection => collection.GetProperty("tests").EnumerateArray())
                .Single(entry => entry.GetProperty("testCaseUniqueId").GetString() == nativeCaseId)
                .GetProperty("canonicalTestId").GetString()
                ?? throw new InvalidOperationException("native case has no canonical planned ID");
            object? failure = status == "failed" ? new
            {
                @class = "product",
                kind = "product.assertion",
                identity = new
                {
                    producerId = identity["producerId"],
                    testId = canonicalTestId,
                    caseId = nativeCaseId,
                    assertionId = "assert:equal"
                },
                diagnosticEvidenceId = $"assertion:{nativeCaseId}",
                semanticArtifactIds = Array.Empty<string>(),
                stateIds = Array.Empty<string>()
            } : null;
            var document = new
            {
                schema = "fsusblog.backend-native-assertion-observation.v1",
                identity,
                testCaseUniqueId = nativeCaseId,
                cases = new[]
                {
                    new { caseId = nativeCaseId, inputDigest = (string?)null,
                        shrinkSequenceIdentity = (string?)null, transitionIds = Array.Empty<string>() }
                },
                coverageIds = Array.Empty<string>(),
                artifactIds = Array.Empty<string>(),
                stateIds = Array.Empty<string>(),
                assertions = new[]
                {
                    new { id = "assert:equal", caseId = nativeCaseId, status, failure }
                }
            };
            string output = Path.Combine(directory, $"{nativeCaseId}.json");
            using var file = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            JsonSerializer.Serialize(file, document);
        }
    }
}


internal static class ObservedCaseContext
{
    internal static readonly AsyncLocal<string?> Current = new();
}

[XunitTestCaseDiscoverer("FsusBlog.BackendOutcomeReporterFixture.ObservedFactDiscoverer", "FsusBlog.BackendOutcomeReporterFixture")]
public sealed class ObservedFactAttribute : FactAttribute
{
}

[XunitTestCaseDiscoverer("FsusBlog.BackendOutcomeReporterFixture.ObservedTheoryDiscoverer", "FsusBlog.BackendOutcomeReporterFixture")]
public sealed class ObservedTheoryAttribute : TheoryAttribute
{
}

public sealed class ObservedFactDiscoverer(IMessageSink diagnosticMessageSink) : FactDiscoverer(diagnosticMessageSink)
{
    protected override IXunitTestCase CreateTestCase(ITestFrameworkDiscoveryOptions discoveryOptions,
        ITestMethod testMethod, IAttributeInfo factAttribute)
    {
        return new ObservedTestCase(DiagnosticMessageSink, discoveryOptions, testMethod, null);
    }
}

public sealed class ObservedTheoryDiscoverer(IMessageSink diagnosticMessageSink) : TheoryDiscoverer(diagnosticMessageSink)
{
    protected override IEnumerable<IXunitTestCase> CreateTestCasesForDataRow(ITestFrameworkDiscoveryOptions discoveryOptions,
        ITestMethod testMethod, IAttributeInfo theoryAttribute, object[] dataRow)
    {
        return [new ObservedTestCase(DiagnosticMessageSink, discoveryOptions, testMethod, dataRow)];
    }
}

public sealed class ObservedTestCase : XunitTestCase
{
    [Obsolete("Required by original xUnit deserialization", true)]
    public ObservedTestCase()
    {
    }

    public ObservedTestCase(IMessageSink diagnosticMessageSink, ITestFrameworkDiscoveryOptions options,
        ITestMethod testMethod, object[]? arguments)
        : base(diagnosticMessageSink, options.MethodDisplayOrDefault(), options.MethodDisplayOptionsOrDefault(), testMethod, arguments)
    {
    }

    public override async Task<RunSummary> RunAsync(IMessageSink diagnosticMessageSink, IMessageBus messageBus,
        object[] constructorArguments, ExceptionAggregator aggregator, CancellationTokenSource cancellationTokenSource)
    {
        string? previous = ObservedCaseContext.Current.Value;
        ObservedCaseContext.Current.Value = UniqueID;
        try
        {
            return await base.RunAsync(diagnosticMessageSink, messageBus, constructorArguments, aggregator, cancellationTokenSource);
        }
        finally
        {
            ObservedCaseContext.Current.Value = previous;
        }
    }
}
