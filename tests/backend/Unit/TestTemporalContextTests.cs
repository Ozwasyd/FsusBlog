using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Server.Tests.Fixtures;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.DependencyInjection;

using RuntimeTemporalContext = FsusBlog.Server.Infrastructure.Testing.TestTemporalRuntimeContext;

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
        context.AssertRuntimeContext();
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

    [Fact]
    public void FromEnvironment_ParsesFullTemporalContextAndRejectsBackendMismatch()
    {
        string? previous = Environment.GetEnvironmentVariable(
            TestTemporalContext.TemporalContextEnvironmentVariable);
        try
        {
            const string Context =
                """
                {
                  "schema": "fsusblog.test-temporal-context.v1",
                  "businessEpochUtc": "2024-02-29T23:59:59.000Z",
                  "businessClockMode": "fixed",
                  "businessClockStepPolicy": "explicit-only",
                  "timezone": "UTC",
                  "backendCulture": "Invariant",
                  "postgresTimezone": "UTC",
                  "nodeTimezone": "UTC"
                }
                """;
            Environment.SetEnvironmentVariable(
                TestTemporalContext.TemporalContextEnvironmentVariable,
                Context);
            Assert.Equal(
                TestTemporalContext.CanonicalBusinessEpochUtc,
                TestTemporalContext.FromEnvironment().BusinessEpochUtc);

            Environment.SetEnvironmentVariable(
                TestTemporalContext.TemporalContextEnvironmentVariable,
                Context.Replace(
                    "\"backendCulture\": \"Invariant\"",
                    "\"backendCulture\": \"zh-CN\"",
                    StringComparison.Ordinal));
            Assert.Throws<InvalidOperationException>(
                TestTemporalContext.FromEnvironment);
        }
        finally
        {
            Environment.SetEnvironmentVariable(
                TestTemporalContext.TemporalContextEnvironmentVariable,
                previous);
        }
    }

    [Fact]
    public void RuntimeObservation_UsesActualBackendClockAfterCheckingDatabaseEpoch()
    {
        WithRuntimeTemporalContext(runtime =>
        {
            TestTemporalContext actual = TestTemporalContext.CreateCanonical();
            JsonElement observed = JsonSerializer.SerializeToElement(runtime.Observe(
                "UTC",
                "2024-02-29T23:59:59.000Z",
                actual.BusinessClock));

            Assert.Equal("2024-02-29T23:59:59.000Z", observed.GetProperty("businessEpochUtc").GetString());
            Assert.Equal("Invariant", observed.GetProperty("backendCulture").GetString());
            Assert.Equal("UTC", observed.GetProperty("postgresTimezone").GetString());

            actual.Advance(TimeSpan.FromSeconds(1));
            InvalidOperationException mismatch = Assert.Throws<InvalidOperationException>(() =>
                runtime.Observe("UTC", "2024-02-29T23:59:59.000Z", actual.BusinessClock));
            Assert.Contains("backend business epoch observation", mismatch.Message, StringComparison.Ordinal);
        });
    }

    [Theory]
    [InlineData("", "UTC", "Invariant", "Invariant", "not an RFC3339 UTC instant")]
    [InlineData("2024-03-01T00:00:00.000Z", "UTC", "Invariant", "Invariant", "PostgreSQL business epoch observation")]
    [InlineData("2024-02-29T23:59:59.000Z", "Asia/Shanghai", "Invariant", "Invariant", "PostgreSQL timezone observation")]
    [InlineData("2024-02-29T23:59:59.000Z", "UTC", "zh-CN", "Invariant", "backend culture observation")]
    [InlineData("2024-02-29T23:59:59.000Z", "UTC", "Invariant", "ja-JP", "backend culture observation")]
    public void RuntimeObservation_RejectsMissingOrDriftingActualSettings(
        string postgresEpoch,
        string postgresTimezone,
        string culture,
        string uiCulture,
        string expectedFailure)
    {
        WithRuntimeTemporalContext(runtime =>
        {
            CultureInfo.CurrentCulture = culture == "Invariant"
                ? CultureInfo.InvariantCulture
                : CultureInfo.GetCultureInfo(culture);
            CultureInfo.CurrentUICulture = uiCulture == "Invariant"
                ? CultureInfo.InvariantCulture
                : CultureInfo.GetCultureInfo(uiCulture);
            InvalidOperationException mismatch = Assert.Throws<InvalidOperationException>(() =>
                runtime.Observe(
                    postgresTimezone,
                    postgresEpoch,
                    TestTemporalContext.CreateCanonical().BusinessClock));
            Assert.Contains(expectedFailure, mismatch.Message, StringComparison.Ordinal);
        });
    }

    [Fact]
    public void RuntimeContext_RequiresExactSharedFieldsAndExplicitProducerIdentity()
    {
        const string Context =
            """
            {
              "schema": "fsusblog.test-temporal-context.v1",
              "sourceCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "sourceFingerprint": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "producerId": "comment-moderation",
              "schedulerRunId": "runtime-context-test",
              "businessEpochUtc": "2024-02-29T23:59:59.000Z",
              "businessClockMode": "fixed",
              "businessClockStepPolicy": "explicit-only",
              "timezone": "UTC",
              "locale": "en-US",
              "uiLocale": "en-US",
              "backendCulture": "Invariant",
              "postgresTimezone": "UTC",
              "nodeTimezone": "UTC",
              "calendar": "gregory",
              "firstDayOfWeek": "monday",
              "monotonicClockSource": "performance-now",
              "timeoutPolicyDigest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
              "temporalPolicyDigest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
              "ledgerSource": {
                "authorityKind": "immutable-ledger",
                "path": "config/testing/temporal-callsite-dispositions.json",
                "digest": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
              }
            }
            """;

        ScopedEnvironmentVariables.Run(
            [RuntimeTemporalContext.EnvironmentVariable],
            environment =>
            {
                environment.Set(RuntimeTemporalContext.EnvironmentVariable, Context);
                RuntimeTemporalContext runtime =
                    Assert.IsType<RuntimeTemporalContext>(
                        RuntimeTemporalContext.LoadOptional());
                var request = Assert.IsType<JsonObject>(JsonNode.Parse(Context));
                request["producerId"] = "public-content";
                runtime.RequireExactRequest(
                    JsonNode.Parse(request.ToJsonString())!.AsObject()
                        .Deserialize<JsonElement>());

                request["businessEpochUtc"] = "2030-01-01T00:00:00.000Z";
                Assert.Throws<InvalidOperationException>(() =>
                    runtime.RequireExactRequest(
                        JsonNode.Parse(request.ToJsonString())!.AsObject()
                            .Deserialize<JsonElement>()));

                request["businessEpochUtc"] = "2024-02-29T23:59:59.000Z";
                request.Remove("producerId");
                Assert.Throws<InvalidOperationException>(() =>
                    runtime.RequireExactRequest(
                        JsonNode.Parse(request.ToJsonString())!.AsObject()
                            .Deserialize<JsonElement>()));
            });
    }

    private static void WithRuntimeTemporalContext(Action<RuntimeTemporalContext> assertion)
    {
        const string Context =
            """
            {
              "schema": "fsusblog.test-temporal-context.v1",
              "producerId": "public-content",
              "businessEpochUtc": "2024-02-29T23:59:59.000Z",
              "businessClockMode": "fixed",
              "businessClockStepPolicy": "explicit-only",
              "timezone": "UTC",
              "locale": "en-US",
              "uiLocale": "en-US",
              "backendCulture": "Invariant",
              "postgresTimezone": "UTC",
              "nodeTimezone": "UTC",
              "calendar": "gregory",
              "firstDayOfWeek": "monday"
            }
            """;
        CultureInfo previousCulture = CultureInfo.CurrentCulture;
        CultureInfo previousUiCulture = CultureInfo.CurrentUICulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
            CultureInfo.CurrentUICulture = CultureInfo.InvariantCulture;
            ScopedEnvironmentVariables.Run(
                [RuntimeTemporalContext.EnvironmentVariable],
                environment =>
                {
                    environment.Set(RuntimeTemporalContext.EnvironmentVariable, Context);
                    assertion(Assert.IsType<RuntimeTemporalContext>(RuntimeTemporalContext.LoadOptional()));
                });
        }
        finally
        {
            CultureInfo.CurrentCulture = previousCulture;
            CultureInfo.CurrentUICulture = previousUiCulture;
        }
    }
}
