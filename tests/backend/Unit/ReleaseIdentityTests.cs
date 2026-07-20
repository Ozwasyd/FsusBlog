using System.Text.Json;

using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
namespace FsusBlog.Server.Tests.Unit;

public sealed class ReleaseIdentityTests
{
    private const string ReleaseId = "20260711010101-0123456789ab";
    private const string CreatedAtUtc = "2026-07-11T01:01:01Z";
    private const string CommitSha = "0123456789abcdef0123456789abcdef01234567";
    private static readonly string s_digest = $"sha256:{new string('a', 64)}";

    [Fact]
    public void Provider_ReportsExactNonSensitiveReleaseIdentity()
    {
        var provider = new ReleaseIdentityProvider(CreateConfiguration());

        ProductionReleaseIdentityHealthCheck health = provider.CreateHealthCheck(requireConfigured: true);

        Assert.Equal("ok", health.Status);
        Assert.Equal(ReleaseId, health.ReleaseId);
        Assert.Equal("candidate", health.ReleaseSlot);
        Assert.Equal(CommitSha, health.CommitSha);
        Assert.Equal(s_digest, health.ImageDigest);
        Assert.Equal($"ghcr.io/fsusblog/app@{s_digest}", health.ImageRef);
        Assert.Null(health.Error);
    }

