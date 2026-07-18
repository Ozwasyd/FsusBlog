using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Infrastructure.Privacy;

public readonly record struct ReadAggregateCount(string Label, long Count);

public sealed record ReadAnalyticsPrivacyBudget(
    int KThreshold,
    double EpsilonPerRelease,
    double DailyEpsilonLimit,
    double ScheduledDailyEpsilon,
    IReadOnlyList<string> ReleaseScopes);

public interface IReadAnalyticsPrivacyPolicy
{
    ReadAnalyticsPrivacyBudget Budget
    {
        get;
    }

    IReadOnlyList<ReadAggregateCount> Protect(
        string releaseScope,
        IReadOnlyList<ReadAggregateCount> cells);
}

/// <summary>
/// Applies k suppression followed by deterministic, daily Laplace noise. A
/// release scope has one stable result per UTC day, so repeated reads cannot
/// average away noise or spend unbounded privacy budget.
/// </summary>
public sealed class ReadAnalyticsPrivacyPolicy : IReadAnalyticsPrivacyPolicy
{
    public const string SectionName = "ReadAnalyticsPrivacy";
    public const string NoiseKeySetting = SectionName + ":NoiseKey";
    public const string KThresholdSetting = SectionName + ":KThreshold";
    public const string EpsilonPerReleaseSetting = SectionName + ":EpsilonPerRelease";
    public const string DailyEpsilonLimitSetting = SectionName + ":DailyEpsilonLimit";
    public const string AdminRegionScope = "admin-region";
    public const string AdminDwellScope = "admin-dwell";

    private static readonly string[] ReleaseScopes = [AdminRegionScope, AdminDwellScope];
    private readonly byte[] _noiseKey;
    private readonly TimeProvider _timeProvider;

    public ReadAnalyticsPrivacyPolicy(IConfiguration configuration, TimeProvider timeProvider)
    {
        _noiseKey = ReadKey(configuration);
        _timeProvider = timeProvider;
        int k = ReadInt(configuration, KThresholdSetting, 10, min: 2, max: 10_000);
        double epsilon = ReadDouble(configuration, EpsilonPerReleaseSetting, 0.5d, minExclusive: 0d, maxInclusive: 2d);
        double dailyLimit = ReadDouble(configuration, DailyEpsilonLimitSetting, 1d, minExclusive: 0d, maxInclusive: 10d);
        double scheduled = epsilon * ReleaseScopes.Length;
        if (scheduled > dailyLimit)
        {
            throw new InvalidOperationException(
                $"{EpsilonPerReleaseSetting} schedules {scheduled.ToString(CultureInfo.InvariantCulture)} epsilon per day, exceeding {DailyEpsilonLimitSetting}={dailyLimit.ToString(CultureInfo.InvariantCulture)}.");
        }

        Budget = new ReadAnalyticsPrivacyBudget(k, epsilon, dailyLimit, scheduled, ReleaseScopes);
    }

    public ReadAnalyticsPrivacyBudget Budget
    {
        get;
    }

    public IReadOnlyList<ReadAggregateCount> Protect(
        string releaseScope,
        IReadOnlyList<ReadAggregateCount> cells)
    {
        if (!ReleaseScopes.Contains(releaseScope, StringComparer.Ordinal))
        {
            throw new ArgumentOutOfRangeException(nameof(releaseScope), "Unknown read analytics release scope.");
        }

        DateOnly releaseDay = DateOnly.FromDateTime(_timeProvider.GetUtcNow().UtcDateTime);
        var protectedCells = new List<ReadAggregateCount>(cells.Count);
        foreach (ReadAggregateCount cell in cells)
        {
            if (cell.Count < Budget.KThreshold || string.IsNullOrWhiteSpace(cell.Label))
            {
                continue;
            }

            double noise = SampleDailyLaplaceNoise(releaseScope, releaseDay, cell.Label);
            long protectedCount = Math.Max(0, checked((long)Math.Round(cell.Count + noise, MidpointRounding.AwayFromZero)));
            protectedCells.Add(new ReadAggregateCount(cell.Label, protectedCount));
        }

        return protectedCells
            .OrderByDescending(static cell => cell.Count)
            .ThenBy(static cell => cell.Label, StringComparer.Ordinal)
            .ToArray();
    }

    private double SampleDailyLaplaceNoise(string scope, DateOnly day, string label)
    {
        string material = string.Join('|',
            "fsus-read-analytics-dp-v1",
            day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            scope,
            label);
        byte[] digest = HMACSHA256.HashData(_noiseKey, Encoding.UTF8.GetBytes(material));
        ulong random = BinaryPrimitives.ReadUInt64BigEndian(digest);
        double uniform = ((random >> 11) + 0.5d) / (1UL << 53);
        double centered = uniform - 0.5d;
        double scale = 1d / Budget.EpsilonPerRelease;
        return -scale * Math.Sign(centered) * Math.Log(1d - 2d * Math.Abs(centered));
    }

    private static byte[] ReadKey(IConfiguration configuration)
    {
        string raw = configuration[NoiseKeySetting] ?? string.Empty;
        try
        {
            byte[] decoded = Convert.FromBase64String(raw);
            if (decoded.Length >= 32)
            {
                return decoded;
            }
        }
        catch (FormatException)
        {
        }

        throw new InvalidOperationException($"{NoiseKeySetting} must be an independent base64 secret of at least 32 bytes.");
    }

    private static int ReadInt(IConfiguration configuration, string key, int fallback, int min, int max)
    {
        string? raw = configuration[key];
        if (string.IsNullOrWhiteSpace(raw))
        {
            return fallback;
        }

        if (!int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out int value)
            || value < min
            || value > max)
        {
            throw new InvalidOperationException($"{key} must be an integer between {min} and {max}.");
        }

        return value;
    }

    private static double ReadDouble(
        IConfiguration configuration,
        string key,
        double fallback,
        double minExclusive,
        double maxInclusive)
    {
        string? raw = configuration[key];
        if (string.IsNullOrWhiteSpace(raw))
        {
            return fallback;
        }

        if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out double value)
            || !double.IsFinite(value)
            || value <= minExclusive
            || value > maxInclusive)
        {
            throw new InvalidOperationException(
                $"{key} must be greater than {minExclusive.ToString(CultureInfo.InvariantCulture)} and no greater than {maxInclusive.ToString(CultureInfo.InvariantCulture)}.");
        }

        return value;
    }
}
