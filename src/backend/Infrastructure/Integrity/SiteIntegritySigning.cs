using System.Collections.ObjectModel;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Core.Common;
using Microsoft.AspNetCore.WebUtilities;

namespace FsusBlog.Server.Infrastructure.Integrity;

public sealed record SiteIntegritySigningPayload(
    string ProofKind,
    string Subject,
    string DigestSha256Hex,
    DateTimeOffset IssuedAtUtc,
    IReadOnlyDictionary<string, string> Fields);

public sealed record SiteIntegritySignature(
    string KeyId,
    int KeyVersion,
    string Algorithm,
    string SignatureBase64Url,
    DateTimeOffset SignedAtUtc);

public sealed record SiteIntegritySignatureVerificationResult(
    bool Accepted,
    string Code,
    string? KeyId = null);

public sealed record SiteSigningKeyMetadata(
    string KeyId,
    int Version,
    string Algorithm,
    DateTimeOffset NotBeforeUtc,
    DateTimeOffset? NotAfterUtc,
    DateTimeOffset? RevokedAtUtc,
    DateTimeOffset? CompromisedAtUtc,
    string PublicKeySubjectPublicKeyInfoBase64Url,
    bool PrivateKeyAvailable = false);

public sealed record SiteSigningKeyRecord(
    string KeyId,
    int Version,
    string Algorithm,
    DateTimeOffset NotBeforeUtc,
    DateTimeOffset? NotAfterUtc,
    DateTimeOffset? RevokedAtUtc,
    DateTimeOffset? CompromisedAtUtc,
    string PublicKeySubjectPublicKeyInfoBase64Url,
    string? PrivateKeyPkcs8Base64Url)
{
    public const string EcdsaP256Sha256 = "ECDSA_P256_SHA256";

    public SiteSigningKeyMetadata PublicMetadata => new(
        KeyId,
        Version,
        Algorithm,
        NotBeforeUtc,
        NotAfterUtc,
        RevokedAtUtc,
        CompromisedAtUtc,
        PublicKeySubjectPublicKeyInfoBase64Url,
        PrivateKeyAvailable: false);

    public static SiteSigningKeyRecord CreateEcdsaP256(
        string keyId,
        int version,
        DateTimeOffset notBeforeUtc,
        DateTimeOffset? notAfterUtc = null,
        DateTimeOffset? revokedAtUtc = null,
        DateTimeOffset? compromisedAtUtc = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(keyId);
        if (version <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(version), version, "Key version must be positive.");
        }

        using ECDsa ecdsa = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        return new SiteSigningKeyRecord(
            keyId.Trim(),
            version,
            EcdsaP256Sha256,
            notBeforeUtc.ToUniversalTime(),
            notAfterUtc?.ToUniversalTime(),
            revokedAtUtc?.ToUniversalTime(),
            compromisedAtUtc?.ToUniversalTime(),
            Base64UrlTextEncoder.Encode(ecdsa.ExportSubjectPublicKeyInfo()),
            Base64UrlTextEncoder.Encode(ecdsa.ExportPkcs8PrivateKey()));
    }

    public SiteSigningKeyRecord WithoutPrivateKey()
        => this with { PrivateKeyPkcs8Base64Url = null };

    public SiteSigningKeyRecord WithRevokedAt(DateTimeOffset revokedAtUtc)
        => this with { RevokedAtUtc = revokedAtUtc.ToUniversalTime() };

    public SiteSigningKeyRecord WithCompromisedAt(DateTimeOffset compromisedAtUtc)
        => this with { CompromisedAtUtc = compromisedAtUtc.ToUniversalTime() };

    public SiteSigningKeyRecord WithNotAfter(DateTimeOffset notAfterUtc)
        => this with { NotAfterUtc = notAfterUtc.ToUniversalTime() };
}

public sealed class SiteSigningKeyRegistry
{
    private readonly IReadOnlyDictionary<string, SiteSigningKeyRecord> keysById;

    private SiteSigningKeyRegistry(
        IReadOnlyDictionary<string, SiteSigningKeyRecord> keysById,
        string currentKeyId)
    {
        this.keysById = keysById;
        CurrentKeyId = currentKeyId;
        PublicKeys = new ReadOnlyCollection<SiteSigningKeyMetadata>(
            [.. keysById.Values
                .Select(static key => key.PublicMetadata)
                .OrderBy(static key => key.Version)
                .ThenBy(static key => key.KeyId, StringComparer.Ordinal)]);
    }

    public string CurrentKeyId { get; }

