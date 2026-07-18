using System.Collections.Frozen;

namespace FsusBlog.Server.Infrastructure.Storage;

public enum ReleaseStorageClass
{
    DurableShared,
    ReleaseDerived,
    ImmutableAsset,
    InstanceScoped
}

public sealed record ReleaseStoragePaths(
    string SharedRoot,
    string UploadsRoot,
    string DataProtectionKeyRingRoot,
    string ReleaseDerivedRoot,
    string PublicAotRoot,
    string PublicHotRoot,
    string SearchRoot,
    string SsrRoot,
    string PrecompressedRoot,
    string GeneratedManifestRoot,
    string ImmutableAssetRoot,
    string InstanceRoot,
    string LogRoot,
    string TempRoot,
    string RuntimeSnapshotRoot);

/// <summary>
/// Defines the non-overlapping storage boundary used by blue/green releases.
/// This type deliberately does not create or delete directories. Callers must
/// validate a cleanup target with <see cref="EnsureReleaseDerivedCleanupTarget"/>
/// before mutating release-scoped state.
/// </summary>
public sealed class ReleaseStorageLayout
{
    public const string RequiredDataProtectionApplicationName = "FsusBlog";

    private static readonly FrozenSet<string> ValidDerivedKinds = new[]
    {
        "public-aot",
        "public-hot",
        "search",
        "ssr",
        "precompressed",
        "generated-manifests"
    }.ToFrozenSet(StringComparer.Ordinal);

    private readonly string _releaseDerivedBase;

    public ReleaseStorageLayout(
        string sharedRoot,
        string releaseDerivedBase,
        string immutableAssetBase,
        string instanceBase,
        string releaseId,
        string slot,
        string instanceId)
    {
        ReleaseId = NormalizeReleaseId(releaseId, nameof(releaseId));
        Slot = NormalizeIdentity(slot, nameof(slot));
        InstanceId = NormalizeIdentity(instanceId, nameof(instanceId));

        string normalizedSharedRoot = NormalizeRoot(sharedRoot, nameof(sharedRoot));
        _releaseDerivedBase = NormalizeRoot(releaseDerivedBase, nameof(releaseDerivedBase));
        string normalizedImmutableAssetBase = NormalizeRoot(immutableAssetBase, nameof(immutableAssetBase));
        string normalizedInstanceBase = NormalizeRoot(instanceBase, nameof(instanceBase));

        string releaseDerivedRoot = Descendant(_releaseDerivedBase, ReleaseId);
        string immutableAssetRoot = Descendant(normalizedImmutableAssetBase, ReleaseId);
        string instanceRoot = Descendant(normalizedInstanceBase, Slot, ReleaseId, InstanceId);

        Paths = new ReleaseStoragePaths(
            normalizedSharedRoot,
            Descendant(normalizedSharedRoot, "uploads"),
            Descendant(normalizedSharedRoot, "data-protection", "keyring"),
            releaseDerivedRoot,
            Descendant(releaseDerivedRoot, "public-aot"),
            Descendant(releaseDerivedRoot, "public-hot"),
            Descendant(releaseDerivedRoot, "search"),
            Descendant(releaseDerivedRoot, "ssr"),
            Descendant(releaseDerivedRoot, "precompressed"),
            Descendant(releaseDerivedRoot, "generated-manifests"),
            immutableAssetRoot,
            instanceRoot,
            Descendant(instanceRoot, "logs"),
            Descendant(instanceRoot, "tmp"),
            Descendant(instanceRoot, "runtime-snapshots"));

        EnsureDisjointRoots(Paths);
    }

    public string ReleaseId
    {
        get;
    }

    public string Slot
    {
        get;
    }

    public string InstanceId
    {
        get;
    }

    public ReleaseStoragePaths Paths
    {
        get;
    }

    public string GetReleaseDerivedPath(string kind)
    {
        if (!ValidDerivedKinds.Contains(kind))
        {
            throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unknown release-derived artifact kind.");
        }

        return Descendant(Paths.ReleaseDerivedRoot, kind);
    }

    public string GetImmutableAssetPath(string relativePath)
        => ResolveRelativePath(Paths.ImmutableAssetRoot, relativePath);

    public string GetInstanceTempPath(string relativePath)
        => ResolveRelativePath(Paths.TempRoot, relativePath);

    public void EnsureReleaseDerivedCleanupTarget(string candidatePath)
    {
        string normalizedCandidate = Path.GetFullPath(candidatePath);
        if (string.Equals(normalizedCandidate, _releaseDerivedBase, PathComparison)
            || !IsDescendantOf(normalizedCandidate, Paths.ReleaseDerivedRoot))
        {
            throw new InvalidOperationException(
                $"Cleanup target must be contained by release '{ReleaseId}' and cannot address another release or the derived root.");
        }
    }

    public static string BuildReleaseAssetUrl(string releaseId, string relativePath)
    {
        string normalizedReleaseId = NormalizeReleaseId(releaseId, nameof(releaseId));
        string normalizedRelativePath = NormalizeRelativePath(relativePath);
        return $"/release-assets/{normalizedReleaseId}/{normalizedRelativePath.Replace(Path.DirectorySeparatorChar, '/')}";
    }