    [Theory]
    [InlineData("FSUSBLOG_RELEASE_ID", "latest")]
    [InlineData("FSUSBLOG_RELEASE_ID", "current")]
    [InlineData("FSUSBLOG_RELEASE_ID", "final-current")]
    [InlineData("FSUSBLOG_RELEASE_ID", "v1.2.0")]
    [InlineData("FSUSBLOG_RELEASE_ID", "20260230010101-0123456789ab")]
    [InlineData("FSUSBLOG_RELEASE_ID", "20260711010101-0123456789AB")]
    [InlineData("FSUSBLOG_RELEASE_ID", "20260711010101-1123456789ab")]
    [InlineData("FSUSBLOG_RELEASE_CREATED_AT_UTC", "2026-07-11T01:01:02Z")]
    [InlineData("FSUSBLOG_RELEASE_CREATED_AT_UTC", "2026-07-11T09:01:01+08:00")]
    [InlineData("FSUSBLOG_RELEASE_SLOT", "Candidate Slot")]
    [InlineData("FSUSBLOG_COMMIT_SHA", "short")]
    [InlineData("FSUSBLOG_IMAGE_DIGEST", "sha256:abc")]
    [InlineData("FSUSBLOG_IMAGE_REF", "ghcr.io/fsusblog/app:latest")]
    [InlineData("FSUSBLOG_IMAGE_REF", "ghcr.io/fsusblog/app:final-current")]
    public void Provider_FailsClosedForInvalidOrMutableIdentity(string key, string value)
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?> { [key] = value });
        var provider = new ReleaseIdentityProvider(configuration);

        ProductionReleaseIdentityHealthCheck health = provider.CreateHealthCheck(requireConfigured: true);

        Assert.Equal("failed", health.Status);
        Assert.Equal("release_identity_invalid", health.Error);
    }

    [Fact]
    public void Provider_AllowsExplicitLocalFallbackOnlyWhenProductionIdentityIsNotRequired()
    {
        var provider = new ReleaseIdentityProvider(new ConfigurationBuilder().Build());

        Assert.Equal("ok", provider.CreateHealthCheck(requireConfigured: false).Status);
        Assert.Equal("failed", provider.CreateHealthCheck(requireConfigured: true).Status);
        Assert.Equal("local-unversioned", provider.Current.ReleaseId);
    }

    [Fact]
    public void Provider_DerivesCanonicalUtcSecondWhenLegacyDeploymentDoesNotInjectCreatedAt()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["FSUSBLOG_RELEASE_CREATED_AT_UTC"] = null
        });

        var provider = new ReleaseIdentityProvider(configuration);

        Assert.Equal("ok", provider.CreateHealthCheck(requireConfigured: true).Status);
        Assert.Equal(DateTimeOffset.Parse(CreatedAtUtc), provider.Current.CreatedAtUtc);
    }

    [Fact]
    public void GeneratedContract_MatchesSharedCrossLanguageFixture()
    {
        using JsonDocument fixture = JsonDocument.Parse(File.ReadAllText(
            BackendTestPaths.FromRoot("tests", "fixtures", "release", "release-id-cases.json")));

        foreach (JsonElement releaseId in fixture.RootElement.GetProperty("valid").EnumerateArray())
        {
            Assert.True(ReleaseIdContract.TryParse(
                releaseId.GetString(),
                out _,
                out _));
        }
        foreach (JsonElement releaseId in fixture.RootElement.GetProperty("invalid").EnumerateArray())
        {
            Assert.False(ReleaseIdContract.TryParse(
                releaseId.GetString(),
                out _,
                out _));
        }

        JsonElement identity = fixture.RootElement.GetProperty("identity");
        JsonElement expected = fixture.RootElement.GetProperty("expectedParsedIdentity");
        Assert.True(ReleaseIdContract.TryParse(
            identity.GetProperty("releaseId").GetString(),
            out DateTimeOffset parsedCreatedAtUtc,
            out string parsedCommitShaPrefix));
        Assert.Equal(DateTimeOffset.Parse(expected.GetProperty("createdAtUtc").GetString()!), parsedCreatedAtUtc);
        Assert.Equal(expected.GetProperty("commitShaPrefix").GetString(), parsedCommitShaPrefix);
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["FSUSBLOG_RELEASE_ID"] = identity.GetProperty("releaseId").GetString(),
            ["FSUSBLOG_COMMIT_SHA"] = identity.GetProperty("commitSha").GetString(),
            ["FSUSBLOG_RELEASE_CREATED_AT_UTC"] = identity.GetProperty("createdAtUtc").GetString()
        });
        Assert.Equal("ok", new ReleaseIdentityProvider(configuration).CreateHealthCheck(requireConfigured: true).Status);
    }

    [Fact]
    public void ReadinessDetailSerialization_ContainsExactReleaseIdentity()
    {
        var provider = new ReleaseIdentityProvider(CreateConfiguration());
        var report = new ProductionHealthReport(
            "ready",
            DateTimeOffset.Parse("2026-07-11T01:01:01Z"),
            new Dictionary<string, object?>
            {
                ["release"] = provider.CreateHealthCheck(requireConfigured: true)
            });

        string json = JsonSerializer.Serialize(report);

        using JsonDocument document = JsonDocument.Parse(json);
        JsonElement release = document.RootElement.GetProperty("Checks").GetProperty("release");
        Assert.Equal(ReleaseId, release.GetProperty("ReleaseId").GetString());
        Assert.Equal("candidate", release.GetProperty("ReleaseSlot").GetString());
        Assert.Equal(CommitSha, release.GetProperty("CommitSha").GetString());
        Assert.Equal($"ghcr.io/fsusblog/app@{s_digest}", release.GetProperty("ImageRef").GetString());
        Assert.Equal(s_digest, release.GetProperty("ImageDigest").GetString());
    }

    [Fact]
    public async Task StartupLogger_ProductionFailsClosedWhenIdentityIsMissing()
    {
        var logger = new CapturingLogger<ReleaseIdentityStartupLogger>();
        var service = new ReleaseIdentityStartupLogger(
            new ReleaseIdentityProvider(new ConfigurationBuilder().Build()),
            new StubAssemblyReleaseIdentityProvider("local-unversioned"),
            new TestWebHostEnvironment(Environments.Production),
            logger);

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => service.StartAsync(CancellationToken.None));

        Assert.Equal("Production release identity is missing or invalid.", error.Message);
        Assert.Empty(logger.Messages);
    }

    [Fact]
    public async Task StartupLogger_ReportsExactNonSensitiveIdentity()
    {
        var logger = new CapturingLogger<ReleaseIdentityStartupLogger>();
        var service = new ReleaseIdentityStartupLogger(
            new ReleaseIdentityProvider(CreateConfiguration()),
            new StubAssemblyReleaseIdentityProvider(ReleaseId),
            new TestWebHostEnvironment(Environments.Production),
            logger);

        await service.StartAsync(CancellationToken.None);

        string message = Assert.Single(logger.Messages);
        Assert.Contains(ReleaseId, message, StringComparison.Ordinal);
        Assert.Contains("candidate", message, StringComparison.Ordinal);
        Assert.Contains(CommitSha, message, StringComparison.Ordinal);
        Assert.Contains($"ghcr.io/fsusblog/app@{s_digest}", message, StringComparison.Ordinal);
        Assert.DoesNotContain("token", message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("secret", message, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("", "release_assembly_identity_missing")]
    [InlineData("local-unversioned", "release_assembly_identity_missing")]
    [InlineData("20260711010102-0123456789ab", "release_assembly_identity_mismatch")]
    [InlineData("v1.2.0", "release_assembly_identity_mismatch")]
    public void StartupLogger_ProductionRejectsMissingOrMismatchedAssemblyIdentity(
        string informationalVersion,
        string expectedError)
    {
        ReleaseIdentitySnapshot snapshot = new ReleaseIdentityProvider(CreateConfiguration()).Current;

        string? error = ReleaseIdentityStartupLogger.ValidateAssemblyInformationalVersion(
            snapshot,
            informationalVersion,
            requireCanonicalIdentity: true);

        Assert.Equal(expectedError, error);
    }

    [Fact]
    public void StartupLogger_DevelopmentAllowsExplicitNonReleaseAssemblyIdentity()
    {
        ReleaseIdentitySnapshot snapshot = new ReleaseIdentityProvider(new ConfigurationBuilder().Build()).Current;

        Assert.Null(ReleaseIdentityStartupLogger.ValidateAssemblyInformationalVersion(
            snapshot,
            "local-unversioned",
            requireCanonicalIdentity: false));
    }

    [Fact]
    public async Task StartupLogger_ProductionFailsClosedForMismatchedAssemblyIdentity()
    {
        var service = new ReleaseIdentityStartupLogger(
            new ReleaseIdentityProvider(CreateConfiguration()),
            new StubAssemblyReleaseIdentityProvider("20260711010102-0123456789ab"),
            new TestWebHostEnvironment(Environments.Production),
            new CapturingLogger<ReleaseIdentityStartupLogger>());

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => service.StartAsync(CancellationToken.None));

        Assert.Equal(
            "Production assembly release identity is invalid: release_assembly_identity_mismatch.",
            error.Message);
    }

    [Fact]
    public void Provider_IgnoresRetiredCommitEnvironmentAliases()
    {
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?>
            {
                ["GITHUB_SHA"] = CommitSha,
                ["FSUSBLOG_COMMIT"] = CommitSha
            }).Build();

        var provider = new ReleaseIdentityProvider(configuration);

        Assert.Equal(new string('0', 40), provider.Current.CommitSha);
        Assert.False(provider.Current.Configured);
    }

    [Fact]
    public void SchemaMigrationHistory_UsesCanonicalProviderReleaseIdWithoutAssemblyFallback()
    {
        var provider = new ReleaseIdentityProvider(CreateConfiguration());

        Assert.Equal(ReleaseId, SchemaMigrationRunner.ResolveAppVersion(provider));
    }

    [Fact]
    public void SchemaMigrationHistory_RejectsInvalidConfiguredProviderIdentity()
    {
        var provider = new ReleaseIdentityProvider(CreateConfiguration(
            new Dictionary<string, string?> { ["FSUSBLOG_RELEASE_ID"] = "v1.2.0" }));

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(
            () => SchemaMigrationRunner.ResolveAppVersion(provider));

        Assert.Equal("Schema migration history requires a valid runtime release identity.", error.Message);
    }

    [Fact]
    public void ReleaseIdentitySnapshot_ExposesOnlyPublicGatewayVerificationFields()
    {
        ReleaseIdentitySnapshot snapshot = new ReleaseIdentityProvider(CreateConfiguration()).Current;
        var headers = new HeaderDictionary();

        ReleaseIdentityResponseHeaders.Apply(headers, snapshot);

        Assert.Equal(ReleaseId, headers["X-Fsus-Release-Id"].ToString());
        Assert.Equal("candidate", headers["X-Fsus-Release-Slot"].ToString());
        Assert.DoesNotContain(headers.Keys, static key => key.Contains("secret", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(headers.Keys, static key => key.Contains("token", StringComparison.OrdinalIgnoreCase));
    }

    private static IConfiguration CreateConfiguration(IReadOnlyDictionary<string, string?>? overrides = null)
    {
        var values = new Dictionary<string, string?>
        {
            ["FSUSBLOG_RELEASE_ID"] = ReleaseId,
            ["FSUSBLOG_RELEASE_CREATED_AT_UTC"] = CreatedAtUtc,
            ["FSUSBLOG_RELEASE_SLOT"] = "candidate",
            ["FSUSBLOG_COMMIT_SHA"] = CommitSha,
            ["FSUSBLOG_IMAGE_DIGEST"] = s_digest,
            ["FSUSBLOG_IMAGE_REF"] = $"ghcr.io/fsusblog/app@{s_digest}"
        };
        if (overrides is not null)
        {
            foreach ((string key, string? value) in overrides)
                values[key] = value;
        }
        return new ConfigurationBuilder().AddInMemoryCollection(values).Build();
    }

    private sealed class TestWebHostEnvironment(string environmentName) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "FsusBlog.Server";
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.GetTempPath();
        public string EnvironmentName { get; set; } = environmentName;
        public string ContentRootPath { get; set; } = Path.GetTempPath();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private sealed class StubAssemblyReleaseIdentityProvider(string informationalVersion)
        : IAssemblyReleaseIdentityProvider
    {
        public string InformationalVersion => informationalVersion;
    }

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<string> Messages { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
            => Messages.Add(formatter(state, exception));
    }
}
