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
    private static string DefaultJwtSecretSample
        => string.Concat("Were_I_you", "_I_would_get_high_like_some_airplanes");

    private static string LocalReleaseJwtSecretSample
        => string.Concat("Local_Release", "_Smoke_Key_For_FsusBlog_2026_Only");

    [Fact]
    public void ValidateCore_AcceptsProductionConfigurationWithHttpsAndRedisPassword()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = "Host=db;Database=fsus;Username=fsus;Password=secret",
            ["ConnectionStrings:Redis"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["RedisOptions:Configuration"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["AllowedHosts"] = "example.com;www.example.com",
            ["CORS_ALLOWED_HOSTS"] = "https://example.com,https://www.example.com",
            ["Seo:BaseUrl"] = "https://example.com",
            ["Fido2:ServerDomain"] = "example.com",
            ["Fido2:Origins:0"] = "https://example.com",
            ["Security:Pow:SigningKey"] = TestSecrets.PowSigningKey,
            ["Security:CaptchaV1:SigningKey"] = TestSecrets.CaptchaSigningKey,
            ["Security:PerceptionSealedToken:CurrentKeyVersion"] = "k1",
            ["Security:PerceptionSealedToken:Keys:k1"] = new string('a', 64),
            ["Security:RecoveryKeyPepper"] = TestSecrets.RecoveryKeyPepper,
            ["PublicAot:ManifestToken"] = "public-aot-manifest-token-with-enough-entropy",
            ["MfaChallenge:TicketSigningKey"] = TestSecrets.MfaTicketSigningKey,
            ["Audit:TamperEvidenceKey"] = TestSecrets.AuditTamperEvidenceKey,
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = TestSecrets.SubjectHashPepper,
            ["VisitLog:IpHashPepper"] = TestSecrets.VisitLogIpHashPepper,
            ["Moderation:RegionPolicy:IpHashKey"] = TestSecrets.RegionIpHashKey,
            ["Moderation:Pepper"] = TestSecrets.ModerationPepper,
            ["Subscription:EmailHashPepper"] = TestSecrets.SubscriptionEmailHashPepper,
            ["AnonymousIdentity:NullifierPepper"] = TestSecrets.AnonymousNullifierPepper,
            ["AnonymousCredentialRoot:AttestationKey"] = TestSecrets.AnonymousRootAttestationKey,
            ["ReverseProxy:KnownProxies"] = "127.0.0.1",
            [AnonymousIdentityRuntime.ModeEnvironmentVariable] = "1"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Empty(errors);
    }

    [Theory]
    [InlineData("Security:CrawlerCidrs:GoogleUrl", "http://developers.google.com/static/search/apis/ipranges/googlebot.json")]
    [InlineData("Security:CrawlerCidrs:GoogleUrl", "https://internal-admin/api/secrets")]
    [InlineData("Security:CrawlerCidrs:BingUrl", "http://www.bing.com/toolbox/bingbot.json")]
    [InlineData("Security:CrawlerCidrs:BingUrl", "https://169.254.169.254/latest/meta-data/")]
    public void ValidateCore_RejectsUnsafeCrawlerRangeUrls(string key, string value)
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            [key] = value
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, error => error.Contains(key, StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("Security:CrawlerCidrs:GoogleUrl", "https://developers.google.com/static/search/apis/ipranges/googlebot.json")]
    [InlineData("Security:CrawlerCidrs:BingUrl", "https://www.bing.com/toolbox/bingbot.json")]
    public void ValidateCore_AcceptsOfficialCrawlerRangeUrls(string key, string value)
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            [key] = value
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.DoesNotContain(errors, error => error.Contains(key, StringComparison.Ordinal));
    }

    [Fact]
    public void ValidateCore_RejectsReviewedHttpJsonAntiSpamEndpointWithoutSafeAllowlist()
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            ["Moderation:Pepper"] = TestSecrets.ModerationPepper,
            ["Moderation:AntiSpamModel:Enabled"] = "true",
            ["Moderation:AntiSpamModel:Provider"] = "http-json",
            ["Moderation:AntiSpamModel:AllowExternalProvider"] = "true",
            ["Moderation:AntiSpamModel:ExternalProviderReviewed"] = "true",
            ["Moderation:AntiSpamModel:Providers:http-json:Endpoint"] = "https://169.254.169.254/latest/meta-data/",
            ["Moderation:AntiSpamModel:Providers:http-json:AllowedHosts"] = "169.254.169.254"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("Moderation:AntiSpamModel:Providers:http-json:Endpoint", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("private_or_reserved_address", StringComparison.Ordinal));
    }

    [Fact]
    public void ValidateCore_RejectsProductionPerceptionSealedTokenWithoutSigningKey()
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            ["Security:PerceptionSealedToken:Keys:k1"] = null
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("Security:PerceptionSealedToken:Keys:k1", StringComparison.Ordinal));
    }

    [Fact]
    public void ValidateCore_RejectsProductionPerceptionSealedTokenStaleCurrentKeyVersion()
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            ["Security:PerceptionSealedToken:CurrentKeyVersion"] = "k2"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("Security:PerceptionSealedToken:CurrentKeyVersion", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("k2", StringComparison.Ordinal));
    }

    [Fact]
    public void ValidateCore_AcceptsReviewedHttpJsonAntiSpamEndpointWithSafeAllowlist()
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            ["Moderation:Pepper"] = TestSecrets.ModerationPepper,
            ["Moderation:AntiSpamModel:Enabled"] = "true",
            ["Moderation:AntiSpamModel:Provider"] = "http-json",
            ["Moderation:AntiSpamModel:AllowExternalProvider"] = "true",
            ["Moderation:AntiSpamModel:ExternalProviderReviewed"] = "true",
            ["Moderation:AntiSpamModel:Providers:http-json:Endpoint"] = "https://8.8.8.8/v1/moderation/score",
            ["Moderation:AntiSpamModel:Providers:http-json:AllowedHosts"] = "8.8.8.8"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.DoesNotContain(errors, static error => error.Contains("Moderation:AntiSpamModel:Providers:http-json:Endpoint", StringComparison.Ordinal));
    }

    [Fact]
    public void ValidateCore_RejectsProductionDefaultsAndInsecureOrigins()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = "Host=db;Database=fsus;Username=fsus;Password=secret",
            ["ConnectionStrings:Redis"] = "redis:6379,abortConnect=false",
            ["RedisOptions:Configuration"] = "redis:6379,password=,abortConnect=false",
            ["Jwt:SecretKey"] = DefaultJwtSecretSample,
            ["AllowedHosts"] = "*",
            ["CORS_ALLOWED_HOSTS"] = "http://example.com",
            ["Seo:BaseUrl"] = "http://example.com",
            ["Fido2:ServerDomain"] = "localhost",
            ["Fido2:Origins:0"] = "http://example.com",
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = "MUST_BE_OVERRIDDEN_BY_ENV_VARIABLES",
            ["VisitLog:IpHashPepper"] = "replace-with-stable-random-visit-log-ip-hash-pepper"
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
        Assert.Contains(errors, static error => error.Contains("Security:Pow:SigningKey", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Security:CaptchaV1:SigningKey", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Security:RecoveryKeyPepper", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("PublicAot:ManifestToken", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("AnonymousCredentialIssuer:SubjectHashPepper", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("VisitLog:IpHashPepper", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Moderation:Pepper", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Moderation:RegionPolicy:IpHashKey", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("Security:Pow:SigningKey")]
    [InlineData("Security:CaptchaV1:SigningKey")]
    [InlineData("Security:RecoveryKeyPepper")]
    [InlineData("PublicAot:ManifestToken")]
    [InlineData("Audit:TamperEvidenceKey")]
    [InlineData("AnonymousCredentialIssuer:SubjectHashPepper")]
    [InlineData("VisitLog:IpHashPepper")]
    [InlineData("Moderation:RegionPolicy:IpHashKey")]
    public void ValidateCore_RejectsProductionWhenIndependentSecuritySecretIsMissing(string key)
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            [key] = null
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, error => error.Contains(key, StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("Security:Pow:SigningKey")]
    [InlineData("Security:CaptchaV1:SigningKey")]
    [InlineData("Security:RecoveryKeyPepper")]
    [InlineData("PublicAot:ManifestToken")]
    [InlineData("Audit:TamperEvidenceKey")]
    [InlineData("AnonymousCredentialIssuer:SubjectHashPepper")]
    [InlineData("VisitLog:IpHashPepper")]
    [InlineData("Moderation:RegionPolicy:IpHashKey")]
    public void ValidateCore_RejectsProductionSecuritySecretSharedWithJwtSecret(string key)
    {
        const string sharedSecret = "shared-jwt-secret-that-must-not-seed-other-security-domains";
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            ["Jwt:SecretKey"] = sharedSecret,
            [key] = sharedSecret
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, error => error.Contains(key, StringComparison.Ordinal)
            && error.Contains("Jwt:SecretKey", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("short-key")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    public void ValidateCore_RejectsWeakAuditTamperEvidenceKey(string keyValue)
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            ["Audit:TamperEvidenceKey"] = keyValue
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("Audit:TamperEvidenceKey", StringComparison.Ordinal));
    }

    [Fact]
    public void SecurityDomainSecrets_DoNotFallBackToJwtSecretOrHardCodedMaterial()
    {
        string[] sources =
        [
            "src/backend/Infrastructure/Audit/AuditTamperEvidence.cs",
            "src/backend/Services/Security/RedisPowService.cs",
            "src/backend/Services/Security/CaptchaV1ChallengeProvider.cs",
            "src/backend/Services/Security/RecoveryKeyService.cs",
            "src/backend/Services/Security/AnonymousCredentialIssuerService.cs",
            "src/backend/Services/VisitLog/VisitLogProcessorService.cs",
            "src/backend/Services/Moderation/ClientRegionResolver.cs"
        ];
        string combined = string.Join('\n', sources.Select(static path => BackendTestPaths.ReadAllTextFromRoot(path)));

        Assert.DoesNotContain("configuration[\"Jwt:SecretKey\"]", combined, StringComparison.Ordinal);
        Assert.DoesNotContain("config[\"Jwt:SecretKey\"]", combined, StringComparison.Ordinal);
        Assert.DoesNotContain("Fallback:", combined, StringComparison.Ordinal);
        Assert.DoesNotContain("development-key", combined, StringComparison.Ordinal);
        Assert.DoesNotContain("development-anonymous-credential-subject-hash-pepper", combined, StringComparison.Ordinal);
    }

    [Fact]
    public void SharedAppsettings_DoesNotContainReusableJwtSecret()
    {
        string appsettings = BackendTestPaths.ReadAllTextFromRoot("src/backend/appsettings.json");

        Assert.DoesNotContain(DefaultJwtSecretSample, appsettings, StringComparison.Ordinal);
        Assert.DoesNotContain($"\"SecretKey\": \"{LocalReleaseJwtSecretSample}\"", appsettings, StringComparison.Ordinal);
    }

    [Fact]
    public async Task HostedService_DoesNotBypassDefaultJwtSecretEvenWhenInsecureStartupAllowed()
    {
        IConfiguration configuration = CreateValidProductionConfiguration(new Dictionary<string, string?>
        {
            ["Jwt:SecretKey"] = DefaultJwtSecretSample,
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
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["AllowedHosts"] = "example.com",
            ["CORS_ALLOWED_HOSTS"] = "https://example.com",
            ["Seo:BaseUrl"] = "https://example.com",
            ["Fido2:ServerDomain"] = "example.com",
            ["Fido2:Origins:0"] = "https://example.com",
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = TestSecrets.SubjectHashPepper,
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
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["AllowedHosts"] = "example.com",
            ["CORS_ALLOWED_HOSTS"] = "https://example.com",
            ["Seo:BaseUrl"] = "https://example.com",
            ["Fido2:ServerDomain"] = "example.com",
            ["Fido2:Origins:0"] = "https://example.com",
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = TestSecrets.SubjectHashPepper,
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
        Assert.Contains(errors, static error => error.Contains("VisitLog:IpHashPepper", StringComparison.Ordinal));
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

        Assert.Equal(13, report.SchemaVersion);
        Assert.Equal(ProductionStartupValidator.CurrentSchema.Version, report.SchemaVersion);
        Assert.Equal(
            ProductionStartupValidator.CurrentSchema.RequiredSettings.Order(StringComparer.Ordinal),
            report.Requirements.Select(static requirement => requirement.Key).Order(StringComparer.Ordinal));
        Assert.Contains(AnonymousIdentityRuntime.ModeEnvironmentVariable, ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Jwt:SecretKey", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("AllowedHosts", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Fido2:ServerDomain", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Fido2:Origins", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Security:Pow:SigningKey", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Security:CaptchaV1:SigningKey", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Security:PerceptionSealedToken:CurrentKeyVersion", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Security:RecoveryKeyPepper", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("PublicAot:ManifestToken", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("MfaChallenge:TicketSigningKey", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Audit:TamperEvidenceKey", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("AnonymousCredentialIssuer:SubjectHashPepper", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("VisitLog:IpHashPepper", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Moderation:RegionPolicy:IpHashKey", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Moderation:Pepper", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Subscription:EmailHashPepper", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("AnonymousIdentity:NullifierPepper", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("AnonymousCredentialRoot:AttestationKey", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.All(
            ProductionStartupValidator.CurrentSchema.DefaultJwtSecrets,
            static secret => Assert.StartsWith("sha256:", secret, StringComparison.Ordinal));
        Assert.DoesNotContain(
            ProductionStartupValidator.CurrentSchema.DefaultJwtSecrets,
            static secret => secret.Contains("MUST_BE_OVERRIDDEN", StringComparison.Ordinal));
    }

    [Fact]
    public void ValidateCore_RejectsFido2OriginsThatDoNotMatchTrustedProductionOrigins()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = "Host=db;Database=fsus;Username=fsus;Password=secret",
            ["ConnectionStrings:Redis"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["RedisOptions:Configuration"] = "redis:6379,password=redis-secret,abortConnect=false",
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["AllowedHosts"] = "example.com",
            ["CORS_ALLOWED_HOSTS"] = "https://example.com",
            ["Seo:BaseUrl"] = "https://example.com",
            ["Fido2:ServerDomain"] = "login.example.com",
            ["Fido2:Origins:0"] = "https://evil.example",
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = TestSecrets.SubjectHashPepper,
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
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["AllowedHosts"] = "example.com",
            ["CORS_ALLOWED_HOSTS"] = "https://example.com,https://www.example.com",
            ["Seo:BaseUrl"] = "https://example.com",
            ["Fido2:ServerDomain"] = "example.com",
            ["Fido2:Origins:0"] = "https://www.example.com",
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = TestSecrets.SubjectHashPepper,
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
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["AllowedHosts"] = "example.com",
            ["CORS_ALLOWED_HOSTS"] = "https://example.com",
            ["Seo:BaseUrl"] = "https://example.com",
            ["Fido2:ServerDomain"] = "example.com",
            ["Fido2:Origins:0"] = "https://example.com",
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
    public void ValidateCore_RejectsProductionZkProdWhenManifestIsNotProductionUsable()
    {
        IConfiguration configuration = CreateZkProdProductionConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:ZkProd:VerifyingKeyHash"] = "27ea8a04e27eb66a5b61aab2251762a372bb3f39217c896bc5ad850fd859143c",
            ["AnonymousIdentity:ZkProd:TrustedSetupManifestPath"] = "security/zk/comment-v2-trusted-setup.manifest.json",
            ["AnonymousIdentity:ZkProd:VerifyingKeyManifestPath"] = "config/zk/anonymous-comment-v2-verifying-key.manifest.json"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true,
            new ZkProdRuntimeReadiness(
                NativeVerifierConfigured: true,
                CredentialRootReady: true,
                CredentialIssuerConfigured: true));

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
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["AllowedHosts"] = "example.com;www.example.com",
            ["CORS_ALLOWED_HOSTS"] = "https://example.com,https://www.example.com",
            ["Seo:BaseUrl"] = "https://example.com",
            ["Fido2:ServerDomain"] = "example.com",
            ["Fido2:Origins:0"] = "https://example.com",
            ["Security:Pow:SigningKey"] = TestSecrets.PowSigningKey,
            ["Security:CaptchaV1:SigningKey"] = TestSecrets.CaptchaSigningKey,
            ["Security:PerceptionSealedToken:CurrentKeyVersion"] = "k1",
            ["Security:PerceptionSealedToken:Keys:k1"] = new string('a', 64),
            ["Security:RecoveryKeyPepper"] = TestSecrets.RecoveryKeyPepper,
            ["PublicAot:ManifestToken"] = "public-aot-manifest-token-with-enough-entropy",
            ["MfaChallenge:TicketSigningKey"] = TestSecrets.MfaTicketSigningKey,
            ["Audit:TamperEvidenceKey"] = TestSecrets.AuditTamperEvidenceKey,
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = TestSecrets.SubjectHashPepper,
            ["VisitLog:IpHashPepper"] = TestSecrets.VisitLogIpHashPepper,
            ["Moderation:RegionPolicy:IpHashKey"] = TestSecrets.RegionIpHashKey,
            ["Moderation:Pepper"] = TestSecrets.ModerationPepper,
            ["Subscription:EmailHashPepper"] = TestSecrets.SubscriptionEmailHashPepper,
            ["AnonymousIdentity:NullifierPepper"] = TestSecrets.AnonymousNullifierPepper,
            ["AnonymousCredentialRoot:AttestationKey"] = TestSecrets.AnonymousRootAttestationKey,
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
            ["AnonymousIdentity:ZkProd:VerifyingKeyHash"] = "27ea8a04e27eb66a5b61aab2251762a372bb3f39217c896bc5ad850fd859143c"
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
