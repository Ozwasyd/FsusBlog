using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

using Microsoft.Extensions.DependencyInjection.Extensions;

namespace FsusBlog.Server.Infrastructure.Testing;

public sealed class TestTemporalRuntimeContext
{
    public const string EnvironmentVariable = "FSUSBLOG_TEMPORAL_CONTEXT_JSON";

    private TestTemporalRuntimeContext(
        string canonicalJson,
        DateTimeOffset businessEpochUtc,
        string timezone,
        string locale,
        string uiLocale,
        string backendCulture,
        string postgresTimezone,
        string nodeTimezone,
        string calendar,
        string firstDayOfWeek)
    {
        CanonicalJson = canonicalJson;
        BusinessEpochUtc = businessEpochUtc;
        Timezone = timezone;
        Locale = locale;
        UiLocale = uiLocale;
        BackendCulture = backendCulture;
        PostgresTimezone = postgresTimezone;
        NodeTimezone = nodeTimezone;
        Calendar = calendar;
        FirstDayOfWeek = firstDayOfWeek;
    }

    public string CanonicalJson
    {
        get;
    }
    public DateTimeOffset BusinessEpochUtc
    {
        get;
    }
    public string Timezone
    {
        get;
    }
    public string Locale
    {
        get;
    }
    public string UiLocale
    {
        get;
    }
    public string BackendCulture
    {
        get;
    }
    public string PostgresTimezone
    {
        get;
    }
    public string NodeTimezone
    {
        get;
    }
    public string Calendar
    {
        get;
    }
    public string FirstDayOfWeek
    {
        get;
    }

    public string PostgresSessionOptions =>
        FormattableString.Invariant(
            $"-c timezone={PostgresTimezone} -c fsusblog.test_business_epoch_utc={BusinessEpochUtc:O}");

    public object Observe(string postgresTimezone, string postgresBusinessEpochUtc)
    {
        if (!DateTimeOffset.TryParse(
                postgresBusinessEpochUtc,
                CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind,
                out DateTimeOffset observedEpoch)
            || observedEpoch.Offset != TimeSpan.Zero)
        {
            throw new InvalidOperationException(
                "PostgreSQL business epoch observation is not an RFC3339 UTC instant");
        }
        return new
        {
            businessEpochUtc = observedEpoch.ToString(
                "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                CultureInfo.InvariantCulture),
            backendCulture = CultureInfo.CurrentCulture.Equals(CultureInfo.InvariantCulture)
                && CultureInfo.CurrentUICulture.Equals(CultureInfo.InvariantCulture)
                ? "Invariant"
                : CultureInfo.CurrentCulture.Name,
            postgresTimezone,
            observationBoundary = "backend-and-postgres-session"
        };
    }

    public void RequireExactRequest(JsonElement requestContext)
    {
        JsonObject expected = ParseContextObject(CanonicalJson);
        JsonObject actual = ParseContextObject(requestContext.GetRawText());
        RequireProducerId(expected);
        RequireProducerId(actual);
        expected.Remove("producerId");
        actual.Remove("producerId");
        if (!JsonNode.DeepEquals(expected, actual))
        {
            throw new InvalidOperationException(
                "backend temporal runtime fields do not exact-match the producer request");
        }
    }

    public static TestTemporalRuntimeContext? LoadOptional()
    {
        string? raw = Environment.GetEnvironmentVariable(EnvironmentVariable);
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        using JsonDocument document = JsonDocument.Parse(raw);
        JsonElement root = document.RootElement;
        Require(root.GetProperty("schema").GetString(), "fsusblog.test-temporal-context.v1", "schema");
        Require(root.GetProperty("businessClockMode").GetString(), "fixed", "businessClockMode");
        Require(root.GetProperty("businessClockStepPolicy").GetString(), "explicit-only", "businessClockStepPolicy");
        Require(root.GetProperty("backendCulture").GetString(), "Invariant", "backendCulture");
        Require(root.GetProperty("postgresTimezone").GetString(), "UTC", "postgresTimezone");
        Require(root.GetProperty("nodeTimezone").GetString(), "UTC", "nodeTimezone");
        _ = Required(root, "producerId");

        string epochRaw = root.GetProperty("businessEpochUtc").GetString()
            ?? throw new InvalidOperationException("businessEpochUtc is required");
        if (!DateTimeOffset.TryParse(
                epochRaw,
                CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind,
                out DateTimeOffset epoch)
            || epoch.Offset != TimeSpan.Zero)
        {
            throw new InvalidOperationException("businessEpochUtc must be an RFC3339 UTC instant");
        }

        return new TestTemporalRuntimeContext(
            JsonSerializer.Serialize(root),
            epoch,
            Required(root, "timezone"),
            Required(root, "locale"),
            Required(root, "uiLocale"),
            Required(root, "backendCulture"),
            Required(root, "postgresTimezone"),
            Required(root, "nodeTimezone"),
            Required(root, "calendar"),
            Required(root, "firstDayOfWeek"));
    }

    public static void Configure(WebApplicationBuilder builder)
    {
        TestTemporalRuntimeContext? context = LoadOptional();
        if (context is null)
        {
            return;
        }
        if (!builder.Environment.IsDevelopment() && !builder.Environment.IsEnvironment("Test"))
        {
            throw new InvalidOperationException(
                "test temporal context is accepted only in Development or Test");
        }

        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
        CultureInfo.DefaultThreadCurrentUICulture = CultureInfo.InvariantCulture;
        builder.Services.RemoveAll<TimeProvider>();
        builder.Services.AddSingleton<TimeProvider>(new FixedBusinessTimeProvider(context.BusinessEpochUtc));
        builder.Services.AddSingleton(context);
    }

    private static string Required(JsonElement root, string property)
        => root.GetProperty(property).GetString()
            ?? throw new InvalidOperationException($"{property} is required");

    private static JsonObject ParseContextObject(string raw)
        => JsonNode.Parse(raw) as JsonObject
            ?? throw new InvalidOperationException(
                "temporal context must be a JSON object");

    private static void RequireProducerId(JsonObject context)
    {
        string? producerId = context["producerId"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(producerId))
        {
            throw new InvalidOperationException("producerId is required");
        }
    }

    private static void Require(string? actual, string expected, string property)
    {
        if (!string.Equals(actual, expected, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"{property} must be {expected}");
        }
    }

    private sealed class FixedBusinessTimeProvider(DateTimeOffset businessEpochUtc) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => businessEpochUtc;
    }
}
