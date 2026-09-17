using System.Buffers.Binary;
using System.Collections.Immutable;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public enum AuthoringPackageTrustStatus
{
    Trusted = 0,
    Unsigned = 1,
    UnknownPublisher = 2,
    Untrusted = 3,
    Revoked = 4,
    Expired = 5
}

public enum AuthoringPackageOperation
{
    Install = 0,
    Update = 1,
    Rollback = 2,
    Uninstall = 3
}

public enum AuthoringPackageOutcome
{
    Committed = 0,
    Rejected = 1,
    RolledBack = 2
}

public sealed record AuthoringPackageEntry(
    string Path,
    ImmutableArray<byte> Content,
    string ContentSha256,
    bool IsSymbolicLink = false,
    bool IsReparsePoint = false,
    bool IsPostInstallScript = false);

public sealed record AuthoringPackageArtifact(
    ImmutableArray<byte> CanonicalArchive,
    ImmutableArray<byte> Signature,
    string Publisher,
    string KeyId,
    string SourceReference,
    string ProvenanceReference,
    string ArchiveSha256 = "");

public sealed record AuthoringPackageArchiveContents(
    ImmutableArray<byte> CanonicalManifest,
    ImmutableArray<AuthoringPackageEntry> Entries);

public sealed record AuthoringPackageTrustDecision(
    AuthoringPackageTrustStatus Status,
    string Publisher,
    string KeyId,
    DateTimeOffset EvaluatedAt,
    DateTimeOffset ValidUntil,
    string KeysetIdentity = "");

public sealed record AuthoringPackagePublisherKey(
    string Publisher,
    string KeyId,
    ImmutableArray<byte> SubjectPublicKeyInfo,
    DateTimeOffset ValidFrom,
    DateTimeOffset ValidUntil,
    DateTimeOffset? RevokedAt = null);

public sealed record VerifiedAuthoringPackage(
    VerifiedAuthoringExtensionContract Contract,
    AuthoringPackageArtifact Artifact,
    AuthoringPackageArchiveContents Contents,
    AuthoringPackageTrustDecision Trust,
    string PackageIdentity);

public sealed record AuthoringPackageReceipt(
    long Sequence,
    DateTimeOffset Timestamp,
    AuthoringPackageOperation Operation,
    AuthoringPackageOutcome Outcome,
    string ExtensionId,
    string Version,
    string PackageIdentity,
    string ArchiveSha256,
    string PackageSha256,
    string ContentSha256,
    string ContractIdentity,
    string Publisher,
    string KeyId,
    AuthoringPackageTrustStatus TrustStatus,
    string KeysetIdentity,
    string? PreviousPackageIdentity,
    string? PreviousPackageSha256,
    string? FailureCode,
    string PreviousReceiptSha256,
    string ReceiptSha256);

public interface IAuthoringPackageTrustVerifier
{
    ValueTask<AuthoringPackageTrustDecision> VerifyAsync(
        string publisher,
        string keyId,
        ReadOnlyMemory<byte> archive,
        ReadOnlyMemory<byte> signature,
        CancellationToken cancellationToken);
}

public interface IAuthoringPackageKeyset
{
    ValueTask<ImmutableArray<AuthoringPackagePublisherKey>> GetPublisherKeysAsync(
        string publisher,
        CancellationToken cancellationToken);
}

public interface IAuthoringPackageSourceFetcher
{
    ValueTask<AuthoringPackageArtifact> FetchAsync(
        string approvedSourceReference,
        CancellationToken cancellationToken);
}

public sealed class LocalAuthoringPackageKeyset : IAuthoringPackageKeyset
{
    private readonly ImmutableDictionary<string, ImmutableArray<AuthoringPackagePublisherKey>> _publishers;

    public LocalAuthoringPackageKeyset(IEnumerable<AuthoringPackagePublisherKey> keys)
    {
        ArgumentNullException.ThrowIfNull(keys);
        var identities = new HashSet<string>(StringComparer.Ordinal);
        _publishers = keys
            .Select(static key => NormalizeKey(key))
            .GroupBy(static key => key.Publisher, StringComparer.Ordinal)
            .ToImmutableDictionary(
                static group => group.Key,
                group =>
                {
                    ImmutableArray<AuthoringPackagePublisherKey> publisherKeys = [.. group];
                    foreach (AuthoringPackagePublisherKey key in publisherKeys)
                    {
                        if (!identities.Add(string.Concat(key.Publisher, "\0", key.KeyId)))
                        {
                            throw new AuthoringExtensionContractException(
                                "Authoring package keyset contains a duplicate publisher/key identity.");
                        }
                    }

                    return publisherKeys;
                },
                StringComparer.Ordinal);
    }

