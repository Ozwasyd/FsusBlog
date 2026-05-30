using FsusBlog.Server.Infrastructure.Bootstrap;
using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Operations;

public sealed class ProductionStartupValidationException(IReadOnlyList<string> errors)
    : InvalidOperationException("Production startup validation failed: " + string.Join("; ", errors))
{
    public IReadOnlyList<string> Errors { get; } = errors;
}

public sealed class ProductionStartupValidationRequirement(string key, bool isPresent)
{
    public string Key { get; } = key;

    public bool IsPresent { get; } = isPresent;
}

public sealed class ProductionStartupValidationSchema(
    int version,
    IReadOnlyList<string> requiredSettings,
    IReadOnlyList<string> defaultJwtSecrets)
{
    public int Version { get; } = version;

    public IReadOnlyList<string> RequiredSettings { get; } = requiredSettings;

    public IReadOnlyList<string> DefaultJwtSecrets { get; } = defaultJwtSecrets;
}

public sealed class ProductionStartupValidationReport(
    int schemaVersion,
    bool enforceProductionRules,
    IReadOnlyList<ProductionStartupValidationRequirement> requirements,
    IReadOnlyList<string> errors)
{
    public int SchemaVersion { get; } = schemaVersion;

    public bool EnforceProductionRules { get; } = enforceProductionRules;

    public IReadOnlyList<ProductionStartupValidationRequirement> Requirements { get; } = requirements;

    public IReadOnlyList<string> Errors { get; } = errors;
}

public static class ProductionStartupValidator
{
    private const int SchemaVersion = 2;

    private sealed class RequiredSettingRule(string key, Func<IConfiguration, string?> readValue)
    {
        public string Key { get; } = key;

        public Func<IConfiguration, string?> ReadValue { get; } = readValue;
    }

    private static readonly string[] DefaultJwtSecrets =
    [
        "Were_I_you_I_would_get_high_like_some_airplanes",
        "MUST_BE_OVERRIDDEN_BY_ENV_VARIABLES",
        "Local_Release_Smoke_Key_For_FsusBlog_2026_Only"
    ];

    private static readonly RequiredSettingRule[] RequiredSettings =
    [
        ConnectionString("DefaultConnection"),
        ConnectionString("Redis"),
        Value("RedisOptions:Configuration"),
        Value("Jwt:SecretKey"),
        Value("AllowedHosts"),
        Value("CORS_ALLOWED_HOSTS"),
        Value("Seo:BaseUrl"),
        Value("Fido2:ServerDomain"),
        new("Fido2:Origins", ReadOriginList)
    ];

    public static ProductionStartupValidationSchema CurrentSchema { get; } = new(
        SchemaVersion,
        RequiredSettings.Select(static rule => rule.Key).ToArray(),
        DefaultJwtSecrets);

    public static void Validate(IConfiguration configuration, IWebHostEnvironment environment)
    {
        ProductionStartupValidationReport report = CreateValidationReport(configuration, environment.IsProduction());
        if (report.Errors.Count > 0)
        {
            throw new ProductionStartupValidationException(report.Errors);
        }
    }

    internal static IReadOnlyList<string> ValidateCore(IConfiguration configuration, bool enforceProductionRules)
        => CreateValidationReport(configuration, enforceProductionRules).Errors;

    internal static ProductionStartupValidationReport CreateValidationReport(IConfiguration configuration, bool enforceProductionRules)
    {
        List<string> errors = [];
        List<ProductionStartupValidationRequirement> requirements = new(RequiredSettings.Length);
        Dictionary<string, string?> values = new(StringComparer.Ordinal);

        for (int i = 0; i < RequiredSettings.Length; i++)
        {
            RequiredSettingRule rule = RequiredSettings[i];
            string? value = rule.ReadValue(configuration);
            bool isPresent = !string.IsNullOrWhiteSpace(value);
            requirements.Add(new ProductionStartupValidationRequirement(rule.Key, isPresent));
            values[rule.Key] = value;

            if (!isPresent)
            {
                errors.Add($"{rule.Key} is required.");
            }
        }

        string? redisConnection = values["ConnectionStrings:Redis"];
        string? redisOptionsConnection = values["RedisOptions:Configuration"];
        string? jwtSecret = values["Jwt:SecretKey"];
        string? allowedHosts = values["AllowedHosts"];
        string? corsOrigins = values["CORS_ALLOWED_HOSTS"];
        string? seoBaseUrl = values["Seo:BaseUrl"];
        string? fido2ServerDomain = values["Fido2:ServerDomain"];
        string? fido2Origins = values["Fido2:Origins"];

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
        ValidateAllowedHosts(allowedHosts, seoBaseUrl, corsOrigins, fido2ServerDomain, fido2Origins, enforceProductionRules, errors);
        ValidateReverseProxyTrust(configuration, enforceProductionRules, errors);
        ValidateCorsOrigins(corsOrigins, enforceProductionRules, errors);
        ValidateSeoBaseUrl(seoBaseUrl, enforceProductionRules, errors);
        ValidateFido2Settings(fido2ServerDomain, fido2Origins, seoBaseUrl, corsOrigins, enforceProductionRules, errors);

        return new ProductionStartupValidationReport(SchemaVersion, enforceProductionRules, requirements, errors);
    }

