using System.Buffers.Binary;
using System.Collections.Immutable;
using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using static FsusBlog.V2.Core.Extensions.ExtensionManifestReader;

namespace FsusBlog.V2.Core.Extensions;

public sealed record ExtensionPublisherKey(string Publisher, string KeyId, ImmutableArray<byte> SubjectPublicKeyInfo,
    DateTimeOffset ValidFrom, DateTimeOffset ValidUntil, DateTimeOffset? RevokedAt = null);

public sealed record ApprovedExtensionSource(string Reference, string Provenance, string Publisher, string KeyId,
    string ArchiveSha256, string SignatureReference, string TrustPolicyReference);

public sealed class VerifiedExtensionPackage
{
    internal VerifiedExtensionPackage(ExtensionManifest manifest, string identity, string archiveDigest, DateTimeOffset checkedAt, DateTimeOffset validUntil)
    {
        Manifest = manifest;
        Identity = identity;
        ArchiveDigest = archiveDigest;
        CheckedAt = checkedAt;
        ValidUntil = validUntil;
    }

    public ExtensionManifest Manifest { get; }
    public string Identity { get; }
    internal string ArchiveDigest { get; }
    public DateTimeOffset CheckedAt { get; }
    public DateTimeOffset ValidUntil { get; }
}

public sealed class ExtensionPackageVerifier
{
    internal const int MaxArchiveBytes = 128 * 1024 * 1024;
    internal const int MaxSignatureBytes = 1024;
    private const int MaxEntryBytes = 16 * 1024 * 1024;
    private const int MaxExpandedBytes = 64 * 1024 * 1024;
    private const int MaxEntries = 4096;
    private readonly TimeProvider _clock;
    private readonly ImmutableDictionary<(string Publisher, string KeyId), ExtensionPublisherKey> _keys;
    private readonly ImmutableDictionary<string, ApprovedExtensionSource> _sources;
    private readonly string _keysetIdentity;

    public ExtensionPackageVerifier(IEnumerable<ExtensionPublisherKey> keys, IEnumerable<ApprovedExtensionSource> sources,
        TimeProvider clock)
    {
        _clock = clock;
        var keyMap = ImmutableDictionary.CreateBuilder<(string, string), ExtensionPublisherKey>();
        foreach (var key in keys)
        {
            if (keyMap.Count >= 256 || key is null || !IsIdentifier(key.Publisher) || !IsIdentifier(key.KeyId) ||
                key.SubjectPublicKeyInfo.Length is < 32 or > 1024 || key.ValidFrom >= key.ValidUntil ||
                !keyMap.TryAdd((key.Publisher, key.KeyId), key with { SubjectPublicKeyInfo = [.. key.SubjectPublicKeyInfo.AsSpan()] }))
                throw new ExtensionRejectedException("publisher-keyset-shape");
        }
        _keys = keyMap.ToImmutable();
        _keysetIdentity = DigestFields(_keys.Values.OrderBy(k => k.Publisher, StringComparer.Ordinal).ThenBy(k => k.KeyId, StringComparer.Ordinal)
            .SelectMany(key => new[] { key.Publisher, key.KeyId, Digest(key.SubjectPublicKeyInfo.AsSpan()),
                Ticks(key.ValidFrom), Ticks(key.ValidUntil), key.RevokedAt is { } cutoff ? Ticks(cutoff) : "" }));

        var sourceMap = ImmutableDictionary.CreateBuilder<string, ApprovedExtensionSource>(StringComparer.Ordinal);
        foreach (var source in sources)
        {
            if (sourceMap.Count >= 1024 || source is null || !IsOpaqueReference(source.Reference, "approved-source/") ||
                !IsOpaqueReference(source.Provenance, "provenance/") || !IsDigest(source.ArchiveSha256) ||
                !_keys.ContainsKey((source.Publisher, source.KeyId)) || !sourceMap.TryAdd(source.Reference, source))
                throw new ExtensionRejectedException("approved-source-catalog-shape");
        }
        _sources = sourceMap.ToImmutable();
    }

