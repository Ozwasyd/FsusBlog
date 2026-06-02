using FsusBlog.Server.Infrastructure.Operations;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.Configuration;
using System.Net;

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
            ["ReverseProxy:KnownProxies"] = "127.0.0.1"
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
            ["Fido2:Origins:0"] = "http://fsus.blog"
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
            ["ReverseProxy:KnownProxies"] = "127.0.0.1",
            ["AuthCookies:AllowInsecureTransportCookies"] = "true"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("AuthCookies:AllowInsecureTransportCookies", StringComparison.Ordinal));
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
    }

    [Fact]
    public void CreateValidationReport_ExposesVersionedSchemaRequirements()
    {
        IConfiguration configuration = CreateConfiguration(new Dictionary<string, string?>());

        ProductionStartupValidationReport report = ProductionStartupValidator.CreateValidationReport(
            configuration,
            enforceProductionRules: true);

        Assert.Equal(3, report.SchemaVersion);
        Assert.Equal(ProductionStartupValidator.CurrentSchema.Version, report.SchemaVersion);
        Assert.Equal(
            ProductionStartupValidator.CurrentSchema.RequiredSettings.Order(StringComparer.Ordinal),
            report.Requirements.Select(static requirement => requirement.Key).Order(StringComparer.Ordinal));
        Assert.Contains("Jwt:SecretKey", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("AllowedHosts", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Fido2:ServerDomain", ProductionStartupValidator.CurrentSchema.RequiredSettings);
        Assert.Contains("Fido2:Origins", ProductionStartupValidator.CurrentSchema.RequiredSettings);
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

    private static IConfiguration CreateConfiguration(Dictionary<string, string?> values)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();
}