    public ValueTask<ImmutableArray<AuthoringPackagePublisherKey>> GetPublisherKeysAsync(
        string publisher,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!AuthoringPackageReferencePolicy.IsBoundedIdentifier(publisher))
        {
            throw new AuthoringExtensionContractException("Package publisher identity is invalid or unbounded.");
        }

        return ValueTask.FromResult(
            _publishers.TryGetValue(publisher, out ImmutableArray<AuthoringPackagePublisherKey> keys)
                ? keys
                : ImmutableArray<AuthoringPackagePublisherKey>.Empty);
    }

    private static AuthoringPackagePublisherKey NormalizeKey(AuthoringPackagePublisherKey key)
    {
        ArgumentNullException.ThrowIfNull(key);
        if (!AuthoringPackageReferencePolicy.IsBoundedIdentifier(key.Publisher) ||
            !AuthoringPackageReferencePolicy.IsBoundedIdentifier(key.KeyId) ||
            key.SubjectPublicKeyInfo.IsDefaultOrEmpty || key.SubjectPublicKeyInfo.Length > 4096 ||
            key.ValidFrom >= key.ValidUntil ||
            key.RevokedAt is { } revokedAt && revokedAt < key.ValidFrom)
        {
            throw new AuthoringExtensionContractException("Authoring package publisher key is invalid or unbounded.");
        }

        return key with
        {
            SubjectPublicKeyInfo = [.. key.SubjectPublicKeyInfo],
            ValidFrom = key.ValidFrom.ToUniversalTime(),
            ValidUntil = key.ValidUntil.ToUniversalTime(),
            RevokedAt = key.RevokedAt?.ToUniversalTime()
        };
    }
}

