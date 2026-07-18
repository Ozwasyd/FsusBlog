using System.Net;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>Identifies the purpose domain included when deriving a security-risk pseudonym.</summary>
public enum SecurityRiskIdentityDomain
{
    ClientIp,
    DeviceFingerprint,
    AccountSubject
}

/// <summary>Pairs a purpose-bound security-risk hash with the key epoch that produced it.</summary>
public readonly record struct SecurityRiskPseudonym(string Hash, int Epoch);

/// <summary>Creates rotating, domain-separated pseudonyms for sensitive risk identities.</summary>
public interface ISecurityRiskPseudonymizer
{
    /// <summary>Gets the active key epoch used for new risk records.</summary>
    int CurrentEpoch
    {
        get;
    }

    /// <summary>Creates the active-epoch pseudonym for a normalized identity in the requested domain.</summary>
    SecurityRiskPseudonym PseudonymizeCurrent(SecurityRiskIdentityDomain domain, string value);

    /// <summary>Returns current and temporarily accepted previous-epoch pseudonyms for read compatibility.</summary>
    IReadOnlyList<SecurityRiskPseudonym> PseudonymizeForRead(SecurityRiskIdentityDomain domain, string value);
}

/// <summary>Applies key rotation, normalization, and domain separation to persisted security-risk identities.</summary>
public sealed class SecurityRiskPseudonymizer : ISecurityRiskPseudonymizer
{
    public const string SectionName = "Security:RiskPseudonymization";
    public const string CurrentEpochKey = SectionName + ":CurrentEpoch";
    public const string CurrentKeyKey = SectionName + ":CurrentKey";
    public const string PreviousEpochKey = SectionName + ":PreviousEpoch";
    public const string PreviousKeyKey = SectionName + ":PreviousKey";
    public const string PreviousAcceptUntilUtcKey = SectionName + ":PreviousAcceptUntilUtc";
    private const int MinimumKeyBytes = 32;
    private static readonly TimeSpan s_maximumPreviousEpochWindow = TimeSpan.FromDays(90);

    private static readonly string[] s_independentSecretKeys =
    [
        "Jwt:SecretKey",
        "Security:Pow:SigningKey",
        "Security:CaptchaV1:SigningKey",
        "Security:RecoveryKeyPepper",
        "PublicAot:ManifestToken",
        "MfaChallenge:TicketSigningKey",
        "Audit:TamperEvidenceKey",
        "AnonymousCredentialIssuer:SubjectHashPepper",
        VisitLogIpPseudonymizer.CurrentKeyKey,
        VisitLogIpPseudonymizer.PreviousKeyKey,
        "Moderation:RegionPolicy:IpHashKey",
        "Moderation:Pepper",
        "Subscription:EmailHashPepper",
        "AnonymousIdentity:NullifierPepper",
        "AnonymousCredentialRoot:AttestationKey"
    ];

    private readonly SecurityRiskPseudonymizationKey _current;
    private readonly SecurityRiskPseudonymizationKey? _previous;
    private readonly TimeProvider _timeProvider;

    /// <inheritdoc />
    public int CurrentEpoch => _current.Epoch;

    /// <summary>Loads and validates the production-aware current and previous pseudonymization key ring.</summary>
    public SecurityRiskPseudonymizer(
        IConfiguration configuration,
        IWebHostEnvironment environment,
        TimeProvider timeProvider)
        : this(Load(configuration, environment.IsProduction(), timeProvider), timeProvider)
    {
    }

    internal SecurityRiskPseudonymizer(
        int currentEpoch,
        byte[] currentKey,
        int? previousEpoch = null,
        byte[]? previousKey = null,
        DateTimeOffset? previousAcceptUntilUtc = null,
        TimeProvider? timeProvider = null)
        : this(
            new SecurityRiskPseudonymizationKeyRing(
                new SecurityRiskPseudonymizationKey(currentEpoch, [.. currentKey], null),
                previousEpoch.HasValue && previousKey is not null
                    ? new SecurityRiskPseudonymizationKey(previousEpoch.Value, [.. previousKey], previousAcceptUntilUtc)
                    : null),
            timeProvider ?? TimeProvider.System)
    {
    }

    private SecurityRiskPseudonymizer(
        SecurityRiskPseudonymizationKeyRing keyRing,
        TimeProvider timeProvider)
    {
        _current = keyRing.Current;
        _previous = keyRing.Previous;
        _timeProvider = timeProvider;
    }

    /// <inheritdoc />
    public SecurityRiskPseudonym PseudonymizeCurrent(SecurityRiskIdentityDomain domain, string value)
        => Pseudonymize(_current, domain, Normalize(domain, value));

    /// <inheritdoc />
    public IReadOnlyList<SecurityRiskPseudonym> PseudonymizeForRead(SecurityRiskIdentityDomain domain, string value)
    {
        string normalized = Normalize(domain, value);
        SecurityRiskPseudonym current = Pseudonymize(_current, domain, normalized);
        if (_previous is not { } previous
            || previous.AcceptUntilUtc is not { } acceptUntil
            || _timeProvider.GetUtcNow() > acceptUntil)
        {
            return [current];
        }

        return [current, Pseudonymize(previous, domain, normalized)];
    }