    public IReadOnlyList<SiteSigningKeyMetadata> PublicKeys { get; }

    public static SiteSigningKeyRegistry Create(
        IEnumerable<SiteSigningKeyRecord> keys,
        string currentKeyId)
    {
        ArgumentNullException.ThrowIfNull(keys);
        ArgumentException.ThrowIfNullOrWhiteSpace(currentKeyId);

        var byId = new Dictionary<string, SiteSigningKeyRecord>(StringComparer.Ordinal);
        foreach (SiteSigningKeyRecord key in keys)
        {
            ArgumentNullException.ThrowIfNull(key);
            if (string.IsNullOrWhiteSpace(key.KeyId))
            {
                throw new ArgumentException("Signing key id must be present.", nameof(keys));
            }

            byId[key.KeyId] = NormalizeKey(key);
        }

        return new SiteSigningKeyRegistry(byId, currentKeyId.Trim());
    }

    public bool TryGetKey(string keyId, out SiteSigningKeyRecord key)
        => keysById.TryGetValue(keyId, out key!);

    public bool TryGetCurrentKey(out SiteSigningKeyRecord key)
        => keysById.TryGetValue(CurrentKeyId, out key!);

    private static SiteSigningKeyRecord NormalizeKey(SiteSigningKeyRecord key)
        => key with
        {
            KeyId = key.KeyId.Trim(),
            Algorithm = key.Algorithm.Trim(),
            NotBeforeUtc = key.NotBeforeUtc.ToUniversalTime(),
            NotAfterUtc = key.NotAfterUtc?.ToUniversalTime(),
            RevokedAtUtc = key.RevokedAtUtc?.ToUniversalTime(),
            CompromisedAtUtc = key.CompromisedAtUtc?.ToUniversalTime()
        };
}

public sealed class SiteIntegritySigningService(SiteSigningKeyRegistry registry)
{
    public SiteSigningKeyRegistry Registry { get; } = registry;

    public SiteIntegritySignature Sign(SiteIntegritySigningPayload payload)
    {
        ArgumentNullException.ThrowIfNull(payload);
        if (!Registry.TryGetCurrentKey(out SiteSigningKeyRecord? key))
        {
            throw SiteIntegritySigningUnavailableException.ForKey(Registry.CurrentKeyId, "current-key-missing");
        }

        ValidateKeyCanSign(key, payload.IssuedAtUtc);
        byte[] payloadBytes = SiteIntegritySigningPayloadCanonicalizer.BuildPayloadBytes(payload);
        using ECDsa ecdsa = CreatePrivateEcdsa(key);
        byte[] signature = ecdsa.SignData(
            payloadBytes,
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);

        return new SiteIntegritySignature(
            key.KeyId,
            key.Version,
            key.Algorithm,
            Base64UrlTextEncoder.Encode(signature),
            payload.IssuedAtUtc.ToUniversalTime());
    }

