using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Infrastructure.Helpers;

using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Services.Security;

public interface IPerceptionSealedTokenService
{
    string Seal(PerceptionSealedTokenPayload payload);

    PerceptionSealedTokenOpenResult Open(string sealedToken);
}

public sealed class PerceptionSealedTokenOptions
{
    public const string SectionName = "Security:PerceptionSealedToken";

    public string CurrentKeyVersion { get; set; } = string.Empty;

    public Dictionary<string, string> Keys { get; set; } = new(StringComparer.Ordinal);
}

public sealed record class PerceptionSealedTokenPayload(
    string ChallengeId,
    string TaskKind,
    string Action,
    string RouteKey,
    string SubjectHash,
    string ClientIpHash,
    string DeviceFpHash,
    string UaHash,
    string Algorithm,
    string Family,
    string Variant,
    string RecipeHashHex,
    string ExpectedPointHashHex,
    int ToleranceRadiusPx,
    string ExpectedStepHashHex,
    long IssuedAtUnixMs,
    long ExpiresAtUnixMs,
    int MaxAttempts,
    int MinSolveDurationMs,
    int MaxSolveDurationMs,
    string NonceHex,
    string KeyVersion,
    string PolicyVersion)
{
    public double? ExpectedX
    {
        get; init;
    }

    public double? ExpectedY
    {
        get; init;
    }

    public double? CoordinateTolerance
    {
        get; init;
    }

    public string PayloadBindingHashHex { get; init; } = string.Empty;
}

public sealed record PerceptionSealedTokenOpenResult(
    bool Succeeded,
    string Reason,
    PerceptionSealedTokenPayload? Payload)
{
    public static PerceptionSealedTokenOpenResult Success(PerceptionSealedTokenPayload payload)
        => new(true, "ok", payload);

    public static PerceptionSealedTokenOpenResult Rejected(string reason)
        => new(false, reason, null);
}