    public VerifiedExtensionPackage Verify(string sourceReference, ReadOnlyMemory<byte> archive, ReadOnlyMemory<byte> signature,
        ExtensionPlatform platform, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RequirePackageSize(archive.Length, signature.Length);
        return VerifySnapshot(sourceReference, archive.ToArray(), signature.ToArray(), platform, cancellationToken);
    }

    internal static void RequirePackageSize(int archiveLength, int signatureLength)
    {
        if (archiveLength is < 1 or > MaxArchiveBytes || signatureLength is < 1 or > MaxSignatureBytes)
            throw new ExtensionRejectedException("archive-or-signature-size");
    }

    // The caller owns these snapshots. The digest, signature and ZIP parser consume the same bytes.
    internal VerifiedExtensionPackage VerifySnapshot(string sourceReference, byte[] data, byte[] signed,
        ExtensionPlatform platform, CancellationToken cancellationToken)
    {
        var trust = VerifyArchive(sourceReference, data, signed, cancellationToken);
        var source = trust.Source;
        var manifest = VerifyEntries(data, platform, cancellationToken);
        if (manifest.Publisher != source.Publisher || manifest.SignatureReference != source.SignatureReference ||
            manifest.TrustPolicyReference != source.TrustPolicyReference)
            throw new ExtensionRejectedException("manifest-provenance");

        var identity = DigestFields(["fsusblog.v2.authoring-package", source.Reference, source.Provenance, source.Publisher,
            source.KeyId, source.ArchiveSha256, _keysetIdentity, Digest(signed), platform.ToString()]);
        trust.RequireCurrent(_clock, cancellationToken);
        return new(manifest, identity, source.ArchiveSha256, trust.CheckedAt, trust.ValidUntil);
    }

