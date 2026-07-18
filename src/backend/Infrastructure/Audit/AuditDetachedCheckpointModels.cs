using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Common;

using Microsoft.AspNetCore.WebUtilities;

namespace FsusBlog.Server.Infrastructure.Audit;

public static class AuditDetachedCheckpointConstants
{
    public const int ManifestVersion = 1;
    public const string TrustDomain = "fsusblog.audit.detached-checkpoint.v1";
    public const string Algorithm = "ECDSA_P256_SHA256";
}

public sealed record AuditDetachedCheckpointManifest(
    int ManifestVersion,
    string TrustDomain,
    long Sequence,
    string? PreviousCheckpointDigest,
    long FromRecordId,
    long ToRecordId,
    int RecordCount,
    string MerkleRootHash,
    string AuditHeadHash,
    DateTimeOffset CreatedAtUtc);

public sealed record AuditDetachedCheckpointSignature(
    string KeyId,
    int KeyVersion,
    string Algorithm,
    string SignatureBase64Url,
    DateTimeOffset SignedAtUtc);

public sealed record AuditDetachedCheckpointEnvelope(
    AuditDetachedCheckpointManifest Manifest,
    AuditDetachedCheckpointSignature Signature)
{
    public string CheckpointDigest => AuditDetachedCheckpointCanonicalizer.ComputeEnvelopeDigestHex(this);
}

public sealed record AuditDetachedCheckpointTrustAnchor(
    string TrustDomain,
    long Sequence,
    string CheckpointDigest,
    string SigningKeyId)
{
    public static AuditDetachedCheckpointTrustAnchor FromEnvelope(AuditDetachedCheckpointEnvelope envelope)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        return new AuditDetachedCheckpointTrustAnchor(
            envelope.Manifest.TrustDomain,
            envelope.Manifest.Sequence,
            envelope.CheckpointDigest,
            envelope.Signature.KeyId);
    }
}

public sealed record AuditCheckpointKeyRecord(
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
    public static AuditCheckpointKeyRecord CreateEcdsaP256(
        string keyId,
        int version,
        DateTimeOffset notBeforeUtc,
        DateTimeOffset? notAfterUtc = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(keyId);
        if (version <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(version), version, "Key version must be positive.");
        }

        using ECDsa ecdsa = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        return new AuditCheckpointKeyRecord(
            keyId.Trim(),
            version,
            AuditDetachedCheckpointConstants.Algorithm,
            notBeforeUtc.ToUniversalTime(),
            notAfterUtc?.ToUniversalTime(),
            null,
            null,
            Base64UrlTextEncoder.Encode(ecdsa.ExportSubjectPublicKeyInfo()),
            Base64UrlTextEncoder.Encode(ecdsa.ExportPkcs8PrivateKey()));
    }

    public AuditCheckpointKeyRecord WithoutPrivateKey()
        => this with
        {
            PrivateKeyPkcs8Base64Url = null
        };

    public AuditCheckpointKeyRecord WithRevokedAt(DateTimeOffset value)
        => this with
        {
            RevokedAtUtc = value.ToUniversalTime()
        };

    public AuditCheckpointKeyRecord WithCompromisedAt(DateTimeOffset value)
        => this with
        {
            CompromisedAtUtc = value.ToUniversalTime()
        };
}

public sealed class AuditCheckpointKeyRegistry
{
    private readonly IReadOnlyDictionary<string, AuditCheckpointKeyRecord> _keys;

    private AuditCheckpointKeyRegistry(
        IReadOnlyDictionary<string, AuditCheckpointKeyRecord> keys,
        string currentKeyId)
    {
        _keys = keys;
        CurrentKeyId = currentKeyId;
        PublicKeys = keys.Values
            .Select(static key => key.WithoutPrivateKey())
            .OrderBy(static key => key.Version)
            .ThenBy(static key => key.KeyId, StringComparer.Ordinal)
            .ToArray();
    }

    public string CurrentKeyId
    {
        get;
    }

    public IReadOnlyList<AuditCheckpointKeyRecord> PublicKeys
    {
        get;
    }