    /// <summary>Validates key strength, epoch ordering, overlap lifetime, and independence from other application secrets.</summary>
    public static IReadOnlyList<string> ValidateConfiguration(
        IConfiguration configuration,
        bool enforceProductionRules,
        DateTimeOffset? now = null)
    {
        string currentKeyEncoded = (configuration[CurrentKeyKey] ?? string.Empty).Trim();
        string currentEpochEncoded = (configuration[CurrentEpochKey] ?? string.Empty).Trim();
        string previousKeyEncoded = (configuration[PreviousKeyKey] ?? string.Empty).Trim();
        string previousEpochEncoded = (configuration[PreviousEpochKey] ?? string.Empty).Trim();
        string previousAcceptUntilEncoded = (configuration[PreviousAcceptUntilUtcKey] ?? string.Empty).Trim();
        bool hasAnyConfiguration = currentKeyEncoded.Length > 0
            || currentEpochEncoded.Length > 0
            || previousKeyEncoded.Length > 0
            || previousEpochEncoded.Length > 0
            || previousAcceptUntilEncoded.Length > 0;
        if (!enforceProductionRules && !hasAnyConfiguration)
        {
            return [];
        }

        List<string> errors = [];
        if (!TryParsePositiveEpoch(currentEpochEncoded, out int currentEpoch))
        {
            errors.Add($"{CurrentEpochKey} must be a positive integer.");
        }

        if (!TryDecodeStrongKey(currentKeyEncoded, out _))
        {
            errors.Add($"{CurrentKeyKey} must be strong base64 key material of at least {MinimumKeyBytes} bytes.");
        }

        ValidateIndependentKey(configuration, CurrentKeyKey, currentKeyEncoded, errors);

        bool hasPrevious = previousKeyEncoded.Length > 0
            || previousEpochEncoded.Length > 0
            || previousAcceptUntilEncoded.Length > 0;
        if (hasPrevious)
        {
            if (!TryParsePositiveEpoch(previousEpochEncoded, out int previousEpoch))
            {
                errors.Add($"{PreviousEpochKey} must be a positive integer when a previous key is configured.");
            }
            else if (currentEpoch > 0 && previousEpoch >= currentEpoch)
            {
                errors.Add($"{PreviousEpochKey} must be lower than {CurrentEpochKey}.");
            }

            if (!TryDecodeStrongKey(previousKeyEncoded, out _))
            {
                errors.Add($"{PreviousKeyKey} must be strong base64 key material of at least {MinimumKeyBytes} bytes.");
            }

            if (string.Equals(currentKeyEncoded, previousKeyEncoded, StringComparison.Ordinal))
            {
                errors.Add($"{PreviousKeyKey} must not reuse {CurrentKeyKey}.");
            }

            ValidateIndependentKey(configuration, PreviousKeyKey, previousKeyEncoded, errors);
            bool hasExplicitUtcDesignator = previousAcceptUntilEncoded.EndsWith('Z')
                || previousAcceptUntilEncoded.EndsWith("+00:00", StringComparison.Ordinal);
            if (!hasExplicitUtcDesignator
                || !DateTimeOffset.TryParse(
                    previousAcceptUntilEncoded,
                    System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AssumeUniversal,
                    out DateTimeOffset acceptUntil)
                || acceptUntil.Offset != TimeSpan.Zero)
            {
                errors.Add($"{PreviousAcceptUntilUtcKey} must be an explicit UTC timestamp when a previous key is configured.");
            }
            else if (acceptUntil - (now ?? DateTimeOffset.UtcNow) > s_maximumPreviousEpochWindow)
            {
                errors.Add($"{PreviousAcceptUntilUtcKey} must not extend more than 90 days into the future.");
            }
        }

        return errors;
    }

    private static SecurityRiskPseudonymizationKeyRing Load(
        IConfiguration configuration,
        bool enforceProductionRules,
        TimeProvider timeProvider)
    {
        string currentKeyEncoded = (configuration[CurrentKeyKey] ?? string.Empty).Trim();
        string currentEpochEncoded = (configuration[CurrentEpochKey] ?? string.Empty).Trim();
        bool isUnconfiguredDevelopment = !enforceProductionRules
            && currentKeyEncoded.Length == 0
            && string.IsNullOrWhiteSpace(configuration[PreviousKeyKey]);
        if (isUnconfiguredDevelopment)
        {
            return new SecurityRiskPseudonymizationKeyRing(
                new SecurityRiskPseudonymizationKey(
                    int.TryParse(currentEpochEncoded, out int developmentEpoch) && developmentEpoch > 0
                        ? developmentEpoch
                        : 1,
                    RandomNumberGenerator.GetBytes(MinimumKeyBytes),
                    null),
                null);
        }

        IReadOnlyList<string> errors = ValidateConfiguration(
            configuration,
            enforceProductionRules,
            timeProvider.GetUtcNow());
        if (errors.Count > 0)
        {
            throw new InvalidOperationException("Security risk pseudonymization configuration invalid: " + string.Join("; ", errors));
        }

        _ = TryParsePositiveEpoch(currentEpochEncoded, out int currentEpoch);
        _ = TryDecodeStrongKey(currentKeyEncoded, out byte[] currentKey);
        SecurityRiskPseudonymizationKey? previous = null;
        if (!string.IsNullOrWhiteSpace(configuration[PreviousKeyKey]))
        {
            _ = TryParsePositiveEpoch(configuration[PreviousEpochKey], out int previousEpoch);
            _ = TryDecodeStrongKey(configuration[PreviousKeyKey], out byte[] previousKey);
            _ = DateTimeOffset.TryParse(
                configuration[PreviousAcceptUntilUtcKey],
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal,
                out DateTimeOffset previousAcceptUntilUtc);
            previous = new SecurityRiskPseudonymizationKey(previousEpoch, previousKey, previousAcceptUntilUtc);
        }

        return new SecurityRiskPseudonymizationKeyRing(
            new SecurityRiskPseudonymizationKey(currentEpoch, currentKey, null),
            previous);
    }

