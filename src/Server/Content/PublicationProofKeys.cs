using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Platform;
using Microsoft.AspNetCore.WebUtilities;

namespace FsusBlog.V2.Server.Content;

internal sealed class PublicationProofKeys(string origin, ProofPublicKey current, IReadOnlyDictionary<string, ProofPublicKey> keys,
    ECDsa signer, PublicationHeadAnchor? headAnchor) : IDisposable
{
    internal string Origin { get; } = origin;
    internal ProofPublicKey Current { get; } = current;
    internal IReadOnlyDictionary<string, ProofPublicKey> Keys { get; } = keys;
    internal PublicationHeadAnchor? HeadAnchor { get; } = headAnchor;
    internal byte[] Manifest { get; } = JsonSerializer.SerializeToUtf8Bytes(new
    {
        manifestVersion = 2, kind = "native-publication-proof-keys", currentKeyId = current.Id, algorithm = ArticlePublicationProofPayloadV2.Algorithm,
        keys = keys.Values.Select(key => new
        {
            keyId = key.Id, keyVersion = key.Version, publicKey = WebEncoders.Base64UrlEncode(key.Spki),
            keySha256 = Convert.ToHexStringLower(key.Fingerprint), notBeforeUtc = ArticlePublicationProofPayloadV2.Time(key.NotBefore),
            notAfterUtc = ArticlePublicationProofPayloadV2.Time(key.NotAfter), revokedAtUtc = Format(key.Revoked),
            compromisedAtUtc = Format(key.Compromised),
        }),
    });

    internal static PublicationProofKeys? Read(IConfiguration configuration, IntegrityKeys legacy, string? origin, string dist)
    {
        var settings = configuration.GetSection("IntegrityProof:Signing");
        if (!settings.GetValue("NativeV2Enabled", false)) return null;
        try
        {
            if (origin is null || legacy.Configuration.CurrentKeyId is null) throw Invalid();
            var configured = ReadPublicKeys(settings, legacy);
            if (!configured.TryGetValue(legacy.Configuration.CurrentKeyId, out var current)) throw Invalid();
            var headAnchor = PublicationHeadAnchor.Parse(settings["NativeV2PublicHeadAnchor"]);
            var signer = LoadPrivate(settings["NativeV2PrivateKeyFile"], current.Spki, dist);
            return new(origin, current, configured, signer, headAnchor);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or CryptographicException or PlatformNotSupportedException)
        {
            throw Invalid();
        }
    }

    internal static IReadOnlyDictionary<string, ProofPublicKey> ReadPublicKeys(IConfigurationSection signing, IntegrityKeys legacy)
    {
        var configured = legacy.Configuration.Keys.Select(entry =>
        {
            var section = signing.GetSection("Keys").GetSection(entry.KeyId);
            var before = ReadTime(section["NotBeforeUtc"]) ?? throw Invalid();
            var after = ReadTime(section["NotAfterUtc"]) ?? throw Invalid();
            var spki = WebEncoders.Base64UrlDecode(entry.PublicKey);
            if (entry.Version is null || after < before) throw Invalid();
            return new ProofPublicKey(entry.KeyId, entry.Version.Value, spki, SHA256.HashData(spki), before, after,
                ReadTime(entry.RevokedAtUtc), ReadTime(entry.CompromisedAtUtc));
        }).ToDictionary(key => key.Id, StringComparer.Ordinal);
        if (configured.Values.Select(key => Convert.ToHexString(key.Fingerprint)).Distinct(StringComparer.Ordinal).Count() != configured.Count)
            throw Invalid();
        return configured;
    }

    internal byte[] Sign(byte[] transcript)
    {
        lock (signer) return signer.SignData(transcript, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
    }

    public void Dispose() => signer.Dispose();

    private static ECDsa LoadPrivate(string? path, byte[] expected, string dist)
    {
        if (path is null || !Path.IsPathFullyQualified(path) || path != Path.GetFullPath(path) ||
            Path.GetRelativePath(dist, path).Split(Path.DirectorySeparatorChar)[0] != "..") throw Invalid();
        return NativePublicationSigningKey.Open(path, expected);
    }

    private static DateTimeOffset? ReadTime(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (!DateTimeOffset.TryParseExact(value.Trim(), ["yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFzzz"],
                CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsed))
            throw Invalid();
        _ = ArticlePublicationProofPayloadV2.Time(parsed);
        return parsed;
    }

    private static string? Format(DateTimeOffset? value) => value is { } time ? ArticlePublicationProofPayloadV2.Time(time) : null;
    private static InvalidOperationException Invalid() => new("Invalid native publication signing configuration or private key.");
}

internal sealed record ProofPublicKey(string Id, int Version, byte[] Spki, byte[] Fingerprint, DateTimeOffset NotBefore,
    DateTimeOffset NotAfter, DateTimeOffset? Revoked, DateTimeOffset? Compromised)
{
    internal bool Allows(DateTimeOffset issued) => Compromised is null && issued >= NotBefore && issued <= NotAfter &&
        (Revoked is null || issued < Revoked.Value);

    internal bool Verify(ArticlePublicationProofV2 proof, byte[] signature)
    {
        return proof.KeyId == Id && proof.KeyVersion == Version && proof.KeySha256.AsSpan().SequenceEqual(Fingerprint) &&
            VerifySignature(ArticlePublicationProofPayloadV2.Build(proof), proof.IssuedAt, signature);
    }

    internal bool VerifySignature(byte[] payload, DateTimeOffset attestedAt, byte[] signature)
    {
        if (!Allows(attestedAt) || signature.Length != 64) return false;
        using var key = ECDsa.Create();
        key.ImportSubjectPublicKeyInfo(Spki, out _);
        return key.VerifyData(payload, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
    }
}