public sealed class EcdsaAuthoringPackageTrustVerifier(
    IAuthoringPackageKeyset keyset,
    TimeProvider timeProvider) : IAuthoringPackageTrustVerifier
{
    public async ValueTask<AuthoringPackageTrustDecision> VerifyAsync(
        string publisher,
        string keyId,
        ReadOnlyMemory<byte> archive,
        ReadOnlyMemory<byte> signature,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(keyset);
        ArgumentNullException.ThrowIfNull(timeProvider);
        cancellationToken.ThrowIfCancellationRequested();
        DateTimeOffset now = timeProvider.GetUtcNow().ToUniversalTime();
        if (signature.IsEmpty)
        {
            return Decision(AuthoringPackageTrustStatus.Unsigned, publisher, keyId, now, now, string.Empty);
        }

        ImmutableArray<AuthoringPackagePublisherKey> publisherKeys = await keyset.GetPublisherKeysAsync(
            publisher,
            cancellationToken);
        if (publisherKeys.IsDefaultOrEmpty)
        {
            return Decision(
                AuthoringPackageTrustStatus.UnknownPublisher,
                publisher,
                keyId,
                now,
                now,
                string.Empty);
        }

        string keysetIdentity = ComputeKeysetIdentity(publisherKeys);
        AuthoringPackagePublisherKey? key = publisherKeys.SingleOrDefault(candidate =>
            string.Equals(candidate.KeyId, keyId, StringComparison.Ordinal));
        if (key is null)
        {
            return Decision(AuthoringPackageTrustStatus.Untrusted, publisher, keyId, now, now, keysetIdentity);
        }

        if (key.RevokedAt is { } revokedAt && revokedAt <= now)
        {
            return Decision(
                AuthoringPackageTrustStatus.Revoked,
                publisher,
                keyId,
                now,
                key.ValidUntil,
                keysetIdentity);
        }

        if (now < key.ValidFrom || now >= key.ValidUntil)
        {
            return Decision(
                AuthoringPackageTrustStatus.Expired,
                publisher,
                keyId,
                now,
                key.ValidUntil,
                keysetIdentity);
        }

        bool valid;
        try
        {
            using ECDsa algorithm = ECDsa.Create();
            algorithm.ImportSubjectPublicKeyInfo(key.SubjectPublicKeyInfo.AsSpan(), out int bytesRead);
            valid = bytesRead == key.SubjectPublicKeyInfo.Length &&
                algorithm.VerifyData(
                    archive.Span,
                    signature.Span,
                    HashAlgorithmName.SHA256,
                    DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        }
        catch (CryptographicException)
        {
            valid = false;
        }

        return Decision(
            valid ? AuthoringPackageTrustStatus.Trusted : AuthoringPackageTrustStatus.Untrusted,
            publisher,
            keyId,
            now,
            key.ValidUntil,
            keysetIdentity);
    }

    private static AuthoringPackageTrustDecision Decision(
        AuthoringPackageTrustStatus status,
        string publisher,
        string keyId,
        DateTimeOffset evaluatedAt,
        DateTimeOffset validUntil,
        string keysetIdentity) =>
        new(status, publisher, keyId, evaluatedAt, validUntil, keysetIdentity);

    private static string ComputeKeysetIdentity(ImmutableArray<AuthoringPackagePublisherKey> keys)
    {
        IEnumerable<string> keyFields = keys
            .OrderBy(static key => key.KeyId, StringComparer.Ordinal)
            .SelectMany(static key => new[]
            {
                key.Publisher,
                key.KeyId,
                Convert.ToHexStringLower(SHA256.HashData(key.SubjectPublicKeyInfo.AsSpan())),
                key.ValidFrom.UtcTicks.ToString(CultureInfo.InvariantCulture),
                key.ValidUntil.UtcTicks.ToString(CultureInfo.InvariantCulture),
                (key.RevokedAt?.UtcTicks ?? 0).ToString(CultureInfo.InvariantCulture)
            });
        string material = string.Join(
            "\n",
            new[]
            {
                "fsusblog.authoring-package.publisher-keyset.v1",
                keys.Length.ToString(CultureInfo.InvariantCulture)
            }.Concat(keyFields));
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(material)));
    }
}

public sealed class LocalApprovedAuthoringPackageSourceFetcher : IAuthoringPackageSourceFetcher
{
    private readonly ImmutableDictionary<string, AuthoringPackageArtifact> _packages;

    public LocalApprovedAuthoringPackageSourceFetcher(IEnumerable<AuthoringPackageArtifact> packages)
    {
        ArgumentNullException.ThrowIfNull(packages);
        var builder = ImmutableDictionary.CreateBuilder<string, AuthoringPackageArtifact>(StringComparer.Ordinal);
        foreach (AuthoringPackageArtifact package in packages)
        {
            ArgumentNullException.ThrowIfNull(package);
            AuthoringPackageReferencePolicy.ValidateSource(package.SourceReference);
            AuthoringPackageReferencePolicy.ValidateProvenance(package.ProvenanceReference);
            if (!builder.TryAdd(package.SourceReference, Clone(package)))
            {
                throw new AuthoringExtensionContractException(
                    "Approved authoring package source contains a duplicate reference.");
            }
        }

        _packages = builder.ToImmutable();
    }

    public ValueTask<AuthoringPackageArtifact> FetchAsync(
        string approvedSourceReference,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        AuthoringPackageReferencePolicy.ValidateSource(approvedSourceReference);
        if (!_packages.TryGetValue(approvedSourceReference, out AuthoringPackageArtifact? package))
        {
            throw new AuthoringExtensionContractException("Authoring package source is not in the approved local catalog.");
        }

        return ValueTask.FromResult(Clone(package));
    }

    private static AuthoringPackageArtifact Clone(AuthoringPackageArtifact package) =>
        package with
        {
            CanonicalArchive = [.. package.CanonicalArchive],
            Signature = [.. package.Signature]
        };
}

public interface IAuthoringPackageArchiveReader
{
    ValueTask<AuthoringPackageArchiveContents> ReadAsync(
        ReadOnlyMemory<byte> canonicalArchive,
        CancellationToken cancellationToken);
}