    public SiteIntegritySignatureVerificationResult Verify(
        SiteIntegritySigningPayload payload,
        SiteIntegritySignature signature)
    {
        ArgumentNullException.ThrowIfNull(payload);
        ArgumentNullException.ThrowIfNull(signature);

        if (!Registry.TryGetKey(signature.KeyId, out SiteSigningKeyRecord? key))
        {
            return Reject("unknown-key", signature.KeyId);
        }

        if (!StringComparer.Ordinal.Equals(signature.Algorithm, key.Algorithm))
        {
            return Reject("algorithm-mismatch", signature.KeyId);
        }

        if (!StringComparer.Ordinal.Equals(key.Algorithm, SiteSigningKeyRecord.EcdsaP256Sha256))
        {
            return Reject("algorithm-unsupported", signature.KeyId);
        }

        DateTimeOffset issuedAt = payload.IssuedAtUtc.ToUniversalTime();
        if (signature.SignedAtUtc.ToUniversalTime() != issuedAt)
        {
            return Reject("signed-at-mismatch", signature.KeyId);
        }

        SiteIntegritySignatureVerificationResult keyState = ValidateKeyCanVerify(key, issuedAt);
        if (!keyState.Accepted)
        {
            return keyState;
        }

        byte[] signatureBytes;
        try
        {
            signatureBytes = Base64UrlTextEncoder.Decode(signature.SignatureBase64Url);
        }
        catch (FormatException)
        {
            return Reject("signature-format-invalid", signature.KeyId);
        }

        byte[] payloadBytes = SiteIntegritySigningPayloadCanonicalizer.BuildPayloadBytes(payload);
        using ECDsa ecdsa = CreatePublicEcdsa(key);
        bool ok = ecdsa.VerifyData(
            payloadBytes,
            signatureBytes,
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return ok
            ? new SiteIntegritySignatureVerificationResult(true, "accepted", signature.KeyId)
            : Reject("payload-signature-invalid", signature.KeyId);
    }

    private static void ValidateKeyCanSign(SiteSigningKeyRecord key, DateTimeOffset issuedAt)
    {
        DateTimeOffset normalizedIssuedAt = issuedAt.ToUniversalTime();
        if (!StringComparer.Ordinal.Equals(key.Algorithm, SiteSigningKeyRecord.EcdsaP256Sha256))
        {
            throw SiteIntegritySigningUnavailableException.ForKey(key.KeyId, "algorithm-unsupported");
        }

        if (key.CompromisedAtUtc.HasValue)
        {
            throw SiteIntegritySigningUnavailableException.ForKey(key.KeyId, "key-compromised");
        }

        if (key.RevokedAtUtc.HasValue && normalizedIssuedAt >= key.RevokedAtUtc.Value)
        {
            throw SiteIntegritySigningUnavailableException.ForKey(key.KeyId, "key-revoked");
        }

        if (normalizedIssuedAt < key.NotBeforeUtc || key.NotAfterUtc.HasValue && normalizedIssuedAt > key.NotAfterUtc.Value)
        {
            throw SiteIntegritySigningUnavailableException.ForKey(key.KeyId, "key-not-active");
        }

        if (string.IsNullOrWhiteSpace(key.PrivateKeyPkcs8Base64Url))
        {
            throw SiteIntegritySigningUnavailableException.ForKey(key.KeyId, "private-key-missing");
        }
    }

    private static SiteIntegritySignatureVerificationResult ValidateKeyCanVerify(
        SiteSigningKeyRecord key,
        DateTimeOffset issuedAt)
    {
        if (key.CompromisedAtUtc.HasValue)
        {
            return Reject("key-compromised", key.KeyId);
        }

        if (key.RevokedAtUtc.HasValue && issuedAt >= key.RevokedAtUtc.Value)
        {
            return Reject("key-revoked", key.KeyId);
        }

        if (issuedAt < key.NotBeforeUtc || key.NotAfterUtc.HasValue && issuedAt > key.NotAfterUtc.Value)
        {
            return Reject("key-not-active", key.KeyId);
        }

        return new SiteIntegritySignatureVerificationResult(true, "accepted", key.KeyId);
    }

    private static ECDsa CreatePrivateEcdsa(SiteSigningKeyRecord key)
    {
        try
        {
            ECDsa ecdsa = ECDsa.Create();
            ecdsa.ImportPkcs8PrivateKey(Base64UrlTextEncoder.Decode(key.PrivateKeyPkcs8Base64Url!), out _);
            return ecdsa;
        }
        catch (CryptographicException ex)
        {
            throw SiteIntegritySigningUnavailableException.ForKey(key.KeyId, "private-key-invalid", ex);
        }
        catch (FormatException ex)
        {
            throw SiteIntegritySigningUnavailableException.ForKey(key.KeyId, "private-key-invalid", ex);
        }
    }

    private static ECDsa CreatePublicEcdsa(SiteSigningKeyRecord key)
    {
        ECDsa ecdsa = ECDsa.Create();
        ecdsa.ImportSubjectPublicKeyInfo(Base64UrlTextEncoder.Decode(key.PublicKeySubjectPublicKeyInfoBase64Url), out _);
        return ecdsa;
    }

    private static SiteIntegritySignatureVerificationResult Reject(string code, string? keyId)
        => new(false, code, keyId);
}

public sealed class SiteIntegritySigningUnavailableException : InvalidOperationException
{
    private SiteIntegritySigningUnavailableException(string keyId, string reason, Exception? innerException)
        : base($"integrity signing unavailable for key '{keyId}': {reason}", innerException)
    {
        KeyId = keyId;
        Reason = reason;
    }

    public string KeyId { get; }
    public string Reason { get; }

    public static SiteIntegritySigningUnavailableException ForKey(
        string keyId,
        string reason,
        Exception? innerException = null)
        => new(keyId, reason, innerException);
}

public static class SiteIntegritySigningPayloadCanonicalizer
{
    public const int PayloadVersion = 1;
    public const string DomainSeparator = "fsusblog.integrity.publish-proof.v1";

    public static byte[] BuildPayloadBytes(SiteIntegritySigningPayload payload)
        => Encoding.UTF8.GetBytes(BuildPayloadUtf8(payload));