    public static AuditCheckpointKeyRegistry Create(
        IEnumerable<AuditCheckpointKeyRecord> keys,
        string currentKeyId)
    {
        ArgumentNullException.ThrowIfNull(keys);
        ArgumentException.ThrowIfNullOrWhiteSpace(currentKeyId);
        var byId = new Dictionary<string, AuditCheckpointKeyRecord>(StringComparer.Ordinal);
        foreach (AuditCheckpointKeyRecord key in keys)
        {
            ArgumentNullException.ThrowIfNull(key);
            if (string.IsNullOrWhiteSpace(key.KeyId) || key.Version <= 0)
            {
                throw new ArgumentException("Audit checkpoint key identity is invalid.", nameof(keys));
            }

            AuditCheckpointKeyRecord normalized = key with
            {
                KeyId = key.KeyId.Trim(),
                Algorithm = key.Algorithm.Trim(),
                NotBeforeUtc = key.NotBeforeUtc.ToUniversalTime(),
                NotAfterUtc = key.NotAfterUtc?.ToUniversalTime(),
                RevokedAtUtc = key.RevokedAtUtc?.ToUniversalTime(),
                CompromisedAtUtc = key.CompromisedAtUtc?.ToUniversalTime()
            };
            if (!byId.TryAdd(normalized.KeyId, normalized))
            {
                throw new ArgumentException("Duplicate audit checkpoint key id.", nameof(keys));
            }
        }

        string current = currentKeyId.Trim();
        if (!byId.ContainsKey(current))
        {
            throw new ArgumentException("Current audit checkpoint key does not exist.", nameof(currentKeyId));
        }

        return new AuditCheckpointKeyRegistry(byId, current);
    }

    public bool TryGetCurrent(out AuditCheckpointKeyRecord key)
        => _keys.TryGetValue(CurrentKeyId, out key!);

    public bool TryGet(string keyId, out AuditCheckpointKeyRecord key)
        => _keys.TryGetValue(keyId, out key!);
}

public sealed record AuditCheckpointSignatureVerificationResult(bool Accepted, string Code, string? KeyId = null);

public sealed class AuditCheckpointSigningService(AuditCheckpointKeyRegistry registry)
{
    public AuditCheckpointKeyRegistry Registry { get; } = registry;