public interface IAuthoringPackageStore
{
    ValueTask<VerifiedAuthoringPackage?> GetActiveAsync(string extensionId, CancellationToken cancellationToken);

    ValueTask<bool> ContainsAsync(string packageIdentity, CancellationToken cancellationToken);

    ValueTask StageAsync(VerifiedAuthoringPackage package, CancellationToken cancellationToken);

    ValueTask ActivateAsync(string extensionId, string packageIdentity, CancellationToken cancellationToken);

    ValueTask DeactivateAsync(string extensionId, string expectedPackageIdentity, CancellationToken cancellationToken);

    ValueTask RemoveStagedAsync(string packageIdentity, CancellationToken cancellationToken);

    ValueTask AssertContentUnchangedAsync(string packageIdentity, CancellationToken cancellationToken);
}

public interface IAuthoringPackageHealthProbe
{
    ValueTask<bool> ProbeAsync(VerifiedAuthoringPackage package, CancellationToken cancellationToken);
}

public interface IAuthoringPackageReceiptStore
{
    ValueTask<AuthoringPackageReceipt?> GetLastAsync(CancellationToken cancellationToken);

    ValueTask<AuthoringPackageReceipt?> GetLastForExtensionAsync(
        string extensionId,
        CancellationToken cancellationToken);

    ValueTask AppendAsync(AuthoringPackageReceipt receipt, CancellationToken cancellationToken);
}

