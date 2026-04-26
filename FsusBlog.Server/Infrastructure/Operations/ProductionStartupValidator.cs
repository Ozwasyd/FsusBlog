using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Operations;

public sealed class ProductionStartupValidationException(IReadOnlyList<string> errors)
    : InvalidOperationException("Production startup validation failed: " + string.Join("; ", errors))
{
    public IReadOnlyList<string> Errors { get; } = errors;
}

public static class ProductionStartupValidator
{
    private static readonly string[] DefaultJwtSecrets =
    [
        "Were_I_you_I_would_get_high_like_some_airplanes",
        "MUST_BE_OVERRIDDEN_BY_ENV_VARIABLES",
        "Local_Release_Smoke_Key_For_FsusBlog_2026_Only"
    ];

    public static void Validate(IConfiguration configuration, IWebHostEnvironment environment)
    {
        IReadOnlyList<string> errors = ValidateCore(configuration, environment.IsProduction());
        if (errors.Count > 0)
        {
            throw new ProductionStartupValidationException(errors);
        }
    }

    internal static IReadOnlyList<string> ValidateCore(IConfiguration configuration, bool enforceProductionRules)
    {
        List<string> errors = [];

        RequireConnectionString(configuration, "DefaultConnection", errors);
        string? redisConnection = RequireConnectionString(configuration, "Redis", errors);
        string? redisOptionsConnection = RequireValue(configuration, "RedisOptions:Configuration", errors);
        string? jwtSecret = RequireValue(configuration, "Jwt:SecretKey", errors);
        string? corsOrigins = RequireValue(configuration, "CORS_ALLOWED_HOSTS", errors);
        string? seoBaseUrl = RequireValue(configuration, "Seo:BaseUrl", errors);

        if (!string.IsNullOrWhiteSpace(jwtSecret))
        {
            if (jwtSecret.Length < 32)
            {
                errors.Add("Jwt:SecretKey must be at least 32 characters.");
            }

            if (DefaultJwtSecrets.Contains(jwtSecret, StringComparer.Ordinal))
            {
                errors.Add("Jwt:SecretKey must not use a development/template/default value.");
            }

            if (jwtSecret.Contains("CHANGE_ME", StringComparison.OrdinalIgnoreCase))
            {
                errors.Add("Jwt:SecretKey must not use a template placeholder.");
            }
        }

        ValidateRedisConnection("ConnectionStrings:Redis", redisConnection, enforceProductionRules, errors);
        ValidateRedisConnection("RedisOptions:Configuration", redisOptionsConnection, enforceProductionRules, errors);
        ValidateCorsOrigins(corsOrigins, enforceProductionRules, errors);
        ValidateSeoBaseUrl(seoBaseUrl, enforceProductionRules, errors);

        return errors;
    }

    private static string? RequireConnectionString(IConfiguration configuration, string name, List<string> errors)
    {
        string? value = configuration.GetConnectionString(name);
        if (string.IsNullOrWhiteSpace(value))
        {
            errors.Add($"ConnectionStrings:{name} is required.");
        }

        return value;
    }

    private static string? RequireValue(IConfiguration configuration, string key, List<string> errors)
    {
        string? value = configuration[key];
        if (string.IsNullOrWhiteSpace(value))
        {
            errors.Add($"{key} is required.");
        }

        return value;
    }

    private static void ValidateRedisConnection(string key, string? connectionString, bool enforceProductionRules, List<string> errors)
    {
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            return;
        }

        if (!enforceProductionRules)
        {
            return;
        }

        try
        {
            ConfigurationOptions options = ConfigurationOptions.Parse(connectionString);
            if (string.IsNullOrWhiteSpace(options.Password)
                || options.Password.Contains("CHANGE_ME", StringComparison.OrdinalIgnoreCase))
            {
                errors.Add($"{key} must include a non-empty Redis password in production.");
            }
        }
        catch (Exception ex) when (ex is ArgumentException or FormatException)
        {
            errors.Add($"{key} must be a valid Redis connection string.");
        }
    }

    private static void ValidateCorsOrigins(string? rawOrigins, bool enforceProductionRules, List<string> errors)
    {
        if (string.IsNullOrWhiteSpace(rawOrigins))
        {
            return;
        }

        string[] origins = rawOrigins.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (origins.Length == 0)
        {
            errors.Add("CORS_ALLOWED_HOSTS must contain at least one origin.");
            return;
        }

        for (int i = 0; i < origins.Length; i++)
        {
            string origin = origins[i];
            if (!Uri.TryCreate(origin, UriKind.Absolute, out Uri? uri)
                || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
                || !string.IsNullOrEmpty(uri.AbsolutePath.Trim('/'))
                || !string.IsNullOrEmpty(uri.Query)
                || !string.IsNullOrEmpty(uri.Fragment))
            {
                errors.Add($"CORS_ALLOWED_HOSTS contains an invalid origin: {origin}");
                continue;
            }

            if (enforceProductionRules && uri.Scheme != Uri.UriSchemeHttps)
            {
                errors.Add($"CORS_ALLOWED_HOSTS origin must use HTTPS in production: {origin}");
            }
        }
    }

    private static void ValidateSeoBaseUrl(string? seoBaseUrl, bool enforceProductionRules, List<string> errors)
    {
        if (string.IsNullOrWhiteSpace(seoBaseUrl))
        {
            return;
        }

        if (!Uri.TryCreate(seoBaseUrl, UriKind.Absolute, out Uri? uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            || !string.IsNullOrEmpty(uri.Query)
            || !string.IsNullOrEmpty(uri.Fragment))
        {
            errors.Add("Seo:BaseUrl must be an absolute HTTP(S) base URL without query or fragment.");
            return;
        }

        if (enforceProductionRules && uri.Scheme != Uri.UriSchemeHttps)
        {
            errors.Add("Seo:BaseUrl must use HTTPS in production.");
        }
    }

}
