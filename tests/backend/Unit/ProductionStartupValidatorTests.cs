using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services.Security;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using System.Net;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed class ProductionStartupValidatorTests
{
    [Fact]
    public void ValidateCore_AcceptsProductionConfigurationWithHttpsAndRedisPassword()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = "Host=db;Database=fsus;Username=fsus;Password=secret",
            ["ConnectionStrings:Redis"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["RedisOptions:Configuration"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["Jwt:SecretKey"] = "production-secret-key-with-at-least-thirty-two-chars",
            ["AllowedHosts"] = "fsus.blog;www.fsus.blog",
            ["CORS_ALLOWED_HOSTS"] = "https://fsus.blog,https://www.fsus.blog",
            ["Seo:BaseUrl"] = "https://fsus.blog",
            ["Fido2:ServerDomain"] = "fsus.blog",
            ["Fido2:Origins:0"] = "https://fsus.blog",
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = "production-subject-hash-pepper-with-at-least-thirty-two-chars",
            ["ReverseProxy:KnownProxies"] = "127.0.0.1",
            [AnonymousIdentityRuntime.ModeEnvironmentVariable] = "1"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Empty(errors);
    }

    [Fact]
    public void ValidateCore_RejectsProductionDefaultsAndInsecureOrigins()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = "Host=db;Database=fsus;Username=fsus;Password=secret",
            ["ConnectionStrings:Redis"] = "redis:6379,abortConnect=false",
            ["RedisOptions:Configuration"] = "redis:6379,password=,abortConnect=false",
            ["Jwt:SecretKey"] = "Were_I_you_I_would_get_high_like_some_airplanes",
            ["AllowedHosts"] = "*",
            ["CORS_ALLOWED_HOSTS"] = "http://fsus.blog",
            ["Seo:BaseUrl"] = "http://fsus.blog",
            ["Fido2:ServerDomain"] = "localhost",
            ["Fido2:Origins:0"] = "http://fsus.blog",
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = "MUST_BE_OVERRIDDEN_BY_ENV_VARIABLES"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("Jwt:SecretKey", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("ConnectionStrings:Redis", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("RedisOptions:Configuration", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("AllowedHosts", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("ReverseProxy", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("CORS_ALLOWED_HOSTS", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Seo:BaseUrl", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Fido2:ServerDomain", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Fido2:Origins", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("AnonymousCredentialIssuer:SubjectHashPepper", StringComparison.Ordinal));
    }

    [Fact]
    public void SharedAppsettings_DoesNotContainReusableJwtSecret()
    {
        string appsettings = BackendTestPaths.ReadAllTextFromRoot("src/backend/appsettings.json");

        Assert.DoesNotContain("Were_I_you_I_would_get_high_like_some_airplanes", appsettings, StringComparison.Ordinal);
        Assert.DoesNotContain("\"SecretKey\": \"Local_Release_Smoke_Key_For_FsusBlog_2026_Only\"", appsettings, StringComparison.Ordinal);
    }

    [Fact]
    public async Task HostedService_DoesNotBypassDefaultJwtSecretEvenWhenInsecureStartupAllowed()
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            ["Jwt:SecretKey"] = "Were_I_you_I_would_get_high_like_some_airplanes",
            ["FSUSBLOG_ALLOW_INSECURE_STARTUP"] = "true"
        });
        var runtimeState = new StartupRuntimeState();
        var service = new ProductionStartupValidationHostedService(
            configuration,
            new TestWebHostEnvironment(Environments.Production),
            new StaticZkProofVerifier(configured: false),
            new StaticRootReader(rootReady: false),
            new UnavailableCircuitNativeCredentialIssuer(configuration),
            runtimeState,
            NullLogger<ProductionStartupValidationHostedService>.Instance);

        ProductionStartupValidationException ex = await Assert.ThrowsAsync<ProductionStartupValidationException>(
            () => service.StartAsync(CancellationToken.None));

        Assert.Contains(ex.Errors, static error => error.Contains("Jwt:SecretKey", StringComparison.Ordinal));
        StartupLifecycleTaskReport task = runtimeState.CreateSnapshot().Tasks["productionStartupValidation"];
        Assert.Equal("failed", task.Status);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("0")]
    [InlineData("false")]
    public void ValidateCore_RejectsProductionWhenAnonymousIdentityModeIsMissingOrDisabled(string? modeValue)
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            [AnonymousIdentityRuntime.ModeEnvironmentVariable] = modeValue
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(
            errors,
            static error => error.Contains(AnonymousIdentityRuntime.ModeEnvironmentVariable, StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("1")]
    [InlineData("true")]
    [InlineData("enabled")]
    public void ValidateCore_AcceptsProductionWhenAnonymousIdentityModeIsEnabled(string modeValue)
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            [AnonymousIdentityRuntime.ModeEnvironmentVariable] = modeValue
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.DoesNotContain(
            errors,
            static error => error.Contains(AnonymousIdentityRuntime.ModeEnvironmentVariable, StringComparison.Ordinal));
    }

    [Fact]
    public void ValidateCore_RejectsProductionInsecureAuthCookies()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = "Host=db;Database=fsus;Username=fsus;Password=secret",
            ["ConnectionStrings:Redis"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["RedisOptions:Configuration"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["Jwt:SecretKey"] = "production-secret-key-with-at-least-thirty-two-chars",
            ["AllowedHosts"] = "fsus.blog",
            ["CORS_ALLOWED_HOSTS"] = "https://fsus.blog",
            ["Seo:BaseUrl"] = "https://fsus.blog",
            ["Fido2:ServerDomain"] = "fsus.blog",
            ["Fido2:Origins:0"] = "https://fsus.blog",
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = "production-subject-hash-pepper-with-at-least-thirty-two-chars",
            ["ReverseProxy:KnownProxies"] = "127.0.0.1",
            ["AuthCookies:AllowInsecureTransportCookies"] = "true"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("AuthCookies:AllowInsecureTransportCookies", StringComparison.Ordinal));
    }

    [Fact]
    public void ValidateCore_RejectsProductionLegacyPlainCookieRead()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = "Host=db;Database=fsus;Username=fsus;Password=secret",
            ["ConnectionStrings:Redis"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["RedisOptions:Configuration"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["Jwt:SecretKey"] = "production-secret-key-with-at-least-thirty-two-chars",
            ["AllowedHosts"] = "fsus.blog",
            ["CORS_ALLOWED_HOSTS"] = "https://fsus.blog",
            ["Seo:BaseUrl"] = "https://fsus.blog",
            ["Fido2:ServerDomain"] = "fsus.blog",
            ["Fido2:Origins:0"] = "https://fsus.blog",
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = "production-subject-hash-pepper-with-at-least-thirty-two-chars",
            ["ReverseProxy:KnownProxies"] = "127.0.0.1",
            ["AuthCookies:AllowLegacyPlainCookieRead"] = "true"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("AuthCookies:AllowLegacyPlainCookieRead", StringComparison.Ordinal));
    }

    [Fact]
    public void ValidateCore_RejectsMissingRequiredProductionSettings()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>());

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("ConnectionStrings:DefaultConnection", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("ConnectionStrings:Redis", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("RedisOptions:Configuration", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Jwt:SecretKey", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("AllowedHosts", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("ReverseProxy", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("CORS_ALLOWED_HOSTS", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Seo:BaseUrl", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Fido2:ServerDomain", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Fido2:Origins", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("AnonymousCredentialIssuer:SubjectHashPepper", StringComparison.Ordinal));
    }

    [Fact]
    public void ValidateCore_AllowsDevelopmentConfigurationToUseLocalDefaults()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>());

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: false);

        Assert.DoesNotContain(errors, static error => error.Contains("Seo:BaseUrl", StringComparison.Ordinal));
    }

    [Fact]
    public void CreateValidationReport_ExposesVersionedSchemaRequirements()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>());

        ProductionStartupValidationReport report = ProductionStartupValidator.CreateValidationReport(
            configuration,
            enforceProductionRules: true);

        Assert.Equal(6, report.SchemaVersion);
        Assert.Equal(ProductionStartupValidator.CurrentSchema.Version, report.SchemaVersion);
        Assert.Equal(
            ProductionStartupValidator.CurrentSchema.RequiredSettings.Order(StringComparer.Ordinal),
            report.Requirements.Select(static requirement => requirement.Key).Order(StringComparer.Ordinal));
        Assert.Contains(AnonymousIdentityRuntime.ModeEnvironmentVariable, ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Jwt:SecretKey", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("AllowedHosts", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Fido2:ServerDomain", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Fido2:Origins", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("AnonymousCredentialIssuer:SubjectHashPepper", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains(
            "MUST_BE_OVERRIDDEN_BY_ENV_VARIABLES",
            ProductionStartupValidator.CurrentSchema.DefaultJwtSecrets);
    }

    [Fact]
    public void ValidateCore_RejectsFido2OriginsThatDoNotMatchTrustedProductionOrigins()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = "Host=db;Database=fsus;Username=fsus;Password=secret",
            ["ConnectionStrings:Redis"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["RedisOptions:Configuration"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["Jwt:SecretKey"] = "production-secret-key-with-at-least-thirty-two-chars",
            ["AllowedHosts"] = "fsus.blog",
            ["CORS_ALLOWED_HOSTS"] = "https://fsus.blog",
            ["Seo:BaseUrl"] = "https://fsus.blog",
            ["Fido2:ServerDomain"] = "login.fsus.blog",
            ["Fido2:Origins:0"] = "https://evil.example",
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = "production-subject-hash-pepper-with-at-least-thirty-two-chars",
            ["ReverseProxy:KnownProxies"] = "127.0.0.1"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("Fido2:ServerDomain", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("AllowedHosts", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Fido2:Origins must include Seo:BaseUrl", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Fido2:Origins origin must also be listed", StringComparison.Ordinal));
    }

    [Fact]
    public void ValidateCore_RejectsAllowedHostsThatDoNotCoverTrustedProductionOrigins()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = "Host=db;Database=fsus;Username=fsus;Password=secret",
            ["ConnectionStrings:Redis"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["RedisOptions:Configuration"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["Jwt:SecretKey"] = "production-secret-key-with-at-least-thirty-two-chars",
            ["AllowedHosts"] = "fsus.blog",
            ["CORS_ALLOWED_HOSTS"] = "https://fsus.blog,https://www.fsus.blog",
            ["Seo:BaseUrl"] = "https://fsus.blog",
            ["Fido2:ServerDomain"] = "fsus.blog",
            ["Fido2:Origins:0"] = "https://www.fsus.blog",
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = "production-subject-hash-pepper-with-at-least-thirty-two-chars",
            ["ReverseProxy:KnownProxies"] = "127.0.0.1"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("CORS_ALLOWED_HOSTS host must be listed in AllowedHosts", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Fido2:Origins host must be listed in AllowedHosts", StringComparison.Ordinal));
    }

    [Fact]
    public void ValidateCore_RejectsUnsafeReverseProxyTrustEntries()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = "Host=db;Database=fsus;Username=fsus;Password=secret",
            ["ConnectionStrings:Redis"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["RedisOptions:Configuration"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["Jwt:SecretKey"] = "production-secret-key-with-at-least-thirty-two-chars",
            ["AllowedHosts"] = "fsus.blog",
            ["CORS_ALLOWED_HOSTS"] = "https://fsus.blog",
            ["Seo:BaseUrl"] = "https://fsus.blog",
            ["Fido2:ServerDomain"] = "fsus.blog",
            ["Fido2:Origins:0"] = "https://fsus.blog",
            ["ReverseProxy:KnownProxies"] = "0.0.0.0",
            ["ReverseProxy:KnownNetworks"] = "0.0.0.0/0"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("ReverseProxy:KnownProxies", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("ReverseProxy:KnownNetworks", StringComparison.Ordinal));
    }

    [Fact]
    public void ReverseProxyForwardedHeaders_ConfiguresExplicitTrustedProxiesAndNetworks()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["ReverseProxy:KnownProxies"] = "127.0.0.1,::1",
            ["ReverseProxy:KnownNetworks"] = "10.0.0.0/8;172.16.0.0/12"
        });
        ForwardedHeadersOptions options = new();

        ReverseProxyForwardedHeaders.Configure(options, configuration, isProduction: true);

        Assert.Contains(IPAddress.Loopback, options.KnownProxies);
        Assert.Contains(IPAddress.IPv6Loopback, options.KnownProxies);
        Assert.Equal(2, options.KnownIPNetworks.Count);
    }

    [Theory]
    [InlineData("AnonymousIdentity:ZkProd:AllowDevVerifier")]
    [InlineData("AnonymousIdentity:ZkProd:FallbackToLegacyAnonymous")]
    public void ValidateCore_RejectsProductionZkProdUnsafeBypassFlagsEvenWhenZkProdDisabled(string key)
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            [key] = "true"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true,
            new ZkProdRuntimeReadiness(
                NativeVerifierConfigured: false,
                CredentialRootReady: false));

        Assert.Contains(errors, error => error.Contains(key, StringComparison.Ordinal));
    }

    [Fact]
    public void ValidateCore_RejectsProductionZkProdEnabledWithoutNativeVerifier()
    {
        IConfiguration configuration = CreateZkProdProductionConfiguration([]);

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true,
            new ZkProdRuntimeReadiness(
                NativeVerifierConfigured: false,
                CredentialRootReady: true));

        Assert.Contains(errors, static error => error.Contains("native verifier", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void ValidateCore_RejectsProductionZkProdEnabledWithoutTrustedSetupVerification()
    {
        IConfiguration configuration = CreateZkProdProductionConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:ZkProd:TrustedSetupVerified"] = "false"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true,
            new ZkProdRuntimeReadiness(
                NativeVerifierConfigured: true,
                CredentialRootReady: true));

        Assert.Contains(errors, static error => error.Contains("trusted setup", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void ValidateCore_RejectsProductionZkProdEnabledWithoutCredentialRootReadiness()
    {
        IConfiguration configuration = CreateZkProdProductionConfiguration([]);

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true,
            new ZkProdRuntimeReadiness(
                NativeVerifierConfigured: true,
                CredentialRootReady: false));

        Assert.Contains(errors, static error => error.Contains("credential root", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void ValidateCore_RejectsProductionZkProdEnabledWithoutCredentialReadiness()
    {
        IConfiguration configuration = CreateZkProdProductionConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:ZkProd:CredentialReady"] = "false"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true,
            new ZkProdRuntimeReadiness(
                NativeVerifierConfigured: true,
                CredentialRootReady: true));

        Assert.Contains(errors, static error => error.Contains("circuit-native credential", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void ValidateCore_RejectsProductionZkProdReadyWhenCredentialIssuerUnavailable()
    {
        IConfiguration configuration = CreateZkProdProductionConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousCredentialIssuer:CircuitNative:Enabled"] = "false"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true,
            new ZkProdRuntimeReadiness(
                NativeVerifierConfigured: true,
                CredentialRootReady: true));

        Assert.Contains(errors, static error => error.Contains("circuit-native issuer", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void ValidateCore_AcceptsProductionZkProdWhenAllConfiguredReadinessGatesPass()
    {
        IConfiguration configuration = CreateZkProdProductionConfiguration([]);

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true,
            new ZkProdRuntimeReadiness(
                NativeVerifierConfigured: true,
                CredentialRootReady: true,
                CredentialIssuerConfigured: true));

        Assert.DoesNotContain(errors, static error => error.Contains("AnonymousIdentity:ZkProd", StringComparison.Ordinal));
    }

    private static IConfiguration CreateConfiguration(Dictionary<string, string?> values)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();

    private static IConfiguration CreateValidProductionConfiguration(Dictionary<string, string?> overrides)
    {
        Dictionary<string, string?> values = new(StringComparer.Ordinal)
        {
            ["ConnectionStrings:DefaultConnection"] = "Host=db;Database=fsus;Username=fsus;Password=secret",
            ["ConnectionStrings:Redis"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["RedisOptions:Configuration"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["Jwt:SecretKey"] = "production-secret-key-with-at-least-thirty-two-chars",
            ["AllowedHosts"] = "fsus.blog;www.fsus.blog",
            ["CORS_ALLOWED_HOSTS"] = "https://fsus.blog,https://www.fsus.blog",
            ["Seo:BaseUrl"] = "https://fsus.blog",
            ["Fido2:ServerDomain"] = "fsus.blog",
            ["Fido2:Origins:0"] = "https://fsus.blog",
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = "production-subject-hash-pepper-with-at-least-thirty-two-chars",
            ["ReverseProxy:KnownProxies"] = "127.0.0.1",
            [AnonymousIdentityRuntime.ModeEnvironmentVariable] = "1"
        };

        foreach ((string key, string? value) in overrides)
        {
            values[key] = value;
        }

        return CreateConfiguration(values);
    }

    private static IConfiguration CreateZkProdProductionConfiguration(Dictionary<string, string?> overrides)
    {
        Dictionary<string, string?> values = new(StringComparer.Ordinal)
        {
            ["AnonymousIdentity:ZkProd:Enabled"] = "true",
            ["AnonymousIdentity:ZkProd:RequireNativeVerifier"] = "true",
            ["AnonymousIdentity:ZkProd:RequireCredential"] = "true",
            ["AnonymousIdentity:ZkProd:RequireTrustedSetupVerified"] = "true",
            ["AnonymousIdentity:ZkProd:AllowDevVerifier"] = "false",
            ["AnonymousIdentity:ZkProd:FallbackToLegacyAnonymous"] = "false",
            ["AnonymousIdentity:ZkProd:VerifierBackend"] = "native_groth16",
            ["AnonymousIdentity:ZkProd:TrustedSetupVerified"] = "true",
            ["AnonymousIdentity:ZkProd:CredentialReady"] = "true",
            ["AnonymousIdentity:ZkProd:VerifyingKeyHash"] = "vk-sha256"
        };

        foreach ((string key, string? value) in overrides)
        {
            values[key] = value;
        }

        return CreateValidProductionConfiguration(values);
    }

    private sealed class StaticZkProofVerifier(bool configured) : IZkProofVerifier
    {
        public bool IsConfigured { get; } = configured;

        public Task<ZkProofVerificationResult> VerifyAsync(
            ZkProofVerificationRequest request,
            CancellationToken cancellationToken = default)
            => Task.FromResult(ZkProofVerificationResult.VerifierUnavailable());
    }

    private sealed class StaticRootReader : IAnonymousCredentialRootReader
    {
        public StaticRootReader(bool rootReady)
        {
            CurrentSnapshot = rootReady
                ? new AnonymousCredentialRootRuntimeSnapshot(
                    [
                        new AnonymousCredentialAcceptedRoot(
                            1,
                            "root-hash",
                            "revocation-root-hash",
                            new string('f', 64),
                            AnonymousCredentialRootStatuses.Active,
                            DateTimeOffset.UtcNow.AddHours(1))
                    ],
                    1,
                    DateTimeOffset.UtcNow)
                : AnonymousCredentialRootRuntimeSnapshot.Empty;
        }

        public AnonymousCredentialRootRuntimeSnapshot CurrentSnapshot { get; }

        public Task RefreshAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

        public bool IsRootAccepted(string rootHash, long epoch) => CurrentSnapshot.AcceptedRoots.Count > 0;

        public bool IsRootAccepted(string rootHash, string revocationRootHash, string issuerPublicKeyHash, long epoch)
            => CurrentSnapshot.AcceptedRoots.Count > 0;
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
}