public sealed class AuthoringPackageVerifier(
    IAuthoringPackageTrustVerifier trustVerifier,
    IAuthoringPackageArchiveReader archiveReader,
    TimeProvider timeProvider)
{
    public async ValueTask<VerifiedAuthoringPackage> VerifyAsync(
        AuthoringPackageArtifact package,
        AuthoringHostPlatform targetPlatform,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(package);
        if (package.CanonicalArchive.IsDefaultOrEmpty || package.CanonicalArchive.Length > 128 * 1024 * 1024 ||
            package.Signature.IsDefaultOrEmpty || package.Signature.Length > 16 * 1024 ||
            IsMissingOrUnbounded(package.KeyId) || IsMissingOrUnbounded(package.Publisher) ||
            !IsSha256(package.ArchiveSha256))
        {
            throw new AuthoringExtensionContractException("Package archive or signature envelope is missing or outside its bound.");
        }

        RequireDigest(package.CanonicalArchive.AsSpan(), package.ArchiveSha256, "archive");

        AuthoringPackageTrustDecision trust = await trustVerifier.VerifyAsync(
            package.Publisher,
            package.KeyId,
            package.CanonicalArchive.AsMemory(),
            package.Signature.AsMemory(),
            cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        DateTimeOffset now = timeProvider.GetUtcNow();
        if (trust.Status != AuthoringPackageTrustStatus.Trusted || !IsSha256(trust.KeysetIdentity) ||
            !string.Equals(trust.Publisher, package.Publisher, StringComparison.Ordinal) ||
            !string.Equals(trust.KeyId, package.KeyId, StringComparison.Ordinal) ||
            trust.EvaluatedAt > now || trust.ValidUntil <= now)
        {
            throw new AuthoringExtensionContractException($"Package trust failed closed with status {trust.Status}.");
        }

        AuthoringPackageArchiveContents contents = await archiveReader.ReadAsync(
            package.CanonicalArchive.AsMemory(),
            cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        VerifiedAuthoringExtensionContract contract = AuthoringExtensionContractValidator.ParseAndVerify(
            contents.CanonicalManifest.AsSpan(),
            targetPlatform);
        if (!string.Equals(contract.Manifest.Publisher, package.Publisher, StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Signed publisher does not match the archive manifest.");
        }

        ValidateReferences(package);
        ValidateEntries(contract.Manifest, contents.Entries);
        string manifestSha256 = Convert.ToHexStringLower(SHA256.HashData(contents.CanonicalManifest.AsSpan()));
        string signatureSha256 = Convert.ToHexStringLower(SHA256.HashData(package.Signature.AsSpan()));
        string packageIdentity = ComputeIdentity(
            "fsusblog.authoring-package.identity.v1",
            contract.Manifest.Id,
            contract.Manifest.Version,
            package.Publisher,
            package.KeyId,
            trust.KeysetIdentity,
            signatureSha256,
            trust.Status.ToString(),
            contract.ContractIdentity,
            manifestSha256,
            package.ArchiveSha256,
            contract.Manifest.PackageSha256,
            contract.Manifest.ContentSha256,
            package.SourceReference,
            package.ProvenanceReference);
        return new VerifiedAuthoringPackage(
            contract,
            package with
            {
                CanonicalArchive = [.. package.CanonicalArchive],
                Signature = [.. package.Signature]
            },
            contents with
            {
                CanonicalManifest = [.. contents.CanonicalManifest],
                Entries = [.. contents.Entries.Select(static entry => entry with { Content = [.. entry.Content] })]
            },
            trust,
            packageIdentity);
    }

    private static void ValidateEntries(
        AuthoringExtensionManifest manifest,
        ImmutableArray<AuthoringPackageEntry> entries)
    {
        if (entries.IsDefaultOrEmpty || entries.Length > 4096)
        {
            throw new AuthoringExtensionContractException("Package entry count is outside its bound.");
        }

        var paths = new HashSet<string>(StringComparer.Ordinal);
        long totalBytes = 0;
        foreach (AuthoringPackageEntry entry in entries)
        {
            totalBytes = checked(totalBytes + entry.Content.Length);
            string normalized = entry.Path.Replace('\\', '/');
            if (entry.Content.Length > 16 * 1024 * 1024 || totalBytes > 64 * 1024 * 1024 ||
                entry.IsSymbolicLink || entry.IsReparsePoint || entry.IsPostInstallScript ||
                string.IsNullOrWhiteSpace(entry.Path) || entry.Path.Length > 256 ||
                !string.Equals(entry.Path, normalized, StringComparison.Ordinal) ||
                entry.Path.Length != entry.Path.Trim().Length || entry.Path.Contains(':') ||
                normalized.StartsWith("/", StringComparison.Ordinal) ||
                normalized.EndsWith("/", StringComparison.Ordinal) ||
                normalized.Contains("//", StringComparison.Ordinal) ||
                normalized.Split('/').Any(static segment => segment is "" or "." or "..") ||
                normalized.ContainsAny(['\r', '\n']) ||
                normalized.EndsWith("postinstall", StringComparison.OrdinalIgnoreCase) ||
                !paths.Add(normalized))
            {
                throw new AuthoringExtensionContractException("Package contains an unsafe, executable-hook, or duplicate path.");
            }

            RequireDigest(entry.Content.AsSpan(), entry.ContentSha256, $"entry {entry.Path}");
        }

        string contentDigest = ComputeContentDigest(entries);
        if (!string.Equals(contentDigest, manifest.ContentSha256, StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Package content digest does not match its manifest identity.");
        }

        string packageDigest = ComputePackageDigest(entries);
        if (!string.Equals(packageDigest, manifest.PackageSha256, StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Package payload digest does not match its manifest identity.");
        }

        foreach (AuthoringContributionDeclaration contribution in manifest.Contributions)
        {
            if (contribution.ExecutionClass != AuthoringExecutionClass.TrustedHostAdapter &&
                !paths.Contains(contribution.Entrypoint.PathOrAdapterId))
            {
                throw new AuthoringExtensionContractException("Verified package does not contain a declared entry point.");
            }

            if (contribution.ExecutionClass != AuthoringExecutionClass.TrustedHostAdapter)
            {
                AuthoringPackageEntry entry = entries.Single(candidate =>
                    string.Equals(candidate.Path, contribution.Entrypoint.PathOrAdapterId, StringComparison.Ordinal));
                if (!string.Equals(entry.ContentSha256, contribution.Entrypoint.ContentSha256, StringComparison.Ordinal))
                {
                    throw new AuthoringExtensionContractException("Entrypoint digest does not match the closed manifest.");
                }
            }
        }
    }

    private static void ValidateReferences(AuthoringPackageArtifact package)
    {
        AuthoringPackageReferencePolicy.ValidateSource(package.SourceReference);
        AuthoringPackageReferencePolicy.ValidateProvenance(package.ProvenanceReference);
    }

    public static string ComputeContentDigest(ImmutableArray<AuthoringPackageEntry> entries)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (AuthoringPackageEntry entry in entries.OrderBy(static item => item.Path, StringComparer.Ordinal))
        {
            byte[] path = Encoding.UTF8.GetBytes(entry.Path);
            AppendLength(hash, path.Length);
            hash.AppendData(path);
            hash.AppendData(Convert.FromHexString(entry.ContentSha256));
        }

        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    public static string ComputePackageDigest(ImmutableArray<AuthoringPackageEntry> entries)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData("fsusblog.authoring-package.payload.v1\0"u8);
        foreach (AuthoringPackageEntry entry in entries.OrderBy(static item => item.Path, StringComparer.Ordinal))
        {
            byte[] path = Encoding.UTF8.GetBytes(entry.Path);
            AppendLength(hash, path.Length);
            hash.AppendData(path);
            AppendLength(hash, entry.Content.Length);
            hash.AppendData(entry.Content.AsSpan());
        }

        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static void RequireDigest(ReadOnlySpan<byte> content, string expectedDigest, string field)
    {
        if (!IsSha256(expectedDigest) ||
            !CryptographicOperations.FixedTimeEquals(
                SHA256.HashData(content),
                Convert.FromHexString(expectedDigest)))
        {
            throw new AuthoringExtensionContractException($"The {field} digest does not match.");
        }
    }

    private static bool IsSha256(string value) =>
        value.Length == 64 && value.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool IsMissingOrUnbounded(string value) =>
        string.IsNullOrWhiteSpace(value) || value.Length > 128 || value.ContainsAny(['\0', '\r', '\n']);

    private static string ComputeIdentity(params string[] fields)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (string field in fields)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(field);
            AppendLength(hash, bytes.Length);
            hash.AppendData(bytes);
        }

        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static void AppendLength(IncrementalHash hash, int length)
    {
        Span<byte> encoded = stackalloc byte[sizeof(int)];
        BinaryPrimitives.WriteInt32BigEndian(encoded, length);
        hash.AppendData(encoded);
    }
}

internal static class AuthoringPackageReferencePolicy
{
    private static readonly string[] s_secretMarkers =
    [
        "github_pat_",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "bearer "
    ];

    public static void ValidateSource(string reference) =>
        ValidateOpaque(reference, "approved-source/");

    public static void ValidateProvenance(string reference) =>
        ValidateOpaque(reference, "provenance/");

    public static bool IsBoundedIdentifier(string value) =>
        !string.IsNullOrWhiteSpace(value) && value.Length <= 128 &&
        value[0] is >= 'a' and <= 'z' &&
        value.All(static character => character is >= 'a' and <= 'z' or >= '0' and <= '9' or '.' or '-');

    private static void ValidateOpaque(string reference, string requiredPrefix)
    {
        if (string.IsNullOrWhiteSpace(reference) || reference.Length > 256 ||
            !reference.StartsWith(requiredPrefix, StringComparison.Ordinal) ||
            reference.Length == requiredPrefix.Length ||
            reference.ContainsAny(['\\', ':', '?', '#', '\0', '\r', '\n']) ||
            reference.Contains("//", StringComparison.Ordinal) ||
            reference.Split('/').Any(static segment => segment is "" or "." or "..") ||
            s_secretMarkers.Any(marker => reference.Contains(marker, StringComparison.OrdinalIgnoreCase)))
        {
            throw new AuthoringExtensionContractException(
                "Package source and provenance must be approved opaque references without secrets or path traversal.");
        }
    }
}

internal static class AuthoringPackageClosedJson
{
    public static T Deserialize<T>(
        ReadOnlySpan<byte> utf8Json,
        JsonSerializerOptions options,
        string subject)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(utf8Json.ToArray(), new JsonDocumentOptions
            {
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = options.MaxDepth
            });
            RejectDuplicateProperties(document.RootElement, subject);
            return JsonSerializer.Deserialize<T>(utf8Json, options) ??
                throw new AuthoringExtensionContractException($"{subject} is missing.");
        }
        catch (JsonException exception)
        {
            throw new AuthoringExtensionContractException($"{subject} JSON is not closed: {exception.GetType().Name}.");
        }
    }

    private static void RejectDuplicateProperties(JsonElement element, string subject)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in element.EnumerateObject())
            {
                if (!names.Add(property.Name))
                {
                    throw new AuthoringExtensionContractException($"{subject} contains a duplicate property.");
                }

                RejectDuplicateProperties(property.Value, subject);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in element.EnumerateArray())
            {
                RejectDuplicateProperties(item, subject);
            }
        }
    }
}