    public static string BuildPayloadUtf8(SiteIntegritySigningPayload payload)
    {
        ArgumentNullException.ThrowIfNull(payload);
        ArgumentException.ThrowIfNullOrWhiteSpace(payload.ProofKind);
        ArgumentException.ThrowIfNullOrWhiteSpace(payload.Subject);
        string digest = NormalizeSha256(payload.DigestSha256Hex);
        IReadOnlyDictionary<string, string> fields = payload.Fields ?? throw new ArgumentNullException(nameof(payload.Fields));

        var builder = new StringBuilder(256 + fields.Count * 96);
        AppendRawLine(builder, DomainSeparator);
        AppendRawLine(builder, $"payloadVersion:i:{PayloadVersion.ToString(CultureInfo.InvariantCulture)}");
        AppendStringLine(builder, "proofKind", payload.ProofKind);
        AppendStringLine(builder, "subject", payload.Subject);
        AppendRawLine(builder, $"digestSha256:h:{digest}");
        AppendRawLine(builder, $"issuedAt:t:{CanonicalUtc(payload.IssuedAtUtc)}");
        AppendRawLine(builder, $"fieldCount:i:{fields.Count.ToString(CultureInfo.InvariantCulture)}");

        foreach (KeyValuePair<string, string> field in fields.OrderBy(static pair => pair.Key, StringComparer.Ordinal))
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(field.Key);
            ArgumentNullException.ThrowIfNull(field.Value);
            AppendStringLine(builder, "fieldKey", field.Key);
            AppendStringLine(builder, "fieldValue", field.Value);
        }

        return builder.ToString();
    }

    private static void AppendRawLine(StringBuilder builder, string value)
        => builder.Append(value).Append('\n');

    private static void AppendStringLine(StringBuilder builder, string field, string value)
    {
        string encoded = Convert.ToBase64String(Encoding.UTF8.GetBytes(NormalizeText(value)));
        AppendRawLine(builder, $"{field}:s:{encoded}");
    }

    private static string CanonicalUtc(DateTimeOffset value)
        => value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture);

    private static string NormalizeSha256(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        string trimmed = value.Trim();
        if (!HexText.IsSha256Hex(trimmed))
        {
            throw new ArgumentException("DigestSha256Hex must be a 64-character hexadecimal string.", nameof(value));
        }

        return trimmed.ToLowerInvariant();
    }

    private static string NormalizeText(string value)
        => value.Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n')
            .Normalize(NormalizationForm.FormC);
}

public enum SiteIntegritySigningAvailability
{
    Ready = 1,
    Pending = 2,
    Disabled = 3
}

public sealed record SiteIntegritySigningStartupState(
    SiteIntegritySigningAvailability Availability,
    string Reason)
{
    public bool CanSign => Availability == SiteIntegritySigningAvailability.Ready;
}

public static class SiteIntegritySigningStartupPolicy
{
    public const string SectionName = "IntegrityProof:Signing";

    public static SiteIntegritySigningStartupState Evaluate(
        IConfiguration configuration,
        bool enforceProductionRules)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        bool enabled = configuration.GetValue<bool?>($"{SectionName}:Enabled") ?? false;
        if (!enabled)
        {
            return new SiteIntegritySigningStartupState(
                SiteIntegritySigningAvailability.Disabled,
                "integrity-proof-signing-disabled");
        }

        string currentKeyId = (configuration[$"{SectionName}:CurrentKeyId"] ?? string.Empty).Trim();
        if (currentKeyId.Length == 0)
        {
            return Pending("current-key-missing");
        }

        IConfigurationSection currentKey = configuration.GetSection($"{SectionName}:Keys:{currentKeyId}");
        if (!currentKey.Exists())
        {
            return Pending("current-key-registry-entry-missing");
        }

        if (string.IsNullOrWhiteSpace(currentKey["Algorithm"]))
        {
            return Pending("algorithm-missing");
        }

        if (string.IsNullOrWhiteSpace(currentKey["PublicKey"]))
        {
            return Pending("public-key-missing");
        }

        if (string.IsNullOrWhiteSpace(currentKey["PrivateKey"]))
        {
            return Pending(enforceProductionRules ? "private-key-missing" : "private-key-missing-dev");
        }

        return new SiteIntegritySigningStartupState(
            SiteIntegritySigningAvailability.Ready,
            "integrity-proof-signing-ready");
    }

    private static SiteIntegritySigningStartupState Pending(string reason)
        => new(SiteIntegritySigningAvailability.Pending, reason);
}
