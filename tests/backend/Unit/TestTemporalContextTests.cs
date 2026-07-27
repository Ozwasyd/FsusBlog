using System.Globalization;

using FsusBlog.Server.Tests.Fixtures;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.DependencyInjection;

namespace FsusBlog.Server.Tests.Unit;

[Collection(nameof(EnvironmentVariableCollection))]
public sealed class TestTemporalContextTests
{
    [Fact]
    public void CreateCanonical_UsesFixedUtcEpochAndInvariantCulture()
    {
        TestTemporalContext context = TestTemporalContext.CreateCanonical();

        Assert.Equal(TestTemporalContext.CanonicalBusinessEpochUtc, context.BusinessEpochUtc);
        Assert.Equal(TimeSpan.Zero, context.BusinessEpochUtc.Offset);
        Assert.Equal(CultureInfo.InvariantCulture, context.BackendCulture);
        Assert.Equal("Invariant", context.BackendCultureToken);
        Assert.Equal("UTC", context.Timezone);
        Assert.Equal("UTC", context.PostgresTimezone);
        Assert.Equal("UTC", context.NodeTimezone);
        Assert.Contains("timezone=UTC", context.PostgresSessionOptions, StringComparison.Ordinal);
        Assert.Contains(
            "fsusblog.test_business_epoch_utc=2024-02-29T23:59:59.0000000+00:00",
            context.PostgresSessionOptions,
            StringComparison.Ordinal);
    }

    [Fact]
    public void Advance_MovesBusinessWallClockWithoutFreezingMonotonicMeasurement()
    {
        TestTemporalContext context = TestTemporalContext.CreateCanonical();
        long firstTimestamp = context.BusinessClock.GetTimestamp();
        Thread.Sleep(2);
        long secondTimestamp = context.BusinessClock.GetTimestamp();

        Assert.True(secondTimestamp > firstTimestamp);

        context.Advance(TimeSpan.FromHours(1));
        Assert.Equal(
            TestTemporalContext.CanonicalBusinessEpochUtc.AddHours(1),
            context.BusinessEpochUtc);

        TimeSpan elapsed = context.BusinessClock.GetElapsedTime(firstTimestamp, secondTimestamp);
        Assert.True(elapsed > TimeSpan.Zero);
        Assert.True(elapsed < TimeSpan.FromSeconds(1));
    }

    [Fact]
    public void ConfigureServices_ReplacesBusinessTimeProviderOnly()
    {
        TestTemporalContext context = TestTemporalContext.CreateCanonical();
        var services = new ServiceCollection();
        services.AddSingleton(TimeProvider.System);
        context.ConfigureServices(services);
        using ServiceProvider provider = services.BuildServiceProvider();

        Assert.Same(context, provider.GetRequiredService<TestTemporalContext>());
        Assert.Same(context.BusinessClock, provider.GetRequiredService<TimeProvider>());
        Assert.Equal(context.BusinessEpochUtc, provider.GetRequiredService<TimeProvider>().GetUtcNow());
    }

    [Fact]
    public void FromEnvironment_RejectsNonCanonicalCultureAndTimezone()
    {
        string? previousCulture = Environment.GetEnvironmentVariable(
            TestTemporalContext.BackendCultureEnvironmentVariable);
        string? previousPostgres = Environment.GetEnvironmentVariable(
            TestTemporalContext.PostgresTimezoneEnvironmentVariable);
        try
        {
            Environment.SetEnvironmentVariable(
                TestTemporalContext.BackendCultureEnvironmentVariable,
                "zh-CN");
            InvalidOperationException cultureError = Assert.Throws<InvalidOperationException>(
                TestTemporalContext.FromEnvironment);
            Assert.Contains(
                TestTemporalContext.BackendCultureEnvironmentVariable,
                cultureError.Message,
                StringComparison.Ordinal);

            Environment.SetEnvironmentVariable(
                TestTemporalContext.BackendCultureEnvironmentVariable,
                TestTemporalContext.CanonicalBackendCulture);
            Environment.SetEnvironmentVariable(
                TestTemporalContext.PostgresTimezoneEnvironmentVariable,
                "Asia/Shanghai");
            InvalidOperationException timezoneError = Assert.Throws<InvalidOperationException>(
                TestTemporalContext.FromEnvironment);
            Assert.Contains(
                TestTemporalContext.PostgresTimezoneEnvironmentVariable,
                timezoneError.Message,
                StringComparison.Ordinal);
        }
        finally
        {
            Environment.SetEnvironmentVariable(
                TestTemporalContext.BackendCultureEnvironmentVariable,
                previousCulture);
            Environment.SetEnvironmentVariable(
                TestTemporalContext.PostgresTimezoneEnvironmentVariable,
                previousPostgres);
        }
    }

    [Fact]
    public void BusinessClock_RejectsBackwardSteps()
    {
        TestTemporalContext context = TestTemporalContext.CreateCanonical();
        Assert.Throws<ArgumentOutOfRangeException>(() => context.Advance(TimeSpan.FromSeconds(-1)));
    }
}