public interface IAuthoringPackageCompatibilityPrecheck
{
    ValueTask<bool> IsCompatibleAsync(
        VerifiedAuthoringPackage? current,
        VerifiedAuthoringPackage candidate,
        CancellationToken cancellationToken);
}

public sealed class SchemaStableAuthoringPackageCompatibilityPrecheck : IAuthoringPackageCompatibilityPrecheck
{
    public ValueTask<bool> IsCompatibleAsync(
        VerifiedAuthoringPackage? current,
        VerifiedAuthoringPackage candidate,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(candidate);
        bool compatible = current is null ||
            current.Contract.Manifest.StateSchemaVersion == candidate.Contract.Manifest.StateSchemaVersion &&
            current.Contract.Manifest.DataSchemaVersion == candidate.Contract.Manifest.DataSchemaVersion;
        return ValueTask.FromResult(compatible);
    }
}

public sealed class AuthoringPackageActivationCoordinator(
    IAuthoringPackageStore packageStore,
    IAuthoringPackageHealthProbe healthProbe,
    IAuthoringPackageReceiptStore receiptStore,
    TimeProvider timeProvider,
    IAuthoringPackageCompatibilityPrecheck compatibilityPrecheck)
{
    public async ValueTask<AuthoringPackageReceipt> InstallOrUpdateAsync(
        VerifiedAuthoringPackage package,
        CancellationToken cancellationToken = default)
    {
        VerifiedAuthoringPackage? old = await packageStore.GetActiveAsync(package.Contract.Manifest.Id, cancellationToken);
        if (old is not null)
        {
            if (!string.Equals(old.Contract.Manifest.Publisher, package.Contract.Manifest.Publisher, StringComparison.Ordinal))
            {
                return await RecordAsync(package, old, AuthoringPackageOutcome.Rejected, "publisher-change", cancellationToken);
            }

            if (string.Equals(old.Contract.Manifest.Version, package.Contract.Manifest.Version, StringComparison.Ordinal) &&
                !string.Equals(old.Contract.Manifest.PackageSha256, package.Contract.Manifest.PackageSha256, StringComparison.Ordinal))
            {
                return await RecordAsync(package, old, AuthoringPackageOutcome.Rejected, "same-version-different-digest", cancellationToken);
            }

            if (Version.Parse(package.Contract.Manifest.Version) <= Version.Parse(old.Contract.Manifest.Version))
            {
                return await RecordAsync(package, old, AuthoringPackageOutcome.Rejected, "downgrade-or-replay", cancellationToken);
            }
        }

        if (await packageStore.ContainsAsync(package.PackageIdentity, cancellationToken))
        {
            return await RecordAsync(package, old, AuthoringPackageOutcome.Rejected, "package-replay", cancellationToken);
        }

        if (!await compatibilityPrecheck.IsCompatibleAsync(old, package, cancellationToken))
        {
            return await RecordAsync(
                package,
                old,
                AuthoringPackageOutcome.Rejected,
                "schema-migration-required",
                cancellationToken);
        }

        await packageStore.StageAsync(package, cancellationToken);
        try
        {
            await packageStore.ActivateAsync(
                package.Contract.Manifest.Id,
                package.PackageIdentity,
                cancellationToken);
            if (!await healthProbe.ProbeAsync(package, cancellationToken))
            {
                throw new AuthoringExtensionContractException("Package post-switch health probe failed.");
            }

            await packageStore.AssertContentUnchangedAsync(package.PackageIdentity, cancellationToken);
            return await RecordAsync(package, old, AuthoringPackageOutcome.Committed, null, cancellationToken);
        }
        catch
        {
            if (old is not null)
            {
                await packageStore.ActivateAsync(
                    old.Contract.Manifest.Id,
                    old.PackageIdentity,
                    CancellationToken.None);
            }
            else
            {
                await packageStore.DeactivateAsync(
                    package.Contract.Manifest.Id,
                    package.PackageIdentity,
                    CancellationToken.None);
            }

            await packageStore.RemoveStagedAsync(package.PackageIdentity, CancellationToken.None);
            await RecordAsync(package, old, AuthoringPackageOutcome.RolledBack, "activation-failed", CancellationToken.None);
            throw;
        }
    }

    public async ValueTask<AuthoringPackageReceipt> UninstallAsync(
        string extensionId,
        CancellationToken cancellationToken = default)
    {
        VerifiedAuthoringPackage package = await packageStore.GetActiveAsync(extensionId, cancellationToken)
            ?? throw new AuthoringExtensionContractException("Package uninstall requires one active verified package.");
        await packageStore.AssertContentUnchangedAsync(package.PackageIdentity, cancellationToken);
        await packageStore.DeactivateAsync(extensionId, package.PackageIdentity, cancellationToken);
        try
        {
            return await RecordAsync(
                package,
                package,
                AuthoringPackageOutcome.Committed,
                null,
                cancellationToken,
                AuthoringPackageOperation.Uninstall);
        }
        catch
        {
            await packageStore.ActivateAsync(extensionId, package.PackageIdentity, CancellationToken.None);
            throw;
        }
    }

    private async ValueTask<AuthoringPackageReceipt> RecordAsync(
        VerifiedAuthoringPackage package,
        VerifiedAuthoringPackage? previous,
        AuthoringPackageOutcome outcome,
        string? failureCode,
        CancellationToken cancellationToken,
        AuthoringPackageOperation? explicitOperation = null)
    {
        AuthoringPackageReceipt? last = await receiptStore.GetLastAsync(cancellationToken);
        long sequence = (last?.Sequence ?? 0) + 1;
        string previousHash = last?.ReceiptSha256 ?? new string('0', 64);
        AuthoringPackageOperation operation = explicitOperation ?? (previous is null
            ? AuthoringPackageOperation.Install
            : AuthoringPackageOperation.Update);
        AuthoringPackageReceipt receipt = new(
            sequence,
            timeProvider.GetUtcNow().ToUniversalTime(),
            operation,
            outcome,
            package.Contract.Manifest.Id,
            package.Contract.Manifest.Version,
            package.PackageIdentity,
            package.Artifact.ArchiveSha256,
            package.Contract.Manifest.PackageSha256,
            package.Contract.Manifest.ContentSha256,
            package.Contract.ContractIdentity,
            package.Contract.Manifest.Publisher,
            package.Artifact.KeyId,
            package.Trust.Status,
            package.Trust.KeysetIdentity,
            previous?.PackageIdentity,
            previous?.Contract.Manifest.PackageSha256,
            failureCode,
            previousHash,
            string.Empty);
        receipt = receipt with
        {
            ReceiptSha256 = ComputeReceiptSha256(receipt)
        };
        await receiptStore.AppendAsync(receipt, cancellationToken);
        return receipt;
    }

    public static string ComputeReceiptSha256(AuthoringPackageReceipt receipt)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Span<byte> length = stackalloc byte[sizeof(int)];
        foreach (string field in new[]
        {
            "fsusblog.authoring-package.receipt.v1",
            receipt.Sequence.ToString(CultureInfo.InvariantCulture),
            receipt.Timestamp.UtcTicks.ToString(CultureInfo.InvariantCulture),
            receipt.Operation.ToString(),
            receipt.Outcome.ToString(),
            receipt.ExtensionId,
            receipt.Version,
            receipt.PackageIdentity,
            receipt.ArchiveSha256,
            receipt.PackageSha256,
            receipt.ContentSha256,
            receipt.ContractIdentity,
            receipt.Publisher,
            receipt.KeyId,
            receipt.TrustStatus.ToString(),
            receipt.KeysetIdentity,
            receipt.PreviousPackageIdentity ?? string.Empty,
            receipt.PreviousPackageSha256 ?? string.Empty,
            receipt.FailureCode ?? string.Empty,
            receipt.PreviousReceiptSha256
        })
        {
            byte[] bytes = Encoding.UTF8.GetBytes(field);
            BinaryPrimitives.WriteInt32BigEndian(length, bytes.Length);
            hash.AppendData(length);
            hash.AppendData(bytes);
        }

        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }
}