    private static SecurityRiskPseudonym Pseudonymize(
        SecurityRiskPseudonymizationKey key,
        SecurityRiskIdentityDomain domain,
        string normalized)
    {
        string domainName = domain switch
        {
            SecurityRiskIdentityDomain.ClientIp => "ip",
            SecurityRiskIdentityDomain.DeviceFingerprint => "device",
            SecurityRiskIdentityDomain.AccountSubject => "account",
            _ => throw new ArgumentOutOfRangeException(nameof(domain))
        };
        byte[] framed = Encoding.UTF8.GetBytes(
            $"security-risk/{domainName}/v1\0epoch:{key.Epoch}\0{normalized}");
        byte[] hash = HMACSHA256.HashData(key.Key, framed);
        return new SecurityRiskPseudonym(Convert.ToHexStringLower(hash), key.Epoch);
    }

    private static string Normalize(SecurityRiskIdentityDomain domain, string value)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            throw new ArgumentException("Security risk identity must not be empty.", nameof(value));
        }

        if (domain == SecurityRiskIdentityDomain.ClientIp && IPAddress.TryParse(normalized, out IPAddress? address))
        {
            if (address.IsIPv4MappedToIPv6)
            {
                address = address.MapToIPv4();
            }

            return address.ToString();
        }

        return domain == SecurityRiskIdentityDomain.AccountSubject
            ? normalized.ToLowerInvariant()
            : normalized;
    }

    private static void ValidateIndependentKey(
        IConfiguration configuration,
        string keyName,
        string encodedKey,
        List<string> errors)
    {
        if (encodedKey.Length == 0)
        {
            return;
        }

        foreach (string independentSecretKey in s_independentSecretKeys)
        {
            string other = (configuration[independentSecretKey] ?? string.Empty).Trim();
            if (other.Length > 0 && string.Equals(encodedKey, other, StringComparison.Ordinal))
            {
                errors.Add($"{keyName} must not reuse {independentSecretKey}.");
            }
        }

        string perceptionVersion = (configuration["Security:PerceptionSealedToken:CurrentKeyVersion"] ?? string.Empty).Trim();
        string perceptionKey = perceptionVersion.Length == 0
            ? string.Empty
            : (configuration[$"Security:PerceptionSealedToken:Keys:{perceptionVersion}"] ?? string.Empty).Trim();
        if (perceptionKey.Length > 0 && string.Equals(encodedKey, perceptionKey, StringComparison.Ordinal))
        {
            errors.Add($"{keyName} must not reuse the active PerceptionSealedToken key.");
        }
    }

    private static bool TryParsePositiveEpoch(string? value, out int epoch)
        => int.TryParse(
            (value ?? string.Empty).Trim(),
            System.Globalization.NumberStyles.None,
            System.Globalization.CultureInfo.InvariantCulture,
            out epoch)
            && epoch > 0;

    private static bool TryDecodeStrongKey(string? value, out byte[] key)
    {
        key = [];
        try
        {
            key = Convert.FromBase64String((value ?? string.Empty).Trim());
            if (key.Length < MinimumKeyBytes || key.Distinct().Take(12).Count() < 12)
            {
                return false;
            }

            string printable = Encoding.UTF8.GetString(key).ToLowerInvariant();
            return !printable.Contains("change-me", StringComparison.Ordinal)
                && !printable.Contains("changeme", StringComparison.Ordinal)
                && !printable.Contains("placeholder", StringComparison.Ordinal)
                && !printable.Contains("replace", StringComparison.Ordinal)
                && !printable.Contains("example", StringComparison.Ordinal);
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private sealed record SecurityRiskPseudonymizationKey(
        int Epoch,
        byte[] Key,
        DateTimeOffset? AcceptUntilUtc);

    private sealed record SecurityRiskPseudonymizationKeyRing(
        SecurityRiskPseudonymizationKey Current,
        SecurityRiskPseudonymizationKey? Previous);
}