    private static RequiredSettingRule ConnectionString(string name)
        => new($"ConnectionStrings:{name}", configuration => configuration.GetConnectionString(name));

    private static RequiredSettingRule Value(string key)
        => new(key, configuration => configuration[key]);

    private static string? ReadOriginList(IConfiguration configuration)
    {
        string? directValue = configuration["Fido2:Origins"];
        if (!string.IsNullOrWhiteSpace(directValue))
        {
            return directValue;
        }

        string[] children = configuration
            .GetSection("Fido2:Origins")
            .GetChildren()
            .Select(static child => child.Value)
            .Where(static value => !string.IsNullOrWhiteSpace(value))
            .Select(static value => value!)
            .ToArray();

        return children.Length == 0 ? null : string.Join(',', children);
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

    private static void ValidateAllowedHosts(
        string? rawAllowedHosts,
        string? seoBaseUrl,
        string? corsOrigins,
        string? fido2ServerDomain,
        string? fido2Origins,
        bool enforceProductionRules,
        List<string> errors)
    {
        if (string.IsNullOrWhiteSpace(rawAllowedHosts))
        {
            return;
        }

        string[] hosts = rawAllowedHosts
            .Split([';', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(static host => host.Trim().TrimEnd('.'))
            .Where(static host => host.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        if (hosts.Length == 0)
        {
            errors.Add("AllowedHosts must contain at least one host.");
            return;
        }

        HashSet<string> hostSet = hosts.ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (string host in hosts)
        {
            if (host == "*")
            {
                if (enforceProductionRules)
                {
                    errors.Add("AllowedHosts must not use wildcard '*' in production.");
                }

                continue;
            }

            if (Uri.CheckHostName(host) != UriHostNameType.Dns)
            {
                errors.Add($"AllowedHosts contains an invalid production host: {host}");
                continue;
            }

            if (enforceProductionRules
                && (host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
                    || host.Equals("127.0.0.1", StringComparison.OrdinalIgnoreCase)))
            {
                errors.Add($"AllowedHosts must not use localhost in production: {host}");
            }
        }

        if (!enforceProductionRules || hostSet.Contains("*"))
        {
            return;
        }

        RequireHostInAllowedHosts("Seo:BaseUrl", TryParseOriginLikeBaseUrl(seoBaseUrl)?.Host, hostSet, errors);
        RequireHostInAllowedHosts("Fido2:ServerDomain", fido2ServerDomain, hostSet, errors);

        foreach (Uri origin in ParseOriginList(corsOrigins))
        {
            RequireHostInAllowedHosts("CORS_ALLOWED_HOSTS", origin.Host, hostSet, errors);
        }

        foreach (Uri origin in ParseOriginList(fido2Origins))
        {
            RequireHostInAllowedHosts("Fido2:Origins", origin.Host, hostSet, errors);
        }
    }

    private static void ValidateReverseProxyTrust(IConfiguration configuration, bool enforceProductionRules, List<string> errors)
    {
        string[] knownProxies = ReverseProxyForwardedHeaders.ReadConfiguredList(
            configuration,
            ReverseProxyForwardedHeaders.KnownProxiesKey);
        string[] knownNetworks = ReverseProxyForwardedHeaders.ReadConfiguredList(
            configuration,
            ReverseProxyForwardedHeaders.KnownNetworksKey);

        if (enforceProductionRules && knownProxies.Length == 0 && knownNetworks.Length == 0)
        {
            errors.Add("ReverseProxy:KnownProxies or ReverseProxy:KnownNetworks must be configured in production.");
        }

        foreach (string knownProxy in knownProxies)
        {
            if (!ReverseProxyForwardedHeaders.TryParseKnownProxy(knownProxy, out _))
            {
                errors.Add($"ReverseProxy:KnownProxies contains an invalid or unsafe IP address: {knownProxy}");
            }
        }

        foreach (string knownNetwork in knownNetworks)
        {
            if (!ReverseProxyForwardedHeaders.TryParseKnownNetwork(knownNetwork, out _))
            {
                errors.Add($"ReverseProxy:KnownNetworks contains an invalid or unsafe CIDR: {knownNetwork}");
            }
        }
    }

    private static void RequireHostInAllowedHosts(
        string source,
        string? host,
        HashSet<string> allowedHosts,
        List<string> errors)
    {
        if (string.IsNullOrWhiteSpace(host))
        {
            return;
        }

        if (!allowedHosts.Contains(host.Trim().TrimEnd('.')))
        {
            errors.Add($"{source} host must be listed in AllowedHosts: {host}");
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

    private static void ValidateFido2Settings(
        string? serverDomain,
        string? rawOrigins,
        string? seoBaseUrl,
        string? corsOrigins,
        bool enforceProductionRules,
        List<string> errors)
    {
        Uri? seoUri = TryParseOriginLikeBaseUrl(seoBaseUrl);
        Uri[] allowedCorsOrigins = ParseOriginList(corsOrigins);

        if (!string.IsNullOrWhiteSpace(serverDomain))
        {
            if (Uri.TryCreate(serverDomain, UriKind.Absolute, out _)
                || serverDomain.Contains('/', StringComparison.Ordinal)
                || serverDomain.Contains(':', StringComparison.Ordinal)
                || Uri.CheckHostName(serverDomain) != UriHostNameType.Dns)
            {
                errors.Add("Fido2:ServerDomain must be a bare DNS host without scheme, port, path, query, or fragment.");
            }

            if (enforceProductionRules
                && (serverDomain.Equals("localhost", StringComparison.OrdinalIgnoreCase)
                    || serverDomain.Equals("127.0.0.1", StringComparison.OrdinalIgnoreCase)))
            {
                errors.Add("Fido2:ServerDomain must not use localhost in production.");
            }

            if (enforceProductionRules && seoUri is not null && !serverDomain.Equals(seoUri.Host, StringComparison.OrdinalIgnoreCase))
            {
                errors.Add("Fido2:ServerDomain must match Seo:BaseUrl host in production.");
            }
        }

        Uri[] fidoOrigins = ParseOriginList(rawOrigins);
        if (!string.IsNullOrWhiteSpace(rawOrigins) && fidoOrigins.Length == 0)
        {
            errors.Add("Fido2:Origins must contain at least one valid origin.");
            return;
        }

        for (int i = 0; i < fidoOrigins.Length; i++)
        {
            Uri origin = fidoOrigins[i];
            if (enforceProductionRules && origin.Scheme != Uri.UriSchemeHttps)
            {
                errors.Add($"Fido2:Origins origin must use HTTPS in production: {origin.GetLeftPart(UriPartial.Authority)}");
            }
        }

        if (enforceProductionRules && seoUri is not null && fidoOrigins.Length > 0)
        {
            string seoOrigin = seoUri.GetLeftPart(UriPartial.Authority);
            if (!fidoOrigins.Any(origin => origin.GetLeftPart(UriPartial.Authority).Equals(seoOrigin, StringComparison.OrdinalIgnoreCase)))
            {
                errors.Add("Fido2:Origins must include Seo:BaseUrl origin in production.");
            }
        }

        if (enforceProductionRules && allowedCorsOrigins.Length > 0 && fidoOrigins.Length > 0)
        {
            HashSet<string> corsSet = allowedCorsOrigins
                .Select(static origin => origin.GetLeftPart(UriPartial.Authority))
                .ToHashSet(StringComparer.OrdinalIgnoreCase);

            for (int i = 0; i < fidoOrigins.Length; i++)
            {
                string origin = fidoOrigins[i].GetLeftPart(UriPartial.Authority);
                if (!corsSet.Contains(origin))
                {
                    errors.Add($"Fido2:Origins origin must also be listed in CORS_ALLOWED_HOSTS: {origin}");
                }
            }
        }
    }

    private static Uri? TryParseOriginLikeBaseUrl(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        return Uri.TryCreate(value, UriKind.Absolute, out Uri? uri)
            && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
            ? uri
            : null;
    }

    private static Uri[] ParseOriginList(string? rawOrigins)
    {
        if (string.IsNullOrWhiteSpace(rawOrigins))
        {
            return [];
        }

        return rawOrigins
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(static origin => Uri.TryCreate(origin, UriKind.Absolute, out Uri? uri)
                && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
                && string.IsNullOrEmpty(uri.AbsolutePath.Trim('/'))
                && string.IsNullOrEmpty(uri.Query)
                && string.IsNullOrEmpty(uri.Fragment)
                    ? uri
                    : null)
            .OfType<Uri>()
            .ToArray();
    }
}

internal sealed class ProductionStartupValidationHostedService(
    IConfiguration configuration,
    IWebHostEnvironment environment,
    StartupRuntimeState runtimeState,
    ILogger<ProductionStartupValidationHostedService> logger) : IHostedService
{
    private const string TaskName = "productionStartupValidation";

    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (!environment.IsProduction())
        {
            runtimeState.ReportStartupTask(TaskName, "skipped", "非生产环境不强制执行生产启动校验");
            return Task.CompletedTask;
        }

        ProductionStartupValidationReport report = ProductionStartupValidator.CreateValidationReport(
            configuration,
            enforceProductionRules: true);
        if (report.Errors.Count == 0)
        {
            runtimeState.ReportStartupTask(TaskName, "completed", "生产启动校验通过");
            return Task.CompletedTask;
        }

        string detail = string.Join("; ", report.Errors);
        runtimeState.ReportStartupTask(TaskName, "degraded", detail);
        logger.LogWarning("Production startup validation degraded: {Errors}", detail);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
