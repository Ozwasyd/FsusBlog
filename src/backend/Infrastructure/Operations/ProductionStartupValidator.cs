using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Security;
using Microsoft.Extensions.Primitives;
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
    private const int SchemaVersion = 9;
    private static readonly TimeSpan CoreValidationCacheTtl = TimeSpan.FromSeconds(15);
    private static readonly object CoreValidationCacheLock = new();
    private static CoreValidationCacheEntry? s_coreValidationCache;

    private sealed class RequiredSettingRule(string key, Func<IConfiguration, string?> readValue)
    {
        public string Key { get; } = key;

        public Func<IConfiguration, string?> ReadValue { get; } = readValue;
    }

    private sealed record CoreValidationCacheEntry(
        IConfiguration Configuration,
        bool EnforceProductionRules,
        DateTimeOffset ExpiresAt,
        IChangeToken ReloadToken,
        ProductionStartupValidationReport Report);

    private static readonly string[] DefaultJwtSecrets =
    [
        "Were_I_you_I_would_get_high_like_some_airplanes",
        "MUST_BE_OVERRIDDEN_BY_ENV_VARIABLES",
        "Local_Release_Smoke_Key_For_FsusBlog_2026_Only"
    ];

    private static readonly string[] DefaultSubjectHashPeppers =
    [
        "MUST_BE_OVERRIDDEN_BY_ENV_VARIABLES",
        "replace-with-stable-random-subject-hash-pepper",
        "development-subject-hash-pepper-change-before-shared-use"
    ];

    private static readonly string[] DefaultVisitLogIpHashPeppers =
    [
        "MUST_BE_OVERRIDDEN_BY_ENV_VARIABLES",
        "replace-with-stable-random-visit-log-ip-hash-pepper",
        "development-visit-log-ip-hash-pepper-change-before-shared-use"
    ];

    private static readonly string[] DefaultModerationPeppers =
    [
        "MUST_BE_OVERRIDDEN_BY_ENV_VARIABLES",
        "replace-with-stable-random-moderation-pepper",
        "development-moderation-pepper-change-before-shared-use"
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
        new("Fido2:Origins", ReadOriginList),
        Value("Security:Pow:SigningKey"),
        Value("Security:CaptchaV1:SigningKey"),
        Value("Security:RecoveryKeyPepper"),
        Value("AnonymousCredentialIssuer:SubjectHashPepper"),
        Value("VisitLog:IpHashPepper"),
        Value("Moderation:RegionPolicy:IpHashKey"),
        Value("Moderation:Pepper"),
        Value(AnonymousIdentityRuntime.ModeEnvironmentVariable)
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
        => CreateCachedValidationReport(configuration, enforceProductionRules).Errors;

    internal static IReadOnlyList<string> ValidateCore(
        IConfiguration configuration,
        bool enforceProductionRules,
        ZkProdRuntimeReadiness zkProdReadiness)
        => CreateValidationReport(configuration, enforceProductionRules, zkProdReadiness).Errors;

    internal static bool HasSecurityCriticalStartupError(IReadOnlyList<string> errors)
        => errors.Any(IsSecurityCriticalStartupError);

    private static ProductionStartupValidationReport CreateCachedValidationReport(IConfiguration configuration, bool enforceProductionRules)
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        lock (CoreValidationCacheLock)
        {
            if (s_coreValidationCache is { } cached
                && ReferenceEquals(cached.Configuration, configuration)
                && cached.EnforceProductionRules == enforceProductionRules
                && cached.ExpiresAt > now
                && !cached.ReloadToken.HasChanged)
            {
                return cached.Report;
            }
        }

        ProductionStartupValidationReport report = CreateValidationReport(configuration, enforceProductionRules);
        IChangeToken reloadToken = configuration.GetReloadToken();
        lock (CoreValidationCacheLock)
        {
            s_coreValidationCache = new CoreValidationCacheEntry(
                configuration,
                enforceProductionRules,
                now.Add(CoreValidationCacheTtl),
                reloadToken,
                report);
        }

        return report;
    }

    internal static ProductionStartupValidationReport CreateValidationReport(
        IConfiguration configuration,
        bool enforceProductionRules,
        ZkProdRuntimeReadiness? zkProdReadiness = null)
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

            if (!isPresent && enforceProductionRules)
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
        string? powSigningKey = values["Security:Pow:SigningKey"];
        string? captchaSigningKey = values["Security:CaptchaV1:SigningKey"];
        string? recoveryKeyPepper = values["Security:RecoveryKeyPepper"];
        string? subjectHashPepper = values["AnonymousCredentialIssuer:SubjectHashPepper"];
        string? visitLogIpHashPepper = values["VisitLog:IpHashPepper"];
        string? regionIpHashKey = values["Moderation:RegionPolicy:IpHashKey"];
        string? moderationPepper = values["Moderation:Pepper"];
        string? anonymousIdentityMode = values[AnonymousIdentityRuntime.ModeEnvironmentVariable];

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

        ValidateIndependentSecuritySecret("Security:Pow:SigningKey", powSigningKey, jwtSecret, [], errors);
        ValidateIndependentSecuritySecret("Security:CaptchaV1:SigningKey", captchaSigningKey, jwtSecret, [], errors);
        ValidateIndependentSecuritySecret("Security:RecoveryKeyPepper", recoveryKeyPepper, jwtSecret, [], errors);
        ValidateIndependentSecuritySecret("AnonymousCredentialIssuer:SubjectHashPepper", subjectHashPepper, jwtSecret, DefaultSubjectHashPeppers, errors);
        ValidateIndependentSecuritySecret("VisitLog:IpHashPepper", visitLogIpHashPepper, jwtSecret, DefaultVisitLogIpHashPeppers, errors);
        ValidateIndependentSecuritySecret("Moderation:RegionPolicy:IpHashKey", regionIpHashKey, jwtSecret, [], errors);
        ValidateIndependentSecuritySecret("Moderation:Pepper", moderationPepper, jwtSecret, DefaultModerationPeppers, errors);

        ValidateRedisConnection("ConnectionStrings:Redis", redisConnection, enforceProductionRules, errors);
        ValidateRedisConnection("RedisOptions:Configuration", redisOptionsConnection, enforceProductionRules, errors);
        ValidateAllowedHosts(allowedHosts, seoBaseUrl, corsOrigins, fido2ServerDomain, fido2Origins, enforceProductionRules, errors);
        ValidateReverseProxyTrust(configuration, enforceProductionRules, errors);
        ValidateCorsOrigins(corsOrigins, enforceProductionRules, errors);
        ValidateSeoBaseUrl(seoBaseUrl, enforceProductionRules, errors);
        ValidateFido2Settings(fido2ServerDomain, fido2Origins, seoBaseUrl, corsOrigins, enforceProductionRules, errors);
        ValidateAuthCookieSettings(configuration, enforceProductionRules, errors);
        ValidateAnonymousIdentityMode(anonymousIdentityMode, enforceProductionRules, errors);
        ValidateAntiSpamHttpJsonProvider(configuration, enforceProductionRules, errors);
        ValidateZkProdSettings(configuration, enforceProductionRules, zkProdReadiness ?? ZkProdRuntimeReadiness.Missing, errors);

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

    private static void ValidateIndependentSecuritySecret(
        string key,
        string? value,
        string? jwtSecret,
        IReadOnlyCollection<string> defaultValues,
        List<string> errors)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return;
        }

        string trimmed = value.Trim();
        if (trimmed.Length < 32)
        {
            errors.Add($"{key} must be at least 32 characters.");
        }

        if (!string.IsNullOrWhiteSpace(jwtSecret) && string.Equals(trimmed, jwtSecret.Trim(), StringComparison.Ordinal))
        {
            errors.Add($"{key} must be configured independently and must not equal Jwt:SecretKey.");
        }

        if (defaultValues.Contains(trimmed, StringComparer.Ordinal))
        {
            errors.Add($"{key} must not use a development/template/default value.");
        }

        if (trimmed.Contains("CHANGE_ME", StringComparison.OrdinalIgnoreCase) ||
            trimmed.Contains("MUST_BE_OVERRIDDEN", StringComparison.OrdinalIgnoreCase) ||
            trimmed.Contains("replace-with", StringComparison.OrdinalIgnoreCase))
        {
            errors.Add($"{key} must not use a template placeholder.");
        }
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

    private static void ValidateAntiSpamHttpJsonProvider(IConfiguration configuration, bool enforceProductionRules, List<string> errors)
    {
        if (!enforceProductionRules)
        {
            return;
        }

        bool enabled = configuration.GetValue<bool>("Moderation:AntiSpamModel:Enabled");
        string? provider = configuration["Moderation:AntiSpamModel:Provider"];
        bool isHttpJsonProvider = string.Equals(provider, "http-json", StringComparison.OrdinalIgnoreCase)
            || string.Equals(provider, "http", StringComparison.OrdinalIgnoreCase);
        if (!enabled || !isHttpJsonProvider)
        {
            return;
        }

        bool externalAllowed = configuration.GetValue<bool>("Moderation:AntiSpamModel:AllowExternalProvider");
        bool externalReviewed = configuration.GetValue<bool>("Moderation:AntiSpamModel:ExternalProviderReviewed");
        if (!externalAllowed || !externalReviewed)
        {
            return;
        }

        const string endpointKey = "Moderation:AntiSpamModel:Providers:http-json:Endpoint";
        const string allowlistKey = "Moderation:AntiSpamModel:Providers:http-json:AllowedHosts";
        AntiSpamModerationService.AntiSpamProviderEndpointValidation validation =
            AntiSpamModerationService.ValidateHttpJsonProviderEndpointConfiguration(
                configuration[endpointKey],
                configuration[allowlistKey]);
        if (!validation.Allowed)
        {
            errors.Add($"{endpointKey} is not allowed for reviewed http-json anti-spam provider: {validation.Reason}.");
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

    private static void ValidateAuthCookieSettings(IConfiguration configuration, bool enforceProductionRules, List<string> errors)
    {
        if (!enforceProductionRules)
        {
            return;
        }

        if (configuration.GetValue<bool>("AuthCookies:AllowInsecureTransportCookies"))
        {
            errors.Add("AuthCookies:AllowInsecureTransportCookies must be false outside Development.");
        }

        if (configuration.GetValue<bool>("AuthCookies:AllowLegacyPlainCookieRead"))
        {
            errors.Add("AuthCookies:AllowLegacyPlainCookieRead must be false in production; production authentication only accepts __Host-* cookies.");
        }
    }

    private static void ValidateAnonymousIdentityMode(string? value, bool enforceProductionRules, List<string> errors)
    {
        if (!enforceProductionRules)
        {
            return;
        }

        if (!AnonymousIdentityModeEnabled(value))
        {
            errors.Add($"{AnonymousIdentityRuntime.ModeEnvironmentVariable} must be enabled in production so legacy sys_user admin roles cannot grant backend authority.");
        }
    }

    private static bool AnonymousIdentityModeEnabled(string? value)
        => string.Equals(value, "1", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "enabled", StringComparison.OrdinalIgnoreCase);

    private static void ValidateZkProdSettings(
        IConfiguration configuration,
        bool enforceProductionRules,
        ZkProdRuntimeReadiness readiness,
        List<string> errors)
    {
        if (!enforceProductionRules)
        {
            return;
        }

        ZkProdOptions options = ZkProdOptions.FromConfiguration(configuration);
        if (options.AllowDevVerifier)
        {
            errors.Add("AnonymousIdentity:ZkProd:AllowDevVerifier must be false in production.");
        }

        if (options.FallbackToLegacyAnonymous)
        {
            errors.Add("AnonymousIdentity:ZkProd:FallbackToLegacyAnonymous must be false in production.");
        }

        if (!options.Enabled)
        {
            return;
        }

        if (options.RequireNativeVerifier && !ZkProdOptions.IsNativeVerifierBackend(options.VerifierBackend))
        {
            errors.Add("AnonymousIdentity:ZkProd:VerifierBackend must be native_groth16 when native verifier is required.");
        }

        if (options.RequireNativeVerifier && !readiness.NativeVerifierConfigured)
        {
            errors.Add("AnonymousIdentity:ZkProd:Enabled requires a configured native verifier in production.");
        }

        if (options.RequireTrustedSetupVerified && !ZkProdPolicySnapshotFactory.IsTrustedSetupVerified(options, configuration))
        {
            errors.Add("AnonymousIdentity:ZkProd:Enabled requires trusted setup verification and a verifying key hash in production.");
        }

        if (options.RequireCredential && !options.CredentialReady)
        {
            errors.Add("AnonymousIdentity:ZkProd:Enabled requires circuit-native credential readiness in production.");
        }

        if (options.RequireCredential && options.CredentialReady && !readiness.CredentialIssuerConfigured)
        {
            errors.Add("AnonymousIdentity:ZkProd:CredentialReady requires a configured circuit-native issuer backend in production.");
        }

        if (!readiness.CredentialRootReady)
        {
            errors.Add("AnonymousIdentity:ZkProd:Enabled requires an anonymous credential root snapshot in production.");
        }
    }

    private static bool IsSecurityCriticalStartupError(string error)
        => error.Contains("Jwt:SecretKey", StringComparison.Ordinal)
            || error.Contains("Security:Pow:SigningKey", StringComparison.Ordinal)
            || error.Contains("Security:CaptchaV1:SigningKey", StringComparison.Ordinal)
            || error.Contains("Security:RecoveryKeyPepper", StringComparison.Ordinal)
            || error.Contains("AnonymousCredentialIssuer:SubjectHashPepper", StringComparison.Ordinal)
            || error.Contains("VisitLog:IpHashPepper", StringComparison.Ordinal)
            || error.Contains("Moderation:RegionPolicy:IpHashKey", StringComparison.Ordinal)
            || error.Contains("Moderation:Pepper", StringComparison.Ordinal)
            || error.Contains("AllowedHosts must not use wildcard", StringComparison.Ordinal)
            || error.Contains("ReverseProxy:KnownProxies or ReverseProxy:KnownNetworks", StringComparison.Ordinal)
            || error.Contains("CORS_ALLOWED_HOSTS origin must use HTTPS", StringComparison.Ordinal)
            || error.Contains("Seo:BaseUrl must use HTTPS", StringComparison.Ordinal)
            || error.Contains("Fido2:Origins origin must use HTTPS", StringComparison.Ordinal)
            || error.Contains("AnonymousIdentity:ZkProd:", StringComparison.Ordinal);

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
    IZkProofVerifier zkProofVerifier,
    IAnonymousCredentialRootReader rootReader,
    ICircuitNativeCredentialIssuer credentialIssuer,
    StartupRuntimeState runtimeState,
    ILogger<ProductionStartupValidationHostedService> logger) : IHostedService
{
    private const string TaskName = "productionStartupValidation";
    private const string AllowInsecureStartupKey = "FSUSBLOG_ALLOW_INSECURE_STARTUP";

    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (!environment.IsProduction())
        {
            runtimeState.ReportStartupTask(TaskName, "skipped", "非生产环境不强制执行生产启动校验");
            return Task.CompletedTask;
        }

        ProductionStartupValidationReport report = ProductionStartupValidator.CreateValidationReport(
            configuration,
            enforceProductionRules: true,
            new ZkProdRuntimeReadiness(
                zkProofVerifier.IsConfigured,
                HasReadyCredentialRoot(rootReader),
                credentialIssuer.IsConfigured));
        if (report.Errors.Count == 0)
        {
            runtimeState.ReportStartupTask(TaskName, "completed", "生产启动校验通过");
            return Task.CompletedTask;
        }

        string detail = string.Join("; ", report.Errors);
        if (configuration.GetValue<bool>(AllowInsecureStartupKey)
            && !ProductionStartupValidator.HasSecurityCriticalStartupError(report.Errors))
        {
            runtimeState.ReportStartupTask(TaskName, "degraded", detail);
            logger.LogCritical(
                "Production startup validation was bypassed by {BypassKey}=true. Errors: {Errors}",
                AllowInsecureStartupKey,
                detail);
            return Task.CompletedTask;
        }

        runtimeState.ReportStartupTask(TaskName, "failed", detail);
        logger.LogCritical("Production startup validation failed closed: {Errors}", detail);
        throw new ProductionStartupValidationException(report.Errors);
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private static bool HasReadyCredentialRoot(IAnonymousCredentialRootReader reader)
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        return reader.CurrentSnapshot.AcceptedRoots.Any(root =>
            root.GraceExpiresAtUtc > now &&
            !string.IsNullOrWhiteSpace(root.RootHash) &&
            !string.IsNullOrWhiteSpace(root.RevocationRootHash) &&
            !string.IsNullOrWhiteSpace(root.IssuerPublicKeyHash) &&
            (string.Equals(root.Status, AnonymousCredentialRootStatuses.Active, StringComparison.Ordinal) ||
             string.Equals(root.Status, AnonymousCredentialRootStatuses.Grace, StringComparison.Ordinal)));
    }
}
