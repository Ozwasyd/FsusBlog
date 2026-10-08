using FsusBlog.Server.Tests.Unit;
using System.Text.Json;

using Xunit;

namespace FsusBlog.BackendOutcomeReporterFixture;

internal static class PropertyJournalContext
{
    internal static int Seed { get; private set; }

    public static BackendPropertyExecutionJournal Open()
    {
        string directory = Environment.GetEnvironmentVariable("FSUSBLOG_BACKEND_REPLAY_MATERIAL")
            ?? throw new InvalidOperationException("actual task replay material is required");
        using var plan = JsonDocument.Parse(File.ReadAllText(Path.Combine(directory, "plan.json")));
        string canonicalTestId = plan.RootElement.GetProperty("testEnumerationOrder").EnumerateArray().Single().GetString()!;
        string seed = plan.RootElement.GetProperty("rootSeed").GetString()!;
        Seed = unchecked((int)uint.Parse(seed.AsSpan("seed256:".Length, 8), System.Globalization.NumberStyles.HexNumber,
            System.Globalization.CultureInfo.InvariantCulture));
        Environment.SetEnvironmentVariable("FSUSBLOG_RANDOM_STREAMS_JSON", JsonSerializer.Serialize(new Dictionary<string, string>
        {
            [$"{canonicalTestId}\0ordinary-native-samples"] = seed
        }));
        Environment.SetEnvironmentVariable("FSUSBLOG_REPLAY_PLAN_DIGEST", plan.RootElement.GetProperty("planDigest").GetString());
        return BackendPropertyExecutionJournal.Open(canonicalTestId, "ordinary-native-samples");
    }
}

public sealed class PropertyJournalSuccessTests
{
    [Fact]
    public void NativeSamples()
    {
        using var execution = PropertyJournalContext.Open();
        var random = new Random(PropertyJournalContext.Seed);
        for (int index = 0; index < 3; index++)
        {
            int sample = random.Next(1, 100);
            execution.Observe(sample.ToString(System.Globalization.CultureInfo.InvariantCulture), index, () => Assert.InRange(sample, 1, 99));
        }
        execution.Complete(3);
    }
}

public sealed class PropertyJournalFailureTests
{
    [Fact]
    public void NativeFailureSample()
    {
        using var execution = PropertyJournalContext.Open();
        execution.Observe("first-actual-sample", 0, () => Assert.Equal(1, 1));
        execution.Observe("failed-actual-sample", 1, () => Assert.Equal(1, 2));
    }
}

public sealed class PropertyJournalCancelTests
{
    [Fact]
    public void NativeIncompleteSample()
    {
        using var execution = PropertyJournalContext.Open();
        execution.Observe("first-actual-sample", 0, () => Assert.Equal(1, 1));
        execution.Observe("live-actual-sample", 1, () => Thread.Sleep(Timeout.Infinite));
    }
}