    public AuditDetachedCheckpointEnvelope Sign(AuditDetachedCheckpointManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        AuditDetachedCheckpointCanonicalizer.ValidateManifest(manifest);
        if (!Registry.TryGetCurrent(out AuditCheckpointKeyRecord? key))
        {
            throw new InvalidOperationException("audit_checkpoint_current_key_missing");
        }

        ValidateCanSign(key, manifest.CreatedAtUtc);
        using ECDsa ecdsa = CreatePrivateKey(key);
        byte[] signature = ecdsa.SignData(
            AuditDetachedCheckpointCanonicalizer.BuildManifestBytes(manifest),
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return new AuditDetachedCheckpointEnvelope(
            manifest,
            new AuditDetachedCheckpointSignature(
                key.KeyId,
                key.Version,
                key.Algorithm,
                Base64UrlTextEncoder.Encode(signature),
                manifest.CreatedAtUtc.ToUniversalTime()));
    }

    public AuditCheckpointSignatureVerificationResult Verify(AuditDetachedCheckpointEnvelope envelope)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        try
        {
            AuditDetachedCheckpointCanonicalizer.ValidateManifest(envelope.Manifest);
        }
        catch (ArgumentException)
        {
            return new AuditCheckpointSignatureVerificationResult(false, "manifest-invalid");
        }

        AuditDetachedCheckpointSignature signature = envelope.Signature;
        if (!Registry.TryGet(signature.KeyId, out AuditCheckpointKeyRecord? key))
        {
            return new AuditCheckpointSignatureVerificationResult(false, "unknown-key", signature.KeyId);
        }

        if (signature.KeyVersion != key.Version)
        {
            return Reject("key-version-mismatch", signature.KeyId);
        }

        if (!StringComparer.Ordinal.Equals(signature.Algorithm, key.Algorithm)
            || !StringComparer.Ordinal.Equals(signature.Algorithm, AuditDetachedCheckpointConstants.Algorithm))
        {
            return Reject("algorithm-mismatch", signature.KeyId);
        }

        DateTimeOffset signedAt = signature.SignedAtUtc.ToUniversalTime();
        if (signedAt != envelope.Manifest.CreatedAtUtc.ToUniversalTime())
        {
            return Reject("signed-at-mismatch", signature.KeyId);
        }

        AuditCheckpointSignatureVerificationResult state = ValidateCanVerify(key, signedAt);
        if (!state.Accepted)
        {
            return state;
        }

        try
        {
            using ECDsa ecdsa = CreatePublicKey(key);
            bool accepted = ecdsa.VerifyData(
                AuditDetachedCheckpointCanonicalizer.BuildManifestBytes(envelope.Manifest),
                Base64UrlTextEncoder.Decode(signature.SignatureBase64Url),
                HashAlgorithmName.SHA256,
                DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
            return accepted
                ? new AuditCheckpointSignatureVerificationResult(true, "accepted", signature.KeyId)
                : Reject("payload-signature-invalid", signature.KeyId);
        }
        catch (FormatException)
        {
            return Reject("signature-format-invalid", signature.KeyId);
        }
        catch (CryptographicException)
        {
            return Reject("public-key-invalid", signature.KeyId);
        }
    }

    private static void ValidateCanSign(AuditCheckpointKeyRecord key, DateTimeOffset signedAt)
    {
        AuditCheckpointSignatureVerificationResult state = ValidateCanVerify(key, signedAt.ToUniversalTime());
        if (!state.Accepted)
        {
            throw new InvalidOperationException(string.Concat("audit_checkpoint_signing_", state.Code));
        }

        if (string.IsNullOrWhiteSpace(key.PrivateKeyPkcs8Base64Url))
        {
            throw new InvalidOperationException("audit_checkpoint_signing_private_key_missing");
        }
    }

    private static AuditCheckpointSignatureVerificationResult ValidateCanVerify(
        AuditCheckpointKeyRecord key,
        DateTimeOffset signedAt)
    {
        if (key.CompromisedAtUtc.HasValue)
        {
            return Reject("key-compromised", key.KeyId);
        }

        if (key.RevokedAtUtc.HasValue && signedAt >= key.RevokedAtUtc.Value)
        {
            return Reject("key-revoked", key.KeyId);
        }

        if (signedAt < key.NotBeforeUtc || key.NotAfterUtc.HasValue && signedAt > key.NotAfterUtc.Value)
        {
            return Reject("key-not-active", key.KeyId);
        }

        return new AuditCheckpointSignatureVerificationResult(true, "accepted", key.KeyId);
    }

    private static ECDsa CreatePrivateKey(AuditCheckpointKeyRecord key)
    {
        ECDsa ecdsa = ECDsa.Create();
        ecdsa.ImportPkcs8PrivateKey(Base64UrlTextEncoder.Decode(key.PrivateKeyPkcs8Base64Url!), out _);
        return ecdsa;
    }

    private static ECDsa CreatePublicKey(AuditCheckpointKeyRecord key)
    {
        ECDsa ecdsa = ECDsa.Create();
        ecdsa.ImportSubjectPublicKeyInfo(Base64UrlTextEncoder.Decode(key.PublicKeySubjectPublicKeyInfoBase64Url), out _);
        return ecdsa;
    }

    private static AuditCheckpointSignatureVerificationResult Reject(string code, string? keyId)
        => new(false, code, keyId);
}

public static class AuditDetachedCheckpointCanonicalizer
{
    private const string ManifestDomain = "fsusblog.audit.detached-checkpoint.manifest.v1";
    private const string EnvelopeDomain = "fsusblog.audit.detached-checkpoint.envelope.v1";

    public static byte[] BuildManifestBytes(AuditDetachedCheckpointManifest manifest)
        => Encoding.UTF8.GetBytes(BuildManifestText(manifest));

    public static string ComputeEnvelopeDigestHex(AuditDetachedCheckpointEnvelope envelope)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        ValidateEnvelope(envelope);
        var builder = new StringBuilder(768);
        AppendLine(builder, EnvelopeDomain);
        AppendHash(builder, "manifestDigest", Hash(BuildManifestBytes(envelope.Manifest)));
        AppendString(builder, "keyId", envelope.Signature.KeyId);
        AppendLong(builder, "keyVersion", envelope.Signature.KeyVersion);
        AppendString(builder, "algorithm", envelope.Signature.Algorithm);
        AppendString(builder, "signature", envelope.Signature.SignatureBase64Url);
        AppendLine(builder, $"signedAt:t:{CanonicalUtc(envelope.Signature.SignedAtUtc)}");
        return Hash(Encoding.UTF8.GetBytes(builder.ToString()));
    }

