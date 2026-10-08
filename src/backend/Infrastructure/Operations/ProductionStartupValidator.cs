using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Privacy;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Security;

using Microsoft.AspNetCore.WebUtilities;
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
    private const int SchemaVersion = 21;
    private const int PerceptionSealedTokenKeyByteCount = 32;
    private static readonly TimeSpan s_coreValidationCacheTtl = TimeSpan.FromSeconds(15);
    private static readonly object s_coreValidationCacheLock = new();
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

    private static readonly string[] s_defaultJwtSecretHashes =
    [
        "sha256:8AE781617F18436996EC2FDDE2F601E24F737FDB607C5423A6140412F33D2E4A",
        "sha256:91445D22CD01562A9AB14D304FBFADE49F48C9E729E782855630A3DE79ACE275",
        "sha256:B9471D38BB8BAB7EA081015F342BFA2D8A4B87B448482D318200AB516175EAEE"
    ];

    private static readonly string[] s_defaultSubjectHashPeppers =
    [
        "MUST_BE_OVERRIDDEN_BY_ENV_VARIABLES",
        "replace-with-stable-random-subject-hash-pepper",
        "development-subject-hash-pepper-change-before-shared-use"
    ];

    private static readonly string[] s_defaultModerationPeppers =
    [
        "MUST_BE_OVERRIDDEN_BY_ENV_VARIABLES",
        "replace-with-stable-random-moderation-pepper",
        "development-moderation-pepper-change-before-shared-use"
    ];

    private static readonly string[] s_defaultSubscriptionEmailHashPeppers =
    [
        "MUST_BE_OVERRIDDEN_BY_ENV_VARIABLES",
        "replace-with-stable-random-subscription-email-hash-pepper",
        "development-subscription-email-hash-pepper-change-before-shared-use"
    ];

    private static readonly string[] s_defaultAnonymousNullifierPeppers =
    [
        "MUST_BE_OVERRIDDEN_BY_ENV_VARIABLES",
        "replace-with-stable-random-anonymous-nullifier-pepper",
        "development-anonymous-nullifier-pepper-change-before-shared-use"
    ];

    private static readonly string[] s_defaultAnonymousRootAttestationKeys =
    [
        "MUST_BE_OVERRIDDEN_BY_ENV_VARIABLES",
        "replace-with-stable-random-anonymous-root-attestation-key",
        "development-anonymous-root-attestation-key-change-before-shared-use"
    ];

    private static readonly string[] s_defaultMfaChallengeTicketSigningKeys =
    [
        "MUST_BE_OVERRIDDEN_BY_ENV_VARIABLES",
        "replace-with-independent-mfa-challenge-ticket-signing-key",
        "development-mfa-challenge-ticket-signing-key-change-before-shared-use"
    ];

    private static readonly string[] s_defaultHumanReadProofSigningKeys =
    [
        "YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8="
    ];

    private static readonly string[] s_defaultHumanReadProofDedupKeys =
    [
        "gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp8="
    ];

    private static readonly string[] s_defaultReadAnalyticsNoiseKeys =
    [
        "oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8="
    ];

    private static readonly RequiredSettingRule[] s_requiredSettings =
    [
        ConnectionString("DefaultConnection"),
        ConnectionString("Redis"),
        Value("RedisOptions:Configuration"),
        Value("Jwt:SecretKey"),
        Value("Jwt:KeyVersion"),
        Value("Jwt:RotationWindowDays"),
        Value("AllowedHosts"),
        Value("CORS_ALLOWED_HOSTS"),
        Value("Seo:BaseUrl"),
        Value("Fido2:ServerDomain"),
        new("Fido2:Origins", ReadOriginList),
        Value("Security:Pow:SigningKey"),
        Value(UserSessionPolicy.MaxActiveSessionsConfigurationKey),
        Value($"{PerceptionSealedTokenOptions.SectionName}:CurrentKeyVersion"),
        Value(SecurityRiskPseudonymizer.CurrentEpochKey),
        Value(SecurityRiskPseudonymizer.CurrentKeyKey),
        Value("Security:RecoveryKeyPepper"),
        Value("PublicAot:ManifestToken"),
        Value("MfaChallenge:TicketSigningKey"),
        Value("HumanReadProof:SigningKey"),
        Value("HumanReadProof:Dedup:CurrentKeyEpoch"),
        Value("HumanReadProof:Dedup:CurrentKey"),
        Value(ReadAnalyticsPrivacyPolicy.NoiseKeySetting),
        Value("Audit:TamperEvidenceKey"),
        Value("Audit:DetachedCheckpoint:Enabled"),
        Value("Audit:DetachedCheckpoint:DirectoryName"),
        Value("Audit:DetachedCheckpoint:IntervalSeconds"),
        Value("Audit:DetachedCheckpoint:MaxRecords"),
        Value("Audit:DetachedCheckpoint:CurrentKeyId"),
        Value("AnonymousCredentialIssuer:SubjectHashPepper"),
        Value(VisitLogIpPseudonymizer.CurrentEpochKey),
        Value(VisitLogIpPseudonymizer.CurrentKeyKey),
        Value("Moderation:RegionPolicy:IpHashKey"),
        Value("Moderation:Pepper"),
        Value("Subscription:EmailHashPepper"),
        Value(MessageAdminSessionAuditReference.KeyName),
        Value("AnonymousIdentity:NullifierPepper"),
        Value("AnonymousCredentialRoot:AttestationKey"),
        Value(DataProtectionKeyProtection.ModeKey),
        Value(DataProtectionKeyProtection.CurrentCertificatePathKey),
        Value(AnonymousIdentityRuntime.ModeEnvironmentVariable),
        Value(ActiveReleaseFenceAvailabilityPolicy.RefreshIntervalKey),
        Value(ActiveReleaseFenceAvailabilityPolicy.StaleThresholdKey)
    ];

    public static ProductionStartupValidationSchema CurrentSchema
    {
        get;
    } = new(
        SchemaVersion,
        s_requiredSettings.Select(static rule => rule.Key).ToArray(),
        s_defaultJwtSecretHashes);

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
        ZkCommentRuntimeReadiness zkProdReadiness)
        => CreateValidationReport(configuration, enforceProductionRules, zkProdReadiness).Errors;

    internal static bool HasSecurityCriticalStartupError(IReadOnlyList<string> errors)
        => errors.Any(IsSecurityCriticalStartupError);

    private static ProductionStartupValidationReport CreateCachedValidationReport(IConfiguration configuration, bool enforceProductionRules)
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        lock (s_coreValidationCacheLock)
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
        lock (s_coreValidationCacheLock)
        {
            s_coreValidationCache = new CoreValidationCacheEntry(
                configuration,
                enforceProductionRules,
                now.Add(s_coreValidationCacheTtl),
                reloadToken,
                report);
        }

        return report;
    }

    internal static ProductionStartupValidationReport CreateValidationReport(
        IConfiguration configuration,
        bool enforceProductionRules,
        ZkCommentRuntimeReadiness? zkProdReadiness = null)
    {
        List<string> errors = [];
        List<ProductionStartupValidationRequirement> requirements = new(s_requiredSettings.Length);
        Dictionary<string, string?> values = new(StringComparer.Ordinal);

        for (int i = 0; i < s_requiredSettings.Length; i++)
        {
            RequiredSettingRule rule = s_requiredSettings[i];
            string? value = rule.ReadValue(configuration);
            bool isPresent = !string.IsNullOrWhiteSpace(value);
            requirements.Add(new ProductionStartupValidationRequirement(rule.Key, isPresent));
            values[rule.Key] = value;

            if (!isPresent && enforceProductionRules)
            {
                errors.Add($"{rule.Key} is required.");
            }
        }

        ValidateLocalAuthFixtureSettings(configuration, enforceProductionRules, errors);
        AuditDetachedCheckpointRuntimeConfiguration.Validate(configuration, enforceProductionRules, errors);

        string? redisConnection = values["ConnectionStrings:Redis"];
        string? redisOptionsConnection = values["RedisOptions:Configuration"];
        string? jwtSecret = values["Jwt:SecretKey"];
        string? allowedHosts = values["AllowedHosts"];
        string? corsOrigins = values["CORS_ALLOWED_HOSTS"];
        string? seoBaseUrl = values["Seo:BaseUrl"];
        string? fido2ServerDomain = values["Fido2:ServerDomain"];
        string? fido2Origins = values["Fido2:Origins"];
        string? powSigningKey = values["Security:Pow:SigningKey"];
        string? recoveryKeyPepper = values["Security:RecoveryKeyPepper"];
        string? publicAotManifestToken = values["PublicAot:ManifestToken"];
        string? mfaChallengeTicketSigningKey = values["MfaChallenge:TicketSigningKey"];
        string? humanReadSigningKey = values["HumanReadProof:SigningKey"];
        string? humanReadDedupKey = values["HumanReadProof:Dedup:CurrentKey"];
        string? readAnalyticsNoiseKey = values[ReadAnalyticsPrivacyPolicy.NoiseKeySetting];
        string? visitLogPseudonymKey = values[VisitLogIpPseudonymizer.CurrentKeyKey];
        string? securityRiskPseudonymKey = values[SecurityRiskPseudonymizer.CurrentKeyKey];
        string? auditTamperEvidenceKey = values["Audit:TamperEvidenceKey"];
        string? subjectHashPepper = values["AnonymousCredentialIssuer:SubjectHashPepper"];
        string? regionIpHashKey = values["Moderation:RegionPolicy:IpHashKey"];
        string? moderationPepper = values["Moderation:Pepper"];
        string? subscriptionEmailHashPepper = values["Subscription:EmailHashPepper"];
        string? messageAdminSessionAuditReferenceKey = values[MessageAdminSessionAuditReference.KeyName];
        string? anonymousNullifierPepper = values["AnonymousIdentity:NullifierPepper"];
        string? anonymousRootAttestationKey = values["AnonymousCredentialRoot:AttestationKey"];
        string? anonymousIdentityMode = values[AnonymousIdentityRuntime.ModeEnvironmentVariable];

        if (!string.IsNullOrWhiteSpace(jwtSecret))
        {
            if (jwtSecret.Length < 32)
            {
                errors.Add("Jwt:SecretKey must be at least 32 characters.");
            }

            if (s_defaultJwtSecretHashes.Contains(ComputeSecretHash(jwtSecret), StringComparer.Ordinal))
            {
                errors.Add("Jwt:SecretKey must not use a development/template/default value.");
            }

            if (jwtSecret.Contains("CHANGE_ME", StringComparison.OrdinalIgnoreCase))
            {
                errors.Add("Jwt:SecretKey must not use a template placeholder.");
            }
        }

        if (enforceProductionRules || !string.IsNullOrWhiteSpace(jwtSecret))
        {
            JwtSettings jwtSettings = configuration.GetSection("Jwt").Get<JwtSettings>() ?? new JwtSettings();
            errors.AddRange(JwtSigningKeyRing.Validate(
                jwtSettings,
                enforceProductionRules,
                DateTimeOffset.UtcNow));
        }

        ValidateIndependentSecuritySecret("Security:Pow:SigningKey", powSigningKey, jwtSecret, [], errors);
        ValidateIndependentSecuritySecret("Security:RecoveryKeyPepper", recoveryKeyPepper, jwtSecret, [], errors);
        ValidateIndependentSecuritySecret("PublicAot:ManifestToken", publicAotManifestToken, jwtSecret, [], errors);
        ValidateIndependentSecuritySecret("MfaChallenge:TicketSigningKey", mfaChallengeTicketSigningKey, jwtSecret, s_defaultMfaChallengeTicketSigningKeys, errors);
        ValidateIndependentSecuritySecret("HumanReadProof:SigningKey", humanReadSigningKey, jwtSecret, s_defaultHumanReadProofSigningKeys, errors);
        ValidateIndependentSecuritySecret("HumanReadProof:Dedup:CurrentKey", humanReadDedupKey, jwtSecret, s_defaultHumanReadProofDedupKeys, errors);
        ValidateIndependentSecuritySecret(ReadAnalyticsPrivacyPolicy.NoiseKeySetting, readAnalyticsNoiseKey, jwtSecret, s_defaultReadAnalyticsNoiseKeys, errors);
        ValidateBase64Key("HumanReadProof:SigningKey", humanReadSigningKey, errors);
        ValidateBase64Key("HumanReadProof:Dedup:CurrentKey", humanReadDedupKey, errors);
        ValidateBase64Key(ReadAnalyticsPrivacyPolicy.NoiseKeySetting, readAnalyticsNoiseKey, errors);
        ValidateDistinctSecrets(
            [
                ("HumanReadProof:SigningKey", humanReadSigningKey),
                ("HumanReadProof:Dedup:CurrentKey", humanReadDedupKey),
                (ReadAnalyticsPrivacyPolicy.NoiseKeySetting, readAnalyticsNoiseKey),
                (VisitLogIpPseudonymizer.CurrentKeyKey, visitLogPseudonymKey),
                (SecurityRiskPseudonymizer.CurrentKeyKey, securityRiskPseudonymKey)
            ],
            errors);
        if (!int.TryParse(values["HumanReadProof:Dedup:CurrentKeyEpoch"], out int humanReadDedupEpoch)
            || humanReadDedupEpoch <= 0)
        {
            errors.Add("HumanReadProof:Dedup:CurrentKeyEpoch must be a positive integer.");
        }
        if (!string.IsNullOrWhiteSpace(readAnalyticsNoiseKey))
        {
            try
            {
                _ = new ReadAnalyticsPrivacyPolicy(configuration, TimeProvider.System);
            }
            catch (InvalidOperationException)
            {
                errors.Add("ReadAnalytics privacy policy configuration is invalid.");
            }
        }
        ValidateAuditTamperEvidenceKey(auditTamperEvidenceKey, jwtSecret, errors);
        ValidateIndependentSecuritySecret("AnonymousCredentialIssuer:SubjectHashPepper", subjectHashPepper, jwtSecret, s_defaultSubjectHashPeppers, errors);
        ValidateIndependentSecuritySecret("Moderation:RegionPolicy:IpHashKey", regionIpHashKey, jwtSecret, [], errors);
        ValidateIndependentSecuritySecret("Moderation:Pepper", moderationPepper, jwtSecret, s_defaultModerationPeppers, errors);
        ValidateIndependentSecuritySecret("Subscription:EmailHashPepper", subscriptionEmailHashPepper, jwtSecret, s_defaultSubscriptionEmailHashPeppers, errors);
        ValidateIndependentSecuritySecret(MessageAdminSessionAuditReference.KeyName, messageAdminSessionAuditReferenceKey, jwtSecret, [], errors);
        ValidateIndependentSecuritySecret("AnonymousIdentity:NullifierPepper", anonymousNullifierPepper, jwtSecret, s_defaultAnonymousNullifierPeppers, errors);
        ValidateIndependentSecuritySecret("AnonymousCredentialRoot:AttestationKey", anonymousRootAttestationKey, jwtSecret, s_defaultAnonymousRootAttestationKeys, errors);

        ValidateRedisConnection("ConnectionStrings:Redis", redisConnection, enforceProductionRules, errors);
        ValidateRedisConnection("RedisOptions:Configuration", redisOptionsConnection, enforceProductionRules, errors);
        ValidateAllowedHosts(allowedHosts, seoBaseUrl, corsOrigins, fido2ServerDomain, fido2Origins, enforceProductionRules, errors);
        ValidateReverseProxyTrust(configuration, enforceProductionRules, errors);
        ValidateCorsOrigins(corsOrigins, enforceProductionRules, errors);
        ValidateSeoBaseUrl(seoBaseUrl, enforceProductionRules, errors);
        ValidateFido2Settings(fido2ServerDomain, fido2Origins, seoBaseUrl, corsOrigins, enforceProductionRules, errors);
        ValidateAuthCookieSettings(configuration, enforceProductionRules, errors);
        ValidateUserSessionSettings(configuration, errors);
        ValidateStepUpSettings(configuration, errors);
        ValidateAccountEnrollmentSettings(configuration, errors);
        errors.AddRange(DataProtectionKeyProtection.ValidateConfiguration(configuration, enforceProductionRules));
        ValidateAnonymousIdentityMode(anonymousIdentityMode, enforceProductionRules, errors);
        ValidatePerceptionSealedTokenSettings(configuration, enforceProductionRules, errors);
        errors.AddRange(SecurityRiskPseudonymizer.ValidateConfiguration(
            configuration,
            enforceProductionRules,
            DateTimeOffset.UtcNow));
        errors.AddRange(VisitLogIpPseudonymizer.ValidateConfiguration(
            configuration,
            enforceProductionRules,
            DateTimeOffset.UtcNow));
        ValidateBuiltInAntiSpamRuntime(configuration, enforceProductionRules, errors);
        ValidateCrawlerRangeUrls(configuration, enforceProductionRules, errors);
        ValidateReleaseIdentity(configuration, enforceProductionRules, errors);
        ValidateActiveReleaseFenceSettings(configuration, enforceProductionRules, errors);
        ValidateZkProdSettings(configuration, enforceProductionRules, zkProdReadiness ?? ZkCommentRuntimeReadiness.Missing, errors);

        return new ProductionStartupValidationReport(SchemaVersion, enforceProductionRules, requirements, errors);
    }

    private static void ValidateReleaseIdentity(
        IConfiguration configuration,
        bool enforceProductionRules,
        List<string> errors)
    {
        ReleaseIdentitySnapshot snapshot = ReleaseIdentityProvider.Resolve(configuration);
        foreach (string error in ReleaseIdentityProvider.Validate(snapshot, enforceProductionRules))
        {
            errors.Add($"Release identity invalid: {error}.");
        }
    }

    private static void ValidateUserSessionSettings(IConfiguration configuration, List<string> errors)
    {
        int? configured = configuration.GetValue<int?>(UserSessionPolicy.MaxActiveSessionsConfigurationKey);
        if (configured is null
            || configured < UserSessionPolicy.MinimumMaxActiveSessions
            || configured > UserSessionPolicy.MaximumMaxActiveSessions)
        {
            errors.Add(
                $"{UserSessionPolicy.MaxActiveSessionsConfigurationKey} must be between "
                + $"{UserSessionPolicy.MinimumMaxActiveSessions} and {UserSessionPolicy.MaximumMaxActiveSessions}.");
        }

        int? metadataRetentionDays = configuration.GetValue<int?>(
            UserSessionMetadataRetentionPolicy.RetentionDaysConfigurationKey);
        if (metadataRetentionDays is not null
            && (metadataRetentionDays < UserSessionMetadataRetentionPolicy.MinimumRetentionDays
                || metadataRetentionDays > UserSessionMetadataRetentionPolicy.MaximumRetentionDays))
        {
            errors.Add(
                $"{UserSessionMetadataRetentionPolicy.RetentionDaysConfigurationKey} must be between "
                + $"{UserSessionMetadataRetentionPolicy.MinimumRetentionDays} and "
                + $"{UserSessionMetadataRetentionPolicy.MaximumRetentionDays}.");
        }
    }

    private static void ValidateAccountEnrollmentSettings(IConfiguration configuration, List<string> errors)
    {
        int? provisionalTtl = configuration.GetValue<int?>("AuthEnrollment:ProvisionalTtlMinutes");
        if (provisionalTtl is null or < 15 or > 30)
        {
            errors.Add("AuthEnrollment:ProvisionalTtlMinutes must be between 15 and 30.");
        }

        int? cleanupInterval = configuration.GetValue<int?>("AuthEnrollment:CleanupIntervalMinutes");
        if (cleanupInterval is null or < 1 or > 30)
        {
            errors.Add("AuthEnrollment:CleanupIntervalMinutes must be between 1 and 30.");
        }
    }

    private static void ValidateStepUpSettings(IConfiguration configuration, List<string> errors)
    {
        int? configured = configuration.GetValue<int?>(MfaChallengeService.ProofFreshnessMinutesConfigurationKey);
        if (configured is null
            || configured < MfaChallengeService.MinimumProofFreshnessMinutes
            || configured > MfaChallengeService.MaximumProofFreshnessMinutes)
        {
            errors.Add(
                $"{MfaChallengeService.ProofFreshnessMinutesConfigurationKey} must be between "
                + $"{MfaChallengeService.MinimumProofFreshnessMinutes} and {MfaChallengeService.MaximumProofFreshnessMinutes}.");
        }
    }

    private static void ValidateActiveReleaseFenceSettings(
        IConfiguration configuration,
        bool enforceProductionRules,
        List<string> errors)
    {
        if (enforceProductionRules
            && configuration.GetValue(ActiveReleaseFenceAvailabilityPolicy.AllowSyntheticLocalFenceKey, false))
        {
            errors.Add($"{ActiveReleaseFenceAvailabilityPolicy.AllowSyntheticLocalFenceKey} must be false outside Development.");
        }

        if (!enforceProductionRules)
        {
            return;
        }

        bool refreshValid = int.TryParse(
            configuration[ActiveReleaseFenceAvailabilityPolicy.RefreshIntervalKey],
            out int refreshIntervalMs)
            && refreshIntervalMs is >= ActiveReleaseFenceAvailabilityPolicy.MinimumRefreshIntervalMs
                and <= ActiveReleaseFenceAvailabilityPolicy.MaximumRefreshIntervalMs;
        if (!refreshValid)
        {
            errors.Add(
                $"{ActiveReleaseFenceAvailabilityPolicy.RefreshIntervalKey} must be an integer between "
                + $"{ActiveReleaseFenceAvailabilityPolicy.MinimumRefreshIntervalMs} and "
                + $"{ActiveReleaseFenceAvailabilityPolicy.MaximumRefreshIntervalMs}.");
        }

        bool staleValid = int.TryParse(
            configuration[ActiveReleaseFenceAvailabilityPolicy.StaleThresholdKey],
            out int staleThresholdSeconds)
            && staleThresholdSeconds is >= ActiveReleaseFenceAvailabilityPolicy.MinimumStaleThresholdSeconds
                and <= ActiveReleaseFenceAvailabilityPolicy.MaximumStaleThresholdSeconds;
        if (!staleValid)
        {
            errors.Add(
                $"{ActiveReleaseFenceAvailabilityPolicy.StaleThresholdKey} must be an integer between "
                + $"{ActiveReleaseFenceAvailabilityPolicy.MinimumStaleThresholdSeconds} and "
                + $"{ActiveReleaseFenceAvailabilityPolicy.MaximumStaleThresholdSeconds}.");
        }

        if (refreshValid
            && staleValid
            && TimeSpan.FromSeconds(staleThresholdSeconds) < TimeSpan.FromMilliseconds(refreshIntervalMs))
        {
            errors.Add(
                $"{ActiveReleaseFenceAvailabilityPolicy.StaleThresholdKey} must not be shorter than "
                + $"{ActiveReleaseFenceAvailabilityPolicy.RefreshIntervalKey}.");
        }
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

    private static void ValidateBase64Key(string key, string? value, List<string> errors)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return;
        }

        try
        {
            if (Convert.FromBase64String(value.Trim()).Length >= 32)
            {
                return;
            }
        }
        catch (FormatException)
        {
        }

        errors.Add($"{key} must be base64 key material of at least 32 bytes.");
    }

    private static void ValidateDistinctSecrets(
        IReadOnlyList<(string Key, string? Value)> secrets,
        List<string> errors)
    {
        for (int i = 0; i < secrets.Count; i++)
        {
            if (string.IsNullOrWhiteSpace(secrets[i].Value))
            {
                continue;
            }

            for (int j = i + 1; j < secrets.Count; j++)
            {
                if (!string.IsNullOrWhiteSpace(secrets[j].Value)
                    && string.Equals(secrets[i].Value!.Trim(), secrets[j].Value!.Trim(), StringComparison.Ordinal))
                {
                    errors.Add($"{secrets[i].Key} and {secrets[j].Key} must use independent key material.");
                }
            }
        }
    }

    private static void ValidateAuditTamperEvidenceKey(string? value, string? jwtSecret, List<string> errors)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return;
        }

        string trimmed = value.Trim();
        if (!AuditTamperEvidence.TryValidateKeyMaterial(trimmed, out string error))
        {
            errors.Add(error);
        }

        if (!string.IsNullOrWhiteSpace(jwtSecret) && string.Equals(trimmed, jwtSecret.Trim(), StringComparison.Ordinal))
        {
            errors.Add("Audit:TamperEvidenceKey must be configured independently and must not equal Jwt:SecretKey.");
        }
    }

    private static void ValidatePerceptionSealedTokenSettings(
        IConfiguration configuration,
        bool enforceProductionRules,
        List<string> errors)
    {
        if (!enforceProductionRules)
        {
            return;
        }

        const string SectionName = PerceptionSealedTokenOptions.SectionName;
        string currentKeyVersion = (configuration[$"{SectionName}:CurrentKeyVersion"] ?? string.Empty).Trim();
        if (currentKeyVersion.Length == 0)
        {
            return;
        }

        IConfigurationSection keysSection = configuration.GetSection($"{SectionName}:Keys");
        if (!keysSection.GetChildren().Any(static child => !string.IsNullOrWhiteSpace(child.Key)))
        {
            errors.Add($"{SectionName}:Keys must contain at least one signing key.");
            return;
        }

        string currentKeyPath = $"{SectionName}:Keys:{currentKeyVersion}";
        string? currentKey = configuration[currentKeyPath];
        if (string.IsNullOrWhiteSpace(currentKey))
        {
            errors.Add($"{SectionName}:CurrentKeyVersion '{currentKeyVersion}' must reference configured {currentKeyPath}.");
            return;
        }

        if (!TryDecodePerceptionSealedTokenKey(currentKey, out _))
        {
            errors.Add($"{currentKeyPath} must be a 32-byte hex/base64/base64url key.");
        }
    }

    private static bool TryDecodePerceptionSealedTokenKey(string? encodedKey, out byte[] key)
    {
        key = [];
        string value = (encodedKey ?? string.Empty).Trim();
        if (value.Length == 0)
        {
            return false;
        }

        if (value.StartsWith("hex:", StringComparison.OrdinalIgnoreCase))
        {
            return TryDecodeHexPerceptionSealedTokenKey(value[4..], out key);
        }

        if (value.StartsWith("base64:", StringComparison.OrdinalIgnoreCase))
        {
            return TryDecodeBase64PerceptionSealedTokenKey(value[7..], out key);
        }

        if (value.StartsWith("base64url:", StringComparison.OrdinalIgnoreCase))
        {
            return TryDecodeBase64UrlPerceptionSealedTokenKey(value[10..], out key);
        }

        return value.Length == PerceptionSealedTokenKeyByteCount * 2 && value.All(Uri.IsHexDigit)
            ? TryDecodeHexPerceptionSealedTokenKey(value, out key)
            : TryDecodeBase64PerceptionSealedTokenKey(value, out key)
                || TryDecodeBase64UrlPerceptionSealedTokenKey(value, out key);
    }

    private static bool TryDecodeHexPerceptionSealedTokenKey(string value, out byte[] key)
    {
        key = [];
        try
        {
            key = Convert.FromHexString(value);
        }
        catch (FormatException)
        {
            return false;
        }

        return key.Length == PerceptionSealedTokenKeyByteCount;
    }

    private static bool TryDecodeBase64PerceptionSealedTokenKey(string value, out byte[] key)
    {
        key = [];
        try
        {
            key = Convert.FromBase64String(value);
        }
        catch (FormatException)
        {
            return false;
        }

        return key.Length == PerceptionSealedTokenKeyByteCount;
    }

    private static bool TryDecodeBase64UrlPerceptionSealedTokenKey(string value, out byte[] key)
    {
        key = [];
        try
        {
            key = WebEncoders.Base64UrlDecode(value);
        }
        catch (FormatException)
        {
            return false;
        }

        return key.Length == PerceptionSealedTokenKeyByteCount;
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

    private static void ValidateBuiltInAntiSpamRuntime(IConfiguration configuration, bool enforceProductionRules, List<string> errors)
    {
        if (!enforceProductionRules)
        {
            return;
        }

        bool enabled = configuration.GetValue<bool>("Moderation:AntiSpamModel:Enabled");
        if (!enabled)
        {
            return;
        }

        Result<FsusAntiSpamModelRuntimeSnapshot> loaded = FsusAntiSpamModelRuntimeLoader.TryLoad(
            configuration["Moderation:AntiSpamModel:RuntimePath"],
            new FsusAntiSpamModelRuntimeLoadOptions(
                RequireSignature: true,
                TrustedSigningKey: configuration["Moderation:AntiSpamModel:TrustedSigningKey"],
                Channel: configuration["Moderation:AntiSpamModel:RuntimeChannel"] ?? "stable"));
        if (loaded.IsFailure)
        {
            errors.Add($"Moderation:AntiSpamModel:RuntimePath failed built-in FsusAntiSpamModel runtime validation: {loaded.Error.Message}.");
        }
    }

    private static void ValidateCrawlerRangeUrls(IConfiguration configuration, bool enforceProductionRules, List<string> errors)
    {
        if (!enforceProductionRules)
        {
            return;
        }

        ValidateCrawlerRangeUrl(configuration, "Security:CrawlerCidrs:GoogleUrl", errors);
        ValidateCrawlerRangeUrl(configuration, "Security:CrawlerCidrs:BingUrl", errors);
    }

    private static void ValidateLocalAuthFixtureSettings(IConfiguration configuration, bool enforceProductionRules, List<string> errors)
    {
        if (enforceProductionRules && configuration.GetValue<bool>(LocalAuthFixtureEndpoints.AllowLocalAuthFixtureConfigurationKey))
        {
            errors.Add("fsus:allowLocalAuthFixture must be false outside Development.");
        }

        if (enforceProductionRules
            && configuration.GetValue<bool>(LocalAccountProfilePreferenceFixtureEndpoints.AllowConfigurationKey))
        {
            errors.Add("fsus:allowAccountProfilePreferenceFixture must be false outside Development.");
        }

        if (enforceProductionRules
            && configuration.GetValue<bool>(LocalPublicContentFixtureEndpoints.AllowLocalPublicContentFixtureConfigurationKey))
        {
            errors.Add("fsus:allowLocalPublicContentFixture must be false outside Development.");
        }

        if (enforceProductionRules
            && configuration.GetValue<bool>(LocalDemoFixtureEndpoints.AllowLocalDemoFixtureConfigurationKey))
        {
            errors.Add("fsus:allowLocalDemoFixture must be false outside Development.");
        }

        if (enforceProductionRules
            && configuration.GetValue<bool>(LocalDemoFixtureEndpoints.AllowLocalDemoFixtureCleanupConfigurationKey))
        {
            errors.Add("fsus:allowLocalDemoFixtureCleanup must be false outside Development.");
        }

        if (enforceProductionRules
            && configuration.GetValue<bool>(LocalSecurityFixtureEndpoints.AllowLocalSecurityFixtureConfigurationKey))
        {
            errors.Add("fsus:allowLocalSecurityFixture must be false outside Development.");
        }
    }

    private static void ValidateCrawlerRangeUrl(IConfiguration configuration, string key, List<string> errors)
    {
        if (!CrawlerRangeUrlPolicy.TryValidateConfiguredUrl(configuration[key], out string error))
        {
            errors.Add($"{key} must be an HTTPS URL hosted by developers.google.com or www.bing.com: {error}.");
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
        ZkCommentRuntimeReadiness readiness,
        List<string> errors)
    {
        ZkCommentPolicyOptions options;
        try
        {
            options = ZkCommentPolicyOptions.FromConfiguration(configuration);
            _ = ZkVerifierOptions.FromConfiguration(configuration);
        }
        catch (InvalidOperationException exception)
        {
            errors.Add(exception.Message);
            return;
        }

        if (!enforceProductionRules || !options.Enabled) return;
        if (!readiness.NativeBackendConfigured)
        {
            errors.Add("AnonymousIdentity:ZkVerifier:Backend must be native_groth16 for ZK comments in production.");
        }

        if (!readiness.NativeVerifierConfigured)
        {
            errors.Add("AnonymousIdentity:ZkCommentPolicy:Enabled requires a configured native verifier in production.");
        }

        if (options.RequireTrustedSetupVerified && !readiness.TrustedSetupVerified)
        {
            errors.Add("AnonymousIdentity:ZkCommentPolicy:Enabled requires verified trusted setup and verifying-key manifests and a verifying key hash in production.");
        }

        if (options.RequireCredential && !readiness.CredentialIssuerConfigured)
        {
            errors.Add("AnonymousIdentity:ZkCommentPolicy:Enabled requires a configured RFC 9474 blind issuer in production.");
        }

        if (!readiness.CredentialRootReady)
        {
            errors.Add("AnonymousIdentity:ZkCommentPolicy:Enabled requires an anonymous credential root snapshot in production.");
        }
    }

    private static bool IsSecurityCriticalStartupError(string error)
        => error.Contains("Jwt:", StringComparison.Ordinal)
            || error.Contains("Security:Pow:SigningKey", StringComparison.Ordinal)
            || error.Contains("Security:RecoveryKeyPepper", StringComparison.Ordinal)
            || error.Contains("MfaChallenge:TicketSigningKey", StringComparison.Ordinal)
            || error.Contains("AnonymousCredentialIssuer:SubjectHashPepper", StringComparison.Ordinal)
            || error.Contains(VisitLogIpPseudonymizer.SectionName, StringComparison.Ordinal)
            || error.Contains("Moderation:RegionPolicy:IpHashKey", StringComparison.Ordinal)
            || error.Contains("Moderation:Pepper", StringComparison.Ordinal)
            || error.Contains("DataProtection:", StringComparison.Ordinal)
            || error.Contains("AllowedHosts must not use wildcard", StringComparison.Ordinal)
            || error.Contains("ReverseProxy:KnownProxies or ReverseProxy:KnownNetworks", StringComparison.Ordinal)
            || error.Contains("CORS_ALLOWED_HOSTS origin must use HTTPS", StringComparison.Ordinal)
            || error.Contains("Seo:BaseUrl must use HTTPS", StringComparison.Ordinal)
            || error.Contains("Fido2:Origins origin must use HTTPS", StringComparison.Ordinal)
            || error.Contains("AnonymousIdentity:ZkCommentPolicy", StringComparison.Ordinal)
            || error.Contains("AnonymousIdentity:ZkVerifier", StringComparison.Ordinal)
            || error.Contains("AnonymousIdentity:ZkProd", StringComparison.Ordinal)
            || error.Contains("ActiveReleaseFence:", StringComparison.Ordinal);

    private static string ComputeSecretHash(string value)
        => "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

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
    IZkVerifierReadiness zkVerifierReadiness,
    IAnonymousCredentialRootReader rootReader,
    IRfc9474BlindCredentialSigner credentialIssuer,
    IBlindCredentialRuntimeGate blindCredentialRuntimeGate,
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
            new ZkCommentRuntimeReadiness(
                zkVerifierReadiness.Current.NativeVerifierConfigured,
                HasReadyCredentialRoot(rootReader),
                credentialIssuer.IsConfigured && blindCredentialRuntimeGate.IsEnabled,
                zkVerifierReadiness.Current.TrustedSetupVerified,
                zkVerifierReadiness.Current.NativeBackendConfigured));
        if (report.Errors.Count == 0)
        {
            runtimeState.ReportStartupTask(TaskName, "completed", "生产启动校验通过");
            return Task.CompletedTask;
        }

        string detail = $"production_startup_validation_failed:{report.Errors.Count}";
        if (configuration.GetValue<bool>(AllowInsecureStartupKey)
            && !ProductionStartupValidator.HasSecurityCriticalStartupError(report.Errors))
        {
            runtimeState.ReportStartupTask(TaskName, "degraded", detail);
            logger.LogCritical(
                "Production startup validation was bypassed by {BypassKey}=true. ErrorCount={ErrorCount}",
                AllowInsecureStartupKey,
                report.Errors.Count);
            return Task.CompletedTask;
        }

        runtimeState.ReportStartupTask(TaskName, "failed", detail);
        logger.LogCritical("Production startup validation failed closed. ErrorCount={ErrorCount}", report.Errors.Count);
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
