using FsusBlog.Server.Infrastructure.Operations;
using Microsoft.Extensions.Configuration;

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
            ["CORS_ALLOWED_HOSTS"] = "https://fsus.blog,https://www.fsus.blog",
            ["Seo:BaseUrl"] = "https://fsus.blog"
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
            ["CORS_ALLOWED_HOSTS"] = "http://fsus.blog",
            ["Seo:BaseUrl"] = "http://fsus.blog"
        });

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);

        Assert.Contains(errors, static error => error.Contains("Jwt:SecretKey", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("ConnectionStrings:Redis", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("RedisOptions:Configuration", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("CORS_ALLOWED_HOSTS", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Seo:BaseUrl", StringComparison.Ordinal));
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
        Assert.Contains(errors, static error => error.Contains("CORS_ALLOWED_HOSTS", StringComparison.Ordinal));
        Assert.Contains(errors, static error => error.Contains("Seo:BaseUrl", StringComparison.Ordinal));
    }

    private static IConfiguration CreateConfiguration(Dictionary<string, string?> values)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();
}