    internal SignedArchiveTrust VerifyArchive(string sourceReference, ReadOnlySpan<byte> data, ReadOnlySpan<byte> signed,
        CancellationToken cancellationToken, bool requireCurrent = true)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!_sources.TryGetValue(sourceReference, out var source)) throw new ExtensionRejectedException("source-not-approved");
        RequirePackageSize(data.Length, signed.Length);
        var checkedAt = _clock.GetUtcNow();
        var key = _keys[(source.Publisher, source.KeyId)];
        var validUntil = key.RevokedAt is { } cutoff && cutoff < key.ValidUntil ? cutoff : key.ValidUntil;
        if (requireCurrent && (checkedAt < key.ValidFrom || checkedAt >= validUntil)) throw new ExtensionRejectedException("publisher-key-not-current");
        RequireDigest(SHA256.HashData(data), source.ArchiveSha256, "archive-digest");
        VerifySignature(key, data, signed);
        return new(source, checkedAt, key.ValidFrom, validUntil);
    }

    internal sealed record SignedArchiveTrust(ApprovedExtensionSource Source, DateTimeOffset CheckedAt, DateTimeOffset ValidFrom, DateTimeOffset ValidUntil)
    {
        internal void RequireCurrent(TimeProvider clock, CancellationToken cancellationToken)
        {
            var completedAt = clock.GetUtcNow();
            cancellationToken.ThrowIfCancellationRequested();
            if (completedAt < CheckedAt || completedAt >= ValidUntil) throw new ExtensionRejectedException("publisher-key-not-current");
        }
    }

    private static void VerifySignature(ExtensionPublisherKey key, ReadOnlySpan<byte> archive, ReadOnlySpan<byte> signature)
    {
        try
        {
            using var verifier = ECDsa.Create();
            verifier.ImportSubjectPublicKeyInfo(key.SubjectPublicKeyInfo.AsSpan(), out var consumed);
            if (consumed == key.SubjectPublicKeyInfo.Length && verifier.KeySize is 256 or 384 or 521 &&
                verifier.VerifyData(archive, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)) return;
        }
        catch (Exception error) when (error is CryptographicException or PlatformNotSupportedException) { }
        throw new ExtensionRejectedException("archive-signature");
    }

    private static ExtensionManifest VerifyEntries(byte[] data, ExtensionPlatform platform, CancellationToken ct)
    {
        try
        {
            using var stream = new MemoryStream(data, writable: false);
            using var zip = new ZipArchive(stream, ZipArchiveMode.Read);
            if (zip.Entries.Count is < 2 or > MaxEntries + 1) throw new ExtensionRejectedException("archive-entry-count");

            var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            long expanded = 0;
            foreach (var entry in zip.Entries)
            {
                ct.ThrowIfCancellationRequested();
                var unixType = (entry.ExternalAttributes >> 16) & 0xf000;
                if (!IsPackagePath(entry.FullName) || !paths.Add(entry.FullName) || unixType is not (0 or 0x8000) ||
                    (entry.ExternalAttributes & ((int)FileAttributes.ReparsePoint | (int)FileAttributes.Directory)) != 0 ||
                    entry.Length < 0 || entry.Length > (entry.FullName == "manifest.json" ? ManifestBytes : MaxEntryBytes))
                    throw new ExtensionRejectedException("archive-entry-shape");
                expanded += entry.Length;
                if (expanded > MaxExpandedBytes + ManifestBytes) throw new ExtensionRejectedException("archive-expanded-size");
            }

            var manifestEntry = zip.GetEntry("manifest.json") ?? throw new ExtensionRejectedException("manifest-absent");
            if (expanded - manifestEntry.Length > MaxExpandedBytes) throw new ExtensionRejectedException("archive-expanded-size");
            byte[] json = ReadExact(manifestEntry);
            var manifest = Read(json, platform);
            var fileDigests = new Dictionary<string, byte[]>(StringComparer.Ordinal);
            using var content = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            using var payload = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            payload.AppendData("fsusblog.authoring-package.payload.v1\0"u8);
            foreach (var entry in zip.Entries.Where(e => e != manifestEntry).OrderBy(e => e.FullName, StringComparer.Ordinal))
            {
                ct.ThrowIfCancellationRequested();
                var name = Encoding.UTF8.GetBytes(entry.FullName);
                var bytes = ReadExact(entry);
                var entryDigest = SHA256.HashData(bytes);
                fileDigests.Add(entry.FullName, entryDigest);
                AddField(content, name);
                content.AppendData(entryDigest);
                AddField(payload, name);
                AddField(payload, bytes);
            }
            RequireDigest(content.GetHashAndReset(), manifest.ContentSha256, "content-digest");
            RequireDigest(payload.GetHashAndReset(), manifest.PackageSha256, "payload-digest");
            foreach (var contribution in manifest.Contributions.Where(c => c.ExecutionClass != 0))
            {
                if (!fileDigests.TryGetValue(contribution.Entrypoint.PathOrAdapterId, out var digest))
                    throw new ExtensionRejectedException("entrypoint-absent");
                RequireDigest(digest, contribution.Entrypoint.ContentSha256, "entrypoint-digest");
            }
            return manifest;
        }
        catch (Exception error) when (error is InvalidDataException or IOException or NotSupportedException)
        {
            throw new ExtensionRejectedException("archive-invalid");
        }
    }

    private static byte[] ReadExact(ZipArchiveEntry entry)
    {
        var bytes = new byte[checked((int)entry.Length)];
        using var stream = entry.Open();
        stream.ReadExactly(bytes);
        if (stream.ReadByte() != -1) throw new ExtensionRejectedException("archive-entry-size");
        return bytes;
    }

    private static void RequireDigest(ReadOnlySpan<byte> digest, string expected, string failure)
    {
        if (!CryptographicOperations.FixedTimeEquals(digest, Convert.FromHexString(expected)))
            throw new ExtensionRejectedException(failure);
    }

    private static string DigestFields(IEnumerable<string> fields)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var field in fields) AddField(hash, Encoding.UTF8.GetBytes(field));
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static void AddField(IncrementalHash hash, ReadOnlySpan<byte> value)
    {
        Span<byte> width = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(width, value.Length);
        hash.AppendData(width);
        hash.AppendData(value);
    }

    private static string Ticks(DateTimeOffset value) => value.UtcTicks.ToString(CultureInfo.InvariantCulture);
    internal static string Digest(ReadOnlySpan<byte> data) => Convert.ToHexStringLower(SHA256.HashData(data));
}
