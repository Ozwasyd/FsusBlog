using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Infrastructure.Security;

public enum VisitLogIpPseudonymScope
{
    Analytics,
    SecurityLog
}

public readonly record struct VisitLogIpPseudonym(string Hash, int KeyEpoch, int WindowUtc);

public interface IVisitLogIpPseudonymizer
{
    int CurrentEpoch { get; }

    VisitLogIpPseudonym PseudonymizeCurrent(
        VisitLogIpPseudonymScope scope,
        string ip,
        DateTimeOffset occurredAt);

    IReadOnlyList<VisitLogIpPseudonym> PseudonymizeForRead(
        VisitLogIpPseudonymScope scope,
        string ip,
        DateTimeOffset occurredAt);
}

/// <summary>
/// Produces short-lived, purpose-bound IP pseudonyms. The configured keys are
/// independent KMS/secret-manager material and must never reuse an application
/// signing key or the security-risk pseudonymization key.
/// </summary>
public sealed class VisitLogIpPseudonymizer : IVisitLogIpPseudonymizer
{
    public const string SectionName = "VisitLog:IpPseudonymization";
    public const string CurrentEpochKey = SectionName + ":CurrentEpoch";
    public const string CurrentKeyKey = SectionName + ":CurrentKey";
    public const string PreviousEpochKey = SectionName + ":PreviousEpoch";
    public const string PreviousKeyKey = SectionName + ":PreviousKey";
    public const string PreviousAcceptUntilUtcKey = SectionName + ":PreviousAcceptUntilUtc";
    public const string LegacyPepperKey = "VisitLog:IpHashPepper";

    private const int MinimumKeyBytes = 32;
    private const int TruncatedHashBytes = 16;
    private static readonly TimeSpan MaximumPreviousEpochWindow = TimeSpan.FromDays(31);
    private static readonly string[] IndependentSecretKeys =
    [
        "Jwt:SecretKey",
        "Security:Pow:SigningKey",
        "Security:CaptchaV1:SigningKey",
        "Security:RecoveryKeyPepper",
        "PublicAot:ManifestToken",
        "MfaChallenge:TicketSigningKey",
        "Audit:TamperEvidenceKey",
        "AnonymousCredentialIssuer:SubjectHashPepper",
        SecurityRiskPseudonymizer.CurrentKeyKey,
        SecurityRiskPseudonymizer.PreviousKeyKey,
        "Moderation:RegionPolicy:IpHashKey",
        "Moderation:Pepper",
        "Subscription:EmailHashPepper",
        "AnonymousIdentity:NullifierPepper",
        "AnonymousCredentialRoot:AttestationKey"
    ];

    private readonly VisitLogIpKey _current;
    private readonly VisitLogIpKey? _previous;
    private readonly TimeProvider _timeProvider;

    public int CurrentEpoch => _current.Epoch;

    public VisitLogIpPseudonymizer(
        IConfiguration configuration,
        IWebHostEnvironment environment,
        TimeProvider timeProvider)
        : this(Load(configuration, environment.IsProduction(), timeProvider), timeProvider)
    {
    }

    internal VisitLogIpPseudonymizer(
        IConfiguration configuration,
        bool enforceProductionRules,
        TimeProvider timeProvider)
        : this(Load(configuration, enforceProductionRules, timeProvider), timeProvider)
    {
    }

    internal VisitLogIpPseudonymizer(
        int currentEpoch,
        byte[] currentKey,
        int? previousEpoch = null,
        byte[]? previousKey = null,
        DateTimeOffset? previousAcceptUntilUtc = null,
        TimeProvider? timeProvider = null)
        : this(
            new VisitLogIpKeyRing(
                new VisitLogIpKey(currentEpoch, [.. currentKey], null),
                previousEpoch.HasValue && previousKey is not null
                    ? new VisitLogIpKey(previousEpoch.Value, [.. previousKey], previousAcceptUntilUtc)
                    : null),
            timeProvider ?? TimeProvider.System)
    {
    }

    private VisitLogIpPseudonymizer(VisitLogIpKeyRing keyRing, TimeProvider timeProvider)
    {
        _current = keyRing.Current;
        _previous = keyRing.Previous;
        _timeProvider = timeProvider;
    }

    public VisitLogIpPseudonym PseudonymizeCurrent(
        VisitLogIpPseudonymScope scope,
        string ip,
        DateTimeOffset occurredAt)
        => Pseudonymize(_current, scope, NormalizeIp(ip), occurredAt);

    public IReadOnlyList<VisitLogIpPseudonym> PseudonymizeForRead(
        VisitLogIpPseudonymScope scope,
        string ip,
        DateTimeOffset occurredAt)
    {
        string normalized = NormalizeIp(ip);
        VisitLogIpPseudonym current = Pseudonymize(_current, scope, normalized, occurredAt);
        if (_previous is not { } previous
            || previous.AcceptUntilUtc is not { } acceptUntil
            || _timeProvider.GetUtcNow() > acceptUntil)
        {
            return [current];
        }

        return [current, Pseudonymize(previous, scope, normalized, occurredAt)];
    }