public sealed class PerceptionSealedTokenService(
    IOptionsMonitor<PerceptionSealedTokenOptions> options,
    TimeProvider timeProvider) : IPerceptionSealedTokenService
{
    private const string TokenPrefix = "fpst_";
    private const string EnvelopeVersion = "fsus.perception.sealed-token@v1";
    private const string CiphertextAadMarker = "aes-gcm-tag-bound";
    private const int NonceByteCount = 12;
    private const int TagByteCount = 16;
    private const int KeyByteCount = 32;
    private const int MaxTokenBytes = 16 * 1024;

    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public string Seal(PerceptionSealedTokenPayload payload)
    {
        ArgumentNullException.ThrowIfNull(payload);

        PerceptionSealedTokenOptions currentOptions = options.CurrentValue;
        PerceptionSealedTokenPayload normalized = NormalizePayload(
            payload,
            currentOptions.CurrentKeyVersion,
            allowCurrentKeyVersionFallback: true);
        normalized = normalized with
        {
            PayloadBindingHashHex = ComputePayloadBindingHash(normalized)
        };
        byte[] key = ResolveKeyOrThrow(currentOptions, normalized.KeyVersion);

        byte[] nonce = RandomNumberGenerator.GetBytes(NonceByteCount);
        byte[] plaintext = JsonSerializer.SerializeToUtf8Bytes(normalized, s_jsonOptions);
        byte[] ciphertext = new byte[plaintext.Length];
        byte[] tag = new byte[TagByteCount];
        byte[] aad = BuildAad(normalized, ciphertext);
        EncryptPayload(key, nonce, plaintext, ciphertext, tag, aad);

        var envelope = new PerceptionSealedTokenEnvelope(
            EnvelopeVersion,
            normalized.ChallengeId,
            normalized.Algorithm,
            normalized.TaskKind,
            normalized.Action,
            normalized.RouteKey,
            normalized.RecipeHashHex,
            normalized.IssuedAtUnixMs,
            normalized.ExpiresAtUnixMs,
            normalized.KeyVersion,
            WebEncoders.Base64UrlEncode(nonce),
            WebEncoders.Base64UrlEncode(ciphertext),
            WebEncoders.Base64UrlEncode(tag));
        byte[] envelopeJson = JsonSerializer.SerializeToUtf8Bytes(envelope, s_jsonOptions);
        return TokenPrefix + WebEncoders.Base64UrlEncode(envelopeJson);
    }

    public PerceptionSealedTokenOpenResult Open(string sealedToken)
    {
        if (!TryReadEnvelope(sealedToken, out PerceptionSealedTokenEnvelope? envelope) || envelope is null)
        {
            return PerceptionSealedTokenOpenResult.Rejected("token_invalid");
        }

        PerceptionSealedTokenOptions currentOptions = options.CurrentValue;
        if (!TryResolveKey(currentOptions, envelope.KeyVersion, out byte[] key))
        {
            return PerceptionSealedTokenOpenResult.Rejected("key_version_unknown");
        }

        if (!TryDecodeEnvelopeBytes(envelope, out byte[] nonce, out byte[] ciphertext, out byte[] tag))
        {
            return PerceptionSealedTokenOpenResult.Rejected("token_invalid");
        }

        byte[] plaintext = new byte[ciphertext.Length];
        try
        {
            byte[] aad = BuildAad(envelope, ciphertext);
            using var aes = new AesGcm(key, TagByteCount);
            aes.Decrypt(nonce, ciphertext, tag, plaintext, aad);
        }
        catch (CryptographicException)
        {
            return PerceptionSealedTokenOpenResult.Rejected("token_tampered");
        }
        catch (ArgumentException)
        {
            return PerceptionSealedTokenOpenResult.Rejected("token_invalid");
        }

        PerceptionSealedTokenPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize<PerceptionSealedTokenPayload>(plaintext, s_jsonOptions);
        }
        catch (JsonException)
        {
            return PerceptionSealedTokenOpenResult.Rejected("token_invalid");
        }

        if (payload is null)
        {
            return PerceptionSealedTokenOpenResult.Rejected("token_invalid");
        }

        PerceptionSealedTokenPayload normalized;
        try
        {
            normalized = NormalizePayload(
                payload,
                currentOptions.CurrentKeyVersion,
                allowCurrentKeyVersionFallback: false);
        }
        catch (ArgumentException)
        {
            return PerceptionSealedTokenOpenResult.Rejected("token_invalid");
        }

        if (!PayloadBindingHashMatches(normalized) || !EnvelopeMatchesPayload(envelope, normalized))
        {
            return PerceptionSealedTokenOpenResult.Rejected("context_mismatch");
        }

        if (normalized.ExpiresAtUnixMs <= timeProvider.GetUtcNow().ToUnixTimeMilliseconds())
        {
            return PerceptionSealedTokenOpenResult.Rejected("token_expired");
        }

        return PerceptionSealedTokenOpenResult.Success(normalized);
    }

    private static bool TryReadEnvelope(string? sealedToken, out PerceptionSealedTokenEnvelope? envelope)
    {
        envelope = null;
        string token = (sealedToken ?? string.Empty).Trim();
        if (!token.StartsWith(TokenPrefix, StringComparison.Ordinal))
        {
            return false;
        }

        byte[] envelopeBytes;
        try
        {
            envelopeBytes = WebEncoders.Base64UrlDecode(token[TokenPrefix.Length..]);
        }
        catch (FormatException)
        {
            return false;
        }

        if (envelopeBytes.Length is <= 0 or > MaxTokenBytes)
        {
            return false;
        }

        try
        {
            envelope = JsonSerializer.Deserialize<PerceptionSealedTokenEnvelope>(envelopeBytes, s_jsonOptions);
        }
        catch (JsonException)
        {
            return false;
        }

        return envelope is not null
            && string.Equals(envelope.Version, EnvelopeVersion, StringComparison.Ordinal)
            && IsPresent(envelope.ChallengeId)
            && IsPresent(envelope.Algorithm)
            && IsPresent(envelope.TaskKind)
            && IsPresent(envelope.Action)
            && IsPresent(envelope.RouteKey)
            && IsSha256Hex(envelope.RecipeHashHex)
            && envelope.ExpiresAtUnixMs > envelope.IssuedAtUnixMs
            && IsPresent(envelope.KeyVersion)
            && IsPresent(envelope.Nonce)
            && IsPresent(envelope.Ciphertext)
            && IsPresent(envelope.Tag);
    }

    private static bool TryDecodeEnvelopeBytes(
        PerceptionSealedTokenEnvelope envelope,
        out byte[] nonce,
        out byte[] ciphertext,
        out byte[] tag)
    {
        nonce = [];
        ciphertext = [];
        tag = [];
        try
        {
            nonce = WebEncoders.Base64UrlDecode(envelope.Nonce);
            ciphertext = WebEncoders.Base64UrlDecode(envelope.Ciphertext);
            tag = WebEncoders.Base64UrlDecode(envelope.Tag);
        }
        catch (FormatException)
        {
            return false;
        }

        return nonce.Length == NonceByteCount
            && ciphertext.Length is > 0 and <= MaxTokenBytes
            && tag.Length == TagByteCount;
    }

    private static PerceptionSealedTokenPayload NormalizePayload(
        PerceptionSealedTokenPayload payload,
        string currentKeyVersion,
        bool allowCurrentKeyVersionFallback)
    {
        string keyVersion = allowCurrentKeyVersionFallback && string.IsNullOrWhiteSpace(payload.KeyVersion)
            ? NormalizeRequired(currentKeyVersion, nameof(currentKeyVersion), 64)
            : NormalizeRequired(payload.KeyVersion, nameof(payload.KeyVersion), 64);
        long issuedAtUnixMs = payload.IssuedAtUnixMs;
        long expiresAtUnixMs = payload.ExpiresAtUnixMs;
        if (issuedAtUnixMs <= 0)
        {
            throw new ArgumentException("issuedAtUnixMs must be positive", nameof(payload));
        }

        if (expiresAtUnixMs <= issuedAtUnixMs)
        {
            throw new ArgumentException("expiresAtUnixMs must be after issuedAtUnixMs", nameof(payload));
        }

        if (payload.ToleranceRadiusPx < 0)
        {
            throw new ArgumentException("toleranceRadiusPx must be non-negative", nameof(payload));
        }

        if (payload.MaxAttempts <= 0)
        {
            throw new ArgumentException("maxAttempts must be positive", nameof(payload));
        }

        if (payload.MinSolveDurationMs < 0 || payload.MaxSolveDurationMs < payload.MinSolveDurationMs)
        {
            throw new ArgumentException("solve duration bounds are invalid", nameof(payload));
        }

        return payload with
        {
            ChallengeId = NormalizeRequired(payload.ChallengeId, nameof(payload.ChallengeId), 64),
            TaskKind = NormalizeRequired(payload.TaskKind, nameof(payload.TaskKind), 64),
            Action = NormalizeRequired(payload.Action, nameof(payload.Action), 96),
            RouteKey = NormalizeRequired(payload.RouteKey, nameof(payload.RouteKey), 256),
            SubjectHash = NormalizeRequiredHash(payload.SubjectHash, nameof(payload.SubjectHash)),
            ClientIpHash = NormalizeRequiredHash(payload.ClientIpHash, nameof(payload.ClientIpHash)),
            DeviceFpHash = NormalizeRequiredHash(payload.DeviceFpHash, nameof(payload.DeviceFpHash)),
            UaHash = NormalizeRequiredHash(payload.UaHash, nameof(payload.UaHash)),
            Algorithm = NormalizeRequired(payload.Algorithm, nameof(payload.Algorithm), 96),
            Family = NormalizeRequired(payload.Family, nameof(payload.Family), 64),
            Variant = NormalizeRequired(payload.Variant, nameof(payload.Variant), 96),
            RecipeHashHex = NormalizeRequiredHash(payload.RecipeHashHex, nameof(payload.RecipeHashHex)),
            ExpectedPointHashHex = NormalizeOptionalHash(payload.ExpectedPointHashHex, nameof(payload.ExpectedPointHashHex)),
            ExpectedStepHashHex = NormalizeOptionalHash(payload.ExpectedStepHashHex, nameof(payload.ExpectedStepHashHex)),
            NonceHex = NormalizeHex(payload.NonceHex, nameof(payload.NonceHex), 128),
            KeyVersion = keyVersion,
            PolicyVersion = NormalizeRequired(payload.PolicyVersion, nameof(payload.PolicyVersion), 64),
            PayloadBindingHashHex = NormalizeOptionalHash(payload.PayloadBindingHashHex, nameof(payload.PayloadBindingHashHex))
        };
    }

    private static byte[] BuildAad(PerceptionSealedTokenPayload payload, byte[] ciphertext)
        => JsonSerializer.SerializeToUtf8Bytes(
            new PerceptionSealedTokenAad(
                payload.ChallengeId,
                payload.Algorithm,
                payload.TaskKind,
                payload.Action,
                payload.RouteKey,
                payload.RecipeHashHex,
                payload.IssuedAtUnixMs,
                payload.ExpiresAtUnixMs,
                payload.KeyVersion,
                CiphertextAadMarker),
            s_jsonOptions);

    private static byte[] BuildAad(PerceptionSealedTokenEnvelope envelope, byte[] ciphertext)
        => JsonSerializer.SerializeToUtf8Bytes(
            new PerceptionSealedTokenAad(
                envelope.ChallengeId,
                envelope.Algorithm,
                envelope.TaskKind,
                envelope.Action,
                envelope.RouteKey,
                envelope.RecipeHashHex.ToLowerInvariant(),
                envelope.IssuedAtUnixMs,
                envelope.ExpiresAtUnixMs,
                envelope.KeyVersion,
                CiphertextAadMarker),
            s_jsonOptions);

    private static void EncryptPayload(
        byte[] key,
        byte[] nonce,
        byte[] plaintext,
        byte[] ciphertext,
        byte[] tag,
        byte[] aad)
    {
        using var aes = new AesGcm(key, TagByteCount);
        aes.Encrypt(nonce, plaintext, ciphertext, tag, aad);
    }

    private static bool PayloadBindingHashMatches(PerceptionSealedTokenPayload payload)
    {
        if (!IsSha256Hex(payload.PayloadBindingHashHex))
        {
            return false;
        }

        return FixedEquals(payload.PayloadBindingHashHex, ComputePayloadBindingHash(payload));
    }

    private static string ComputePayloadBindingHash(PerceptionSealedTokenPayload payload)
    {
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(
            payload with
            {
                PayloadBindingHashHex = string.Empty
            },
            s_jsonOptions);
        return Sha256Hex(bytes);
    }

    private static string Sha256Hex(ReadOnlySpan<byte> bytes)
        => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private static bool EnvelopeMatchesPayload(
        PerceptionSealedTokenEnvelope envelope,
        PerceptionSealedTokenPayload payload)
        => FixedEquals(envelope.ChallengeId, payload.ChallengeId)
            && FixedEquals(envelope.Algorithm, payload.Algorithm)
            && FixedEquals(envelope.TaskKind, payload.TaskKind)
            && FixedEquals(envelope.Action, payload.Action)
            && FixedEquals(envelope.RouteKey, payload.RouteKey)
            && FixedEquals(envelope.RecipeHashHex.ToLowerInvariant(), payload.RecipeHashHex)
            && envelope.IssuedAtUnixMs == payload.IssuedAtUnixMs
            && envelope.ExpiresAtUnixMs == payload.ExpiresAtUnixMs
            && FixedEquals(envelope.KeyVersion, payload.KeyVersion);

    private static byte[] ResolveKeyOrThrow(PerceptionSealedTokenOptions options, string keyVersion)
    {
        if (!TryResolveKey(options, keyVersion, out byte[] key))
        {
            throw new InvalidOperationException($"Perception sealed token key version is not configured: {keyVersion}");
        }

        return key;
    }

    private static bool TryResolveKey(PerceptionSealedTokenOptions options, string keyVersion, out byte[] key)
    {
        key = [];
        if (options.Keys.Count == 0 || !options.Keys.TryGetValue(keyVersion, out string? encodedKey))
        {
            return false;
        }

        return TryDecodeKey(encodedKey, out key);
    }

    private static bool TryDecodeKey(string? encodedKey, out byte[] key)
    {
        key = [];
        string value = (encodedKey ?? string.Empty).Trim();
        if (value.Length == 0)
        {
            return false;
        }

        if (value.StartsWith("hex:", StringComparison.OrdinalIgnoreCase))
        {
            return TryDecodeHexKey(value[4..], out key);
        }

        if (value.StartsWith("base64:", StringComparison.OrdinalIgnoreCase))
        {
            return TryDecodeBase64Key(value[7..], out key);
        }

        if (value.StartsWith("base64url:", StringComparison.OrdinalIgnoreCase))
        {
            return TryDecodeBase64UrlKey(value[10..], out key);
        }

        return value.Length == KeyByteCount * 2 && IsHex(value)
            ? TryDecodeHexKey(value, out key)
            : TryDecodeBase64Key(value, out key) || TryDecodeBase64UrlKey(value, out key);
    }

    private static bool TryDecodeHexKey(string value, out byte[] key)
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

        return key.Length == KeyByteCount;
    }

    private static bool TryDecodeBase64Key(string value, out byte[] key)
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

        return key.Length == KeyByteCount;
    }

    private static bool TryDecodeBase64UrlKey(string value, out byte[] key)
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

        return key.Length == KeyByteCount;
    }

    private static string NormalizeRequired(string? value, string name, int maxLength)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            throw new ArgumentException($"{name} is required", name);
        }

        if (normalized.Length > maxLength)
        {
            throw new ArgumentException($"{name} exceeds {maxLength} characters", name);
        }

        return normalized;
    }

    private static string NormalizeRequiredHash(string? value, string name)
    {
        string normalized = NormalizeRequired(value, name, 64).ToLowerInvariant();
        if (!IsSha256Hex(normalized))
        {
            throw new ArgumentException($"{name} must be a 64-character hex hash", name);
        }

        return normalized;
    }

    private static string NormalizeOptionalHash(string? value, string name)
    {
        string normalized = TextHelpers.LowerTrimmed(value) ?? string.Empty;
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        if (!IsSha256Hex(normalized))
        {
            throw new ArgumentException($"{name} must be empty or a 64-character hex hash", name);
        }

        return normalized;
    }

    private static string NormalizeHex(string? value, string name, int maxLength)
    {
        string normalized = NormalizeRequired(value, name, maxLength).ToLowerInvariant();
        if (normalized.Length % 2 != 0 || !IsHex(normalized))
        {
            throw new ArgumentException($"{name} must be even-length hex", name);
        }

        return normalized;
    }

    private static bool IsSha256Hex(string? value)
    {
        string normalized = (value ?? string.Empty).Trim();
        return normalized.Length == 64 && IsHex(normalized);
    }

    private static bool IsHex(string value)
    {
        for (int i = 0; i < value.Length; i++)
        {
            char ch = value[i];
            if (ch is not ((>= '0' and <= '9') or (>= 'a' and <= 'f') or (>= 'A' and <= 'F')))
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsPresent(string? value)
        => !string.IsNullOrWhiteSpace(value);

    private static bool FixedEquals(string left, string right)
    {
        byte[] leftBytes = Encoding.UTF8.GetBytes(left);
        byte[] rightBytes = Encoding.UTF8.GetBytes(right);
        return leftBytes.Length == rightBytes.Length && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }

    private sealed record PerceptionSealedTokenEnvelope(
        string Version,
        string ChallengeId,
        string Algorithm,
        string TaskKind,
        string Action,
        string RouteKey,
        string RecipeHashHex,
        long IssuedAtUnixMs,
        long ExpiresAtUnixMs,
        string KeyVersion,
        string Nonce,
        string Ciphertext,
        string Tag);

    private sealed record PerceptionSealedTokenAad(
        string ChallengeId,
        string Algorithm,
        string TaskKind,
        string Action,
        string RouteKey,
        string RecipeHashHex,
        long IssuedAtUnixMs,
        long ExpiresAtUnixMs,
        string KeyVersion,
        string PayloadCiphertextHashHex);
}
