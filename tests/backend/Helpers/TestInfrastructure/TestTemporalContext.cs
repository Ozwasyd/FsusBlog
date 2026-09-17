using System.Globalization;
using System.Text.Json;

using Microsoft.Extensions.DependencyInjection.Extensions;

namespace FsusBlog.Server.Tests.TestInfrastructure;

/// <summary>
/// Canonical business-time ingress for correctness tests.
/// Measurement code must continue to use Stopwatch/TimeProvider timestamps.
/// </summary>
public sealed class TestTemporalContext
{
    public const string BusinessEpochEnvironmentVariable = "FSUSBLOG_TEST_BUSINESS_EPOCH_UTC";
    public const string BackendCultureEnvironmentVariable = "FSUSBLOG_TEST_BACKEND_CULTURE";
    public const string PostgresTimezoneEnvironmentVariable = "FSUSBLOG_TEST_POSTGRES_TIMEZONE";
    public const string NodeTimezoneEnvironmentVariable = "FSUSBLOG_TEST_NODE_TIMEZONE";
    public const string TemporalContextEnvironmentVariable = "FSUSBLOG_TEMPORAL_CONTEXT_JSON";
    /// <summary>
    /// Policy token matching config/testing/temporal-policy.json backendCulture.
    /// Maps to <see cref="CultureInfo.InvariantCulture"/> at runtime.
    /// </summary>
    public const string CanonicalBackendCulture = "Invariant";
    public const string CanonicalPostgresTimezone = "UTC";
    public const string CanonicalNodeTimezone = "UTC";
    public const string CanonicalTimezone = "UTC";

    public static readonly DateTimeOffset CanonicalBusinessEpochUtc =
        DateTimeOffset.ParseExact(
            "2024-02-29T23:59:59.0000000+00:00",
            "O",
            CultureInfo.InvariantCulture,
            DateTimeStyles.RoundtripKind);

    public TestTemporalContext(DateTimeOffset businessEpochUtc)
    {
        if (businessEpochUtc.Offset != TimeSpan.Zero)
        {
            throw new ArgumentException("The test business epoch must have a UTC offset.", nameof(businessEpochUtc));
        }

        BusinessClock = new TestBusinessTimeProvider(businessEpochUtc);
    }

    public TestBusinessTimeProvider BusinessClock
    {
        get; private set;
    }

    public DateTimeOffset BusinessEpochUtc => BusinessClock.GetUtcNow();

    public CultureInfo BackendCulture => CultureInfo.InvariantCulture;

    public string BackendCultureToken => CanonicalBackendCulture;

    public string PostgresTimezone => CanonicalPostgresTimezone;

    public string NodeTimezone => CanonicalNodeTimezone;

    public string Timezone => CanonicalTimezone;

    public string PostgresSessionOptions =>
        $"-c timezone={PostgresTimezone} -c fsusblog.test_business_epoch_utc={BusinessEpochUtc:O}";

    public static TestTemporalContext CreateCanonical()
        => new(CanonicalBusinessEpochUtc);