    public static string BuildReleaseDerivedPath(string releaseDerivedBase, string releaseId, string kind)
    {
        if (!ValidDerivedKinds.Contains(kind))
        {
            throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unknown release-derived artifact kind.");
        }

        string normalizedBase = NormalizeRoot(releaseDerivedBase, nameof(releaseDerivedBase));
        string normalizedReleaseId = NormalizeReleaseId(releaseId, nameof(releaseId));
        return Descendant(normalizedBase, normalizedReleaseId, kind);
    }

    public static string CacheControlFor(bool immutable)
        => immutable
            ? "public,max-age=31536000,immutable"
            : "no-store,max-age=0,must-revalidate";

    public static void EnsureAppendOnlyHash(string path, string existingSha256, string candidateSha256)
    {
        string normalizedExisting = NormalizeSha256(existingSha256, nameof(existingSha256));
        string normalizedCandidate = NormalizeSha256(candidateSha256, nameof(candidateSha256));
        if (!string.Equals(normalizedExisting, normalizedCandidate, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"Immutable asset path '{path}' already exists with a different SHA-256 digest.");
        }
    }

    private static string NormalizeRoot(string root, string parameterName)
    {
        if (string.IsNullOrWhiteSpace(root))
        {
            throw new ArgumentException("Storage root is required.", parameterName);
        }

        return Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
    }

    private static string NormalizeIdentity(string value, string parameterName)
    {
        if (string.IsNullOrWhiteSpace(value)
            || value.Length is < 1 or > 128
            || !char.IsAsciiLetterOrDigit(value[0])
            || value.Any(static character => !char.IsAsciiLetterOrDigit(character)
                && character is not '.' and not '_' and not '-'))
        {
            throw new ArgumentException("Identity must be 1-128 ASCII alphanumeric, '.', '_' or '-' characters.", parameterName);
        }

        return value;
    }

    private static string NormalizeReleaseId(string value, string parameterName)
    {
        string releaseId = NormalizeIdentity(value, parameterName);
        if (releaseId.Equals("latest", StringComparison.OrdinalIgnoreCase)
            || releaseId.Equals("current", StringComparison.OrdinalIgnoreCase)
            || releaseId.Equals("final-current", StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException("Release identity cannot be a mutable alias.", parameterName);
        }

        return releaseId;
    }

    private static string ResolveRelativePath(string root, string relativePath)
    {
        string normalizedRelativePath = NormalizeRelativePath(relativePath);
        string candidate = Path.GetFullPath(Path.Combine(root, normalizedRelativePath));
        if (!IsDescendantOf(candidate, root))
        {
            throw new InvalidOperationException("Storage path escaped its configured root.");
        }

        return candidate;
    }

    private static string NormalizeRelativePath(string relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath) || Path.IsPathRooted(relativePath))
        {
            throw new ArgumentException("A non-empty relative path is required.", nameof(relativePath));
        }

        string normalized = relativePath.Replace('/', Path.DirectorySeparatorChar)
            .Replace('\\', Path.DirectorySeparatorChar);
        string[] segments = normalized.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0 || segments.Any(static segment => segment is "." or ".."))
        {
            throw new ArgumentException("Relative path cannot contain traversal segments.", nameof(relativePath));
        }

        return Path.Combine(segments);
    }

    private static string Descendant(string root, params string[] segments)
        => Path.GetFullPath(Path.Combine([root, .. segments]));

    private static bool IsDescendantOf(string candidate, string root)
    {
        string normalizedRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        string prefix = normalizedRoot + Path.DirectorySeparatorChar;
        return candidate.StartsWith(prefix, PathComparison);
    }

    private static void EnsureDisjointRoots(ReleaseStoragePaths paths)
    {
        string[] roots =
        [
            paths.SharedRoot,
            paths.ReleaseDerivedRoot,
            paths.ImmutableAssetRoot,
            paths.InstanceRoot
        ];

        for (int left = 0; left < roots.Length; left++)
        {
            for (int right = left + 1; right < roots.Length; right++)
            {
                if (string.Equals(roots[left], roots[right], PathComparison)
                    || IsDescendantOf(roots[left], roots[right])
                    || IsDescendantOf(roots[right], roots[left]))
                {
                    throw new InvalidOperationException("Shared, derived, immutable and instance storage roots must not overlap.");
                }
            }
        }
    }

    private static string NormalizeSha256(string value, string parameterName)
    {
        string normalized = value.Trim().ToLowerInvariant();
        if (normalized.StartsWith("sha256:", StringComparison.Ordinal))
        {
            normalized = normalized["sha256:".Length..];
        }

        if (normalized.Length != 64 || normalized.Any(static character => !char.IsAsciiHexDigit(character)))
        {
            throw new ArgumentException("SHA-256 digest must contain exactly 64 hexadecimal characters.", parameterName);
        }

        return normalized;
    }

    private static StringComparison PathComparison
        => OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
}