    public static void ValidateEnvelope(AuditDetachedCheckpointEnvelope envelope)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        ArgumentNullException.ThrowIfNull(envelope.Manifest);
        ArgumentNullException.ThrowIfNull(envelope.Signature);
        ValidateManifest(envelope.Manifest);
        ArgumentException.ThrowIfNullOrWhiteSpace(envelope.Signature.KeyId);
        ArgumentException.ThrowIfNullOrWhiteSpace(envelope.Signature.Algorithm);
        ArgumentException.ThrowIfNullOrWhiteSpace(envelope.Signature.SignatureBase64Url);
        if (envelope.Signature.KeyVersion <= 0)
        {
            throw new ArgumentException("Audit checkpoint signature key version must be positive.", nameof(envelope));
        }
    }

    public static void ValidateManifest(AuditDetachedCheckpointManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        if (manifest.ManifestVersion != AuditDetachedCheckpointConstants.ManifestVersion
            || !StringComparer.Ordinal.Equals(manifest.TrustDomain, AuditDetachedCheckpointConstants.TrustDomain))
        {
            throw new ArgumentException("Unsupported audit checkpoint manifest identity.", nameof(manifest));
        }

        if (manifest.Sequence <= 0 || manifest.FromRecordId <= 0 || manifest.ToRecordId < manifest.FromRecordId
            || manifest.RecordCount <= 0)
        {
            throw new ArgumentException("Audit checkpoint sequence or record range is invalid.", nameof(manifest));
        }

        ValidateHash(manifest.MerkleRootHash, nameof(manifest.MerkleRootHash));
        ValidateHash(manifest.AuditHeadHash, nameof(manifest.AuditHeadHash));
        if (manifest.Sequence == 1 && manifest.PreviousCheckpointDigest is not null
            || manifest.Sequence > 1 && string.IsNullOrWhiteSpace(manifest.PreviousCheckpointDigest))
        {
            throw new ArgumentException("Audit checkpoint predecessor identity is invalid.", nameof(manifest));
        }

        if (manifest.PreviousCheckpointDigest is not null)
        {
            ValidateHash(manifest.PreviousCheckpointDigest, nameof(manifest.PreviousCheckpointDigest));
        }
    }

    private static string BuildManifestText(AuditDetachedCheckpointManifest manifest)
    {
        ValidateManifest(manifest);
        var builder = new StringBuilder(640);
        AppendLine(builder, ManifestDomain);
        AppendLong(builder, "manifestVersion", manifest.ManifestVersion);
        AppendString(builder, "trustDomain", manifest.TrustDomain);
        AppendLong(builder, "sequence", manifest.Sequence);
        AppendNullableHash(builder, "previousCheckpointDigest", manifest.PreviousCheckpointDigest);
        AppendLong(builder, "fromRecordId", manifest.FromRecordId);
        AppendLong(builder, "toRecordId", manifest.ToRecordId);
        AppendLong(builder, "recordCount", manifest.RecordCount);
        AppendHash(builder, "merkleRootHash", manifest.MerkleRootHash);
        AppendHash(builder, "auditHeadHash", manifest.AuditHeadHash);
        AppendLine(builder, $"createdAt:t:{CanonicalUtc(manifest.CreatedAtUtc)}");
        return builder.ToString();
    }

    private static void AppendLine(StringBuilder builder, string value)
        => builder.Append(value).Append('\n');

    private static void AppendLong(StringBuilder builder, string field, long value)
        => AppendLine(builder, $"{field}:i:{value.ToString(CultureInfo.InvariantCulture)}");

    private static void AppendHash(StringBuilder builder, string field, string value)
        => AppendLine(builder, $"{field}:h:{NormalizeHash(value)}");

    private static void AppendNullableHash(StringBuilder builder, string field, string? value)
        => AppendLine(builder, value is null ? $"{field}:n" : $"{field}:h:{NormalizeHash(value)}");

    private static void AppendString(StringBuilder builder, string field, string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        string normalized = value.Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n')
            .Normalize(NormalizationForm.FormC);
        AppendLine(builder, $"{field}:s:{Convert.ToBase64String(Encoding.UTF8.GetBytes(normalized))}");
    }

    private static string CanonicalUtc(DateTimeOffset value)
        => value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture);

    private static string Hash(ReadOnlySpan<byte> bytes)
        => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private static string NormalizeHash(string value)
    {
        ValidateHash(value, nameof(value));
        return value.Trim().ToLowerInvariant();
    }

    private static void ValidateHash(string value, string name)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        if (!HexText.IsSha256Hex(value.Trim()))
        {
            throw new ArgumentException("Audit checkpoint hash must be SHA-256 hex.", name);
        }
    }
}