    public static TestTemporalContext FromEnvironment()
    {
        string? contextRaw = Environment.GetEnvironmentVariable(
            TemporalContextEnvironmentVariable);
        using JsonDocument? document = string.IsNullOrWhiteSpace(contextRaw)
            ? null
            : JsonDocument.Parse(contextRaw);
        JsonElement? root = document?.RootElement;
        if (root is JsonElement context)
        {
            RequireJsonValue(context, "schema", "fsusblog.test-temporal-context.v1");
            RequireJsonValue(context, "businessClockMode", "fixed");
            RequireJsonValue(context, "businessClockStepPolicy", "explicit-only");
            RequireJsonValue(context, "backendCulture", CanonicalBackendCulture);
            RequireJsonValue(context, "postgresTimezone", CanonicalPostgresTimezone);
            RequireJsonValue(context, "nodeTimezone", CanonicalNodeTimezone);
            RequireJsonValue(context, "timezone", CanonicalTimezone);
        }
        string? epochRaw = root?.GetProperty("businessEpochUtc").GetString()
            ?? Environment.GetEnvironmentVariable(BusinessEpochEnvironmentVariable);
        DateTimeOffset epoch = string.IsNullOrWhiteSpace(epochRaw)
            ? CanonicalBusinessEpochUtc
            : ParseUtcEpoch(epochRaw);
        RequireCanonicalValue(
            BackendCultureEnvironmentVariable,
            CanonicalBackendCulture,
            allowMissing: true);
        RequireCanonicalValue(
            PostgresTimezoneEnvironmentVariable,
            CanonicalPostgresTimezone,
            allowMissing: true);
        RequireCanonicalValue(
            NodeTimezoneEnvironmentVariable,
            CanonicalNodeTimezone,
            allowMissing: true);
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
        CultureInfo.DefaultThreadCurrentUICulture = CultureInfo.InvariantCulture;
        CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
        CultureInfo.CurrentUICulture = CultureInfo.InvariantCulture;
        return new TestTemporalContext(epoch);
    }

    public void ConfigureServices(IServiceCollection services)
    {
        CultureInfo.DefaultThreadCurrentCulture = BackendCulture;
        CultureInfo.DefaultThreadCurrentUICulture = BackendCulture;
        services.RemoveAll<TimeProvider>();
        services.RemoveAll<TestTemporalContext>();
        services.AddSingleton(this);
        services.AddSingleton<TimeProvider>(BusinessClock);
    }

    public void AssertRuntimeContext()
    {
        if (!Equals(CultureInfo.CurrentCulture, BackendCulture)
            || !Equals(CultureInfo.CurrentUICulture, BackendCulture))
        {
            throw new InvalidOperationException("Backend runtime culture does not match the temporal context.");
        }
    }

    public void Advance(TimeSpan delta) => BusinessClock.Advance(delta);

    private static DateTimeOffset ParseUtcEpoch(string raw)
    {
        if (!DateTimeOffset.TryParseExact(
                raw,
                ["yyyy-MM-dd'T'HH:mm:ss.fff'Z'", "O"],
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out DateTimeOffset parsed)
            || parsed.Offset != TimeSpan.Zero)
        {
            throw new InvalidOperationException(
                $"{BusinessEpochEnvironmentVariable} must be an exact UTC RFC3339 round-trip timestamp.");
        }

        return parsed;
    }

    private static void RequireCanonicalValue(
        string environmentVariable,
        string expected,
        bool allowMissing)
    {
        string? actual = Environment.GetEnvironmentVariable(environmentVariable);
        if (allowMissing && actual is null)
        {
            return;
        }

        if (!string.Equals(actual, expected, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"{environmentVariable} must be {expected} for correctness tests.");
        }
    }

    private static void RequireJsonValue(
        JsonElement context,
        string property,
        string expected)
    {
        string? actual = context.GetProperty(property).GetString();
        if (!string.Equals(actual, expected, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"{TemporalContextEnvironmentVariable}.{property} must be {expected}.");
        }
    }
}

public sealed class TestBusinessTimeProvider(DateTimeOffset initialUtcNow) : TimeProvider
{
    private readonly object _gate = new();
    private DateTimeOffset _utcNow = RequireUtc(initialUtcNow);

    public override DateTimeOffset GetUtcNow()
    {
        lock (_gate)
        {
            return _utcNow;
        }
    }

    public void Advance(TimeSpan delta)
    {
        if (delta < TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(delta), "Business time cannot move backwards.");
        }

        lock (_gate)
        {
            _utcNow += delta;
        }
    }

    private static DateTimeOffset RequireUtc(DateTimeOffset value)
        => value.Offset == TimeSpan.Zero
            ? value
            : throw new ArgumentException("Business time must use a UTC offset.", nameof(value));
}
