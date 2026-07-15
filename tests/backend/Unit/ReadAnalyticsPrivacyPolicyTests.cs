using FsusBlog.Server.Infrastructure.Privacy;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ReadAnalyticsPrivacyPolicyTests
{
    [Fact]
    public void Protect_SuppressesRegionAndDwellCellsBelowK()
    {
        var policy = CreatePolicy();
        var cells = new[]
        {
            new ReadAggregateCount("small", 9),
            new ReadAggregateCount("large", 100)
        };

        IReadOnlyList<ReadAggregateCount> regions = policy.Protect(ReadAnalyticsPrivacyPolicy.AdminRegionScope, cells);
        IReadOnlyList<ReadAggregateCount> dwell = policy.Protect(ReadAnalyticsPrivacyPolicy.AdminDwellScope, cells);

        Assert.DoesNotContain(regions, static cell => cell.Label == "small");
        Assert.DoesNotContain(dwell, static cell => cell.Label == "small");
        Assert.Contains(regions, static cell => cell.Label == "large");
        Assert.Contains(dwell, static cell => cell.Label == "large");
    }

    [Fact]
    public void Protect_RepeatedDailyQueryIsDeterministicAndBudgetIsBounded()
    {
        var policy = CreatePolicy();
        var cells = new[]
        {
            new ReadAggregateCount("lt_10s", 100),
            new ReadAggregateCount("10_30s", 200)
        };

        IReadOnlyList<ReadAggregateCount> first = policy.Protect(ReadAnalyticsPrivacyPolicy.AdminDwellScope, cells);
        IReadOnlyList<ReadAggregateCount> second = policy.Protect(ReadAnalyticsPrivacyPolicy.AdminDwellScope, cells);

        Assert.Equal(first, second);
        Assert.Equal(10, policy.Budget.KThreshold);
        Assert.Equal(0.5d, policy.Budget.EpsilonPerRelease);
        Assert.Equal(1d, policy.Budget.DailyEpsilonLimit);
        Assert.Equal(1d, policy.Budget.ScheduledDailyEpsilon);
        Assert.Equal(2, policy.Budget.ReleaseScopes.Count);
    }

    [Fact]
    public void Constructor_RejectsScheduledEpsilonAboveDailyLimit()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            [ReadAnalyticsPrivacyPolicy.EpsilonPerReleaseSetting] = "1.0",
            [ReadAnalyticsPrivacyPolicy.DailyEpsilonLimitSetting] = "1.0"
        });

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(
            () => new ReadAnalyticsPrivacyPolicy(configuration, TimeProvider.System));

        Assert.Contains("exceeding", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(ReadAnalyticsPrivacyPolicy.KThresholdSetting, "not-an-integer")]
    [InlineData(ReadAnalyticsPrivacyPolicy.KThresholdSetting, "1")]
    [InlineData(ReadAnalyticsPrivacyPolicy.EpsilonPerReleaseSetting, "NaN")]
    [InlineData(ReadAnalyticsPrivacyPolicy.DailyEpsilonLimitSetting, "0")]
    public void Constructor_RejectsInvalidConfiguredBudgetInsteadOfSilentlyUsingDefaults(
        string setting,
        string value)
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            [setting] = value
        });

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(
            () => new ReadAnalyticsPrivacyPolicy(configuration, TimeProvider.System));

        Assert.Contains(setting, error.Message, StringComparison.Ordinal);
    }

    private static ReadAnalyticsPrivacyPolicy CreatePolicy()
        => new(CreateConfiguration(), TimeProvider.System);

    private static IConfiguration CreateConfiguration(IReadOnlyDictionary<string, string?>? overrides = null)
    {
        var settings = new Dictionary<string, string?>
        {
            [ReadAnalyticsPrivacyPolicy.NoiseKeySetting] = "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8=",
            [ReadAnalyticsPrivacyPolicy.KThresholdSetting] = "10",
            [ReadAnalyticsPrivacyPolicy.EpsilonPerReleaseSetting] = "0.5",
            [ReadAnalyticsPrivacyPolicy.DailyEpsilonLimitSetting] = "1.0"
        };
        if (overrides is not null)
        {
            foreach ((string key, string? value) in overrides)
            {
                settings[key] = value;
            }
        }

        return new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
    }
}