    public static IReadOnlyList<string> ValidateConfiguration(
        IConfiguration configuration,
        bool enforceProductionRules,
        DateTimeOffset? now = null)
    {
        string currentKeyEncoded = Value(configuration, CurrentKeyKey);
        string currentEpochEncoded = Value(configuration, CurrentEpochKey);
        string previousKeyEncoded = Value(configuration, PreviousKeyKey);
        string previousEpochEncoded = Value(configuration, PreviousEpochKey);
        string previousAcceptUntilEncoded = Value(configuration, PreviousAcceptUntilUtcKey);
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
        if (Value(configuration, LegacyPepperKey).Length > 0)
        {
            errors.Add($"{LegacyPepperKey} is retired; remove it after configuring {CurrentKeyKey}.");
        }

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
            bool explicitUtc = previousAcceptUntilEncoded.EndsWith('Z')
                || previousAcceptUntilEncoded.EndsWith("+00:00", StringComparison.Ordinal);
            if (!explicitUtc
                || !DateTimeOffset.TryParse(
                    previousAcceptUntilEncoded,
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal,
                    out DateTimeOffset acceptUntil)
                || acceptUntil.Offset != TimeSpan.Zero)
            {
                errors.Add($"{PreviousAcceptUntilUtcKey} must be an explicit UTC timestamp when a previous key is configured.");
            }
            else if (acceptUntil - (now ?? DateTimeOffset.UtcNow) > MaximumPreviousEpochWindow)
            {
                errors.Add($"{PreviousAcceptUntilUtcKey} must not extend more than 31 days into the future.");
            }
        }

        return errors;
    }

    private static VisitLogIpKeyRing Load(
        IConfiguration configuration,
        bool enforceProductionRules,
        TimeProvider timeProvider)
    {
        string currentKeyEncoded = Value(configuration, CurrentKeyKey);
        string currentEpochEncoded = Value(configuration, CurrentEpochKey);
        bool unconfiguredDevelopment = !enforceProductionRules
            && currentKeyEncoded.Length == 0
            && Value(configuration, PreviousKeyKey).Length == 0;
        if (unconfiguredDevelopment)
        {
            return new VisitLogIpKeyRing(
                new VisitLogIpKey(
                    TryParsePositiveEpoch(currentEpochEncoded, out int developmentEpoch) ? developmentEpoch : 1,
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
            throw new InvalidOperationException("Visit-log IP pseudonymization configuration invalid: " + string.Join("; ", errors));
        }

        _ = TryParsePositiveEpoch(currentEpochEncoded, out int currentEpoch);
        _ = TryDecodeStrongKey(currentKeyEncoded, out byte[] currentKey);
        VisitLogIpKey? previous = null;
        if (Value(configuration, PreviousKeyKey).Length > 0)
        {
            _ = TryParsePositiveEpoch(configuration[PreviousEpochKey], out int previousEpoch);
            _ = TryDecodeStrongKey(configuration[PreviousKeyKey], out byte[] previousKey);
            _ = DateTimeOffset.TryParse(
                configuration[PreviousAcceptUntilUtcKey],
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out DateTimeOffset previousAcceptUntilUtc);
            previous = new VisitLogIpKey(previousEpoch, previousKey, previousAcceptUntilUtc);
        }

        return new VisitLogIpKeyRing(new VisitLogIpKey(currentEpoch, currentKey, null), previous);
    }

    private static VisitLogIpPseudonym Pseudonymize(
        VisitLogIpKey key,
        VisitLogIpPseudonymScope scope,
        string normalizedIp,
        DateTimeOffset occurredAt)
    {
        DateTimeOffset utc = occurredAt.ToUniversalTime();
        int windowUtc = utc.Year * 10000 + utc.Month * 100 + utc.Day;
        string scopeName = scope switch
        {
            VisitLogIpPseudonymScope.Analytics => "analytics",
            VisitLogIpPseudonymScope.SecurityLog => "security-log",
            _ => throw new ArgumentOutOfRangeException(nameof(scope))
        };

        byte[] derivationContext = Encoding.UTF8.GetBytes(
            $"visit-log/ip-key/v2\0scope:{scopeName}\0epoch:{key.Epoch}\0window:{windowUtc}");
        byte[] scopedWindowKey = HMACSHA256.HashData(key.Key, derivationContext);
        try
        {
            byte[] framedIp = Encoding.UTF8.GetBytes($"visit-log/ip/v2\0{normalizedIp}");
            byte[] fullHash = HMACSHA256.HashData(scopedWindowKey, framedIp);
            return new VisitLogIpPseudonym(
                Convert.ToHexStringLower(fullHash.AsSpan(0, TruncatedHashBytes)),
                key.Epoch,
                windowUtc);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(scopedWindowKey);
        }
    }

    private static string NormalizeIp(string ip)
    {
        string normalized = (ip ?? string.Empty).Trim();
        if (!IPAddress.TryParse(normalized, out IPAddress? address))
        {
            throw new ArgumentException("Visit-log IP must be a valid address.", nameof(ip));
        }

        if (address.IsIPv4MappedToIPv6)
        {
            address = address.MapToIPv4();
        }

        return address.ToString();
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

        foreach (string otherKey in IndependentSecretKeys)
        {
            if (string.Equals(encodedKey, Value(configuration, otherKey), StringComparison.Ordinal))
            {
                errors.Add($"{keyName} must not reuse {otherKey}.");
            }
        }
    }

    private static bool TryParsePositiveEpoch(string? value, out int epoch)
        => int.TryParse(
            (value ?? string.Empty).Trim(),
            NumberStyles.None,
            CultureInfo.InvariantCulture,
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

    private static string Value(IConfiguration configuration, string key)
        => (configuration[key] ?? string.Empty).Trim();

    private sealed record VisitLogIpKey(int Epoch, byte[] Key, DateTimeOffset? AcceptUntilUtc);

    private sealed record VisitLogIpKeyRing(VisitLogIpKey Current, VisitLogIpKey? Previous);
}
