using System.Security.Cryptography;
using System.Text;

using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.ArticleVault.Windows;

/// <summary>
/// Holds one explicitly selected NTFS root. Relative path inspection grants neither source content
/// access nor mutation; watcher integration must consume the owned handle and revalidation callbacks.
/// </summary>
public sealed class WindowsVaultRootPathScope : IDisposable
{
    private readonly object _sync = new();
    private readonly List<SafeFileHandle> _ancestors;
    private readonly string _rootPath;
    private readonly WindowsVaultRootPathNative.Facts _rootFacts;
    private readonly ArticleVaultRootManifest _manifest;
    private readonly string _controlBytesSha256;
    private bool _disposed;

    private WindowsVaultRootPathScope(List<SafeFileHandle> ancestors, string rootPath,
        WindowsVaultRootPathNative.Facts facts, ArticleVaultRootManifest manifest,
        string agentIdentity, string controlBytesSha256)
    {
        _ancestors = ancestors;
        _rootPath = rootPath;
        _rootFacts = facts;
        _manifest = manifest;
        _controlBytesSha256 = controlBytesSha256;
        string rootIdentity = Hash(string.Join('\n', "windows", "NTFS", "case-insensitive-unicode-none",
            manifest.SiteIdentity, manifest.VaultIdentity, manifest.DeviceIdentity, agentIdentity,
            manifest.ContentSha256, controlBytesSha256, facts.VolumeIdentity, rootPath));
        Scope = new(manifest.SiteIdentity, manifest.VaultIdentity, manifest.DeviceIdentity,
            agentIdentity, rootIdentity, manifest.ContentSha256, VaultPathComparisonPolicy.OrdinalIgnoreCase);
    }

    /// <summary>Diagnostic structural binding; serialization cannot reconstruct this native scope.</summary>
    public VaultPathStructuralScope Scope
    {
        get;
    }

    /// <summary>Admits one exact local drive path through native handles and actual control manifest bytes.</summary>
    public static WindowsVaultRootPathScope Open(string rootPath,
        ArticleVaultRootManifest rootManifest, string agentIdentity)
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException("windows_vault_requires_real_windows_ntfs");
        }

        ArgumentNullException.ThrowIfNull(rootManifest);
        if (string.IsNullOrWhiteSpace(agentIdentity) || agentIdentity.Length > 64
            || agentIdentity.Any(static value => !char.IsAsciiLetterOrDigit(value) && value != '-'))
        {
            throw new InvalidDataException("windows_vault_agent_identity_invalid");
        }

        if (string.IsNullOrWhiteSpace(rootPath) || rootPath.Length < 4 || !char.IsAsciiLetter(rootPath[0])
            || rootPath[1] != ':' || rootPath[2] != '\\' || rootPath.Contains('/')
            || rootPath.Contains("..", StringComparison.Ordinal) || rootPath.Any(char.IsControl)
            || !Path.IsPathFullyQualified(rootPath))
        {
            throw new InvalidDataException("windows_vault_root_path_invalid");
        }

        ArticleVaultRootManifest snapshot = ArticleVaultManifestCodec.DeserializeRoot(
            ArticleVaultManifestCodec.Serialize(rootManifest));
        ArticleVaultValidationResult validation = ArticleVaultManifestValidator.Validate(snapshot);
        if (!validation.IsValid)
        {
            throw new InvalidDataException(validation.ReasonCode ?? "windows_vault_manifest_invalid");
        }

        string normalized = Path.TrimEndingDirectorySeparator(Path.GetFullPath(rootPath));
        if (!string.Equals(normalized, Path.TrimEndingDirectorySeparator(rootPath), StringComparison.Ordinal))
        {
            throw new InvalidDataException("windows_vault_root_path_alias");
        }

        var ancestors = new List<SafeFileHandle>();
        try
        {
            ancestors.Add(WindowsVaultRootPathNative.OpenDrive("\\\\?\\" + normalized[..3]));
            WindowsVaultRootPathNative.Facts drive = WindowsVaultRootPathNative.Inspect(ancestors[^1]);
            string current = normalized[..3];
            foreach (string segment in normalized[3..].Split('\\'))
            {
                if (!ArticleVaultPathStructureValidator.ValidateRelativePath(segment).IsValid)
                {
                    throw new InvalidDataException("windows_vault_root_segment_invalid");
                }

                ancestors.Add(WindowsVaultRootPathNative.OpenRelative(ancestors[^1], segment, true));
                current = Path.Combine(current, segment);
                CheckFacts(WindowsVaultRootPathNative.Inspect(ancestors[^1]), current, drive.VolumeIdentity);
            }

            WindowsVaultRootPathNative.Facts facts = WindowsVaultRootPathNative.Inspect(ancestors[^1]);
            byte[] control = ReadControl(ancestors[^1], normalized, facts.VolumeIdentity, snapshot);
            return new(ancestors, normalized, facts, snapshot, agentIdentity,
                Convert.ToHexStringLower(SHA256.HashData(control)));
        }
        catch
        {
            foreach (SafeFileHandle handle in ancestors)
            {
                handle.Dispose();
            }

            throw;
        }
    }

    /// <summary>Revalidates root/control bytes and every existing path segment before classification.</summary>
    public VaultPathStructuralAnalysis AnalyzeProjection(string relativePath, IReadOnlyList<string> observedRelativePaths)
    {
        lock (_sync)
        {
            EnsureRoot();
            VaultPathStructuralAnalysis analysis = ArticleVaultPathStructureValidator.Analyze(
                _manifest, Scope, relativePath, observedRelativePaths);
            if (analysis.Classification != VaultPathStructuralClass.Blocked)
            {
                foreach (string path in observedRelativePaths.Append(relativePath).Distinct(StringComparer.Ordinal))
                {
                    _ = InspectRelative(path);
                }
            }

            return analysis;
        }
    }

    /// <summary>Releases the native root and ancestry pins. Duplicate watcher handles have separate owners.</summary>
    public void Dispose()
    {
        lock (_sync)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            foreach (SafeFileHandle handle in _ancestors.AsEnumerable().Reverse())
            {
                handle.Dispose();
            }
        }
    }

    internal SafeFileHandle DuplicateRootHandleForWatcher()
    {
        lock (_sync)
        {
            EnsureRoot();
            return WindowsVaultRootPathNative.Duplicate(_ancestors[^1]);
        }
    }

    internal WindowsVaultWatchIdentity CreateWatchIdentity(string watchInstanceIdentity)
    {
        lock (_sync)
        {
            EnsureRoot();
            if (string.IsNullOrWhiteSpace(watchInstanceIdentity) || watchInstanceIdentity.Length > 64
                || watchInstanceIdentity.Any(static value => !char.IsAsciiLetterOrDigit(value) && value != '-'))
            {
                throw new InvalidDataException("windows_vault_watch_identity_invalid");
            }

            return new(Scope.SiteIdentity, Scope.VaultIdentity, Scope.DeviceIdentity, Scope.AgentIdentity,
                Scope.RootIdentitySha256, Scope.RootManifestSha256, watchInstanceIdentity, "NTFS",
                _rootFacts.Volume, false);
        }
    }

    internal WindowsVaultPathAdmission RevalidateRoot()
    {
        lock (_sync)
        {
            try
            {
                EnsureRoot();
                return new(WindowsVaultPathDisposition.Source, null);
            }
            catch (Exception exception) when (exception is IOException or InvalidDataException or UnauthorizedAccessException or ObjectDisposedException)
            {
                return new(WindowsVaultPathDisposition.Blocked, "windows_vault_root_admission_lost");
            }
        }
    }

    internal WindowsVaultPathAdmission RevalidatePath(string relativePath)
    {
        lock (_sync)
        {
            try
            {
                EnsureRoot();
                VaultPathStructuralAnalysis analysis = ArticleVaultPathStructureValidator.Analyze(_manifest, Scope, relativePath, []);
                if (analysis.Classification == VaultPathStructuralClass.Blocked)
                {
                    return new(WindowsVaultPathDisposition.Blocked, analysis.ReasonCode);
                }

                bool exists = InspectRelative(relativePath);
                // Control paths never enter ordinary source discovery, including missing control names.
                if (analysis.Classification == VaultPathStructuralClass.RegisteredControlPath)
                {
                    return new(WindowsVaultPathDisposition.Blocked, "windows_vault_control_path_reserved");
                }

                return new(exists ? WindowsVaultPathDisposition.Source : WindowsVaultPathDisposition.MissingEntry, null);
            }
            catch (Exception exception) when (exception is IOException or InvalidDataException or UnauthorizedAccessException or ObjectDisposedException)
            {
                return new(WindowsVaultPathDisposition.Blocked, "windows_vault_path_admission_blocked");
            }
        }
    }

    private void EnsureRoot()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        WindowsVaultRootPathNative.Facts current = WindowsVaultRootPathNative.Inspect(_ancestors[^1]);
        CheckFacts(current, _rootPath, _rootFacts.VolumeIdentity);
        if (current.FileId != _rootFacts.FileId)
        {
            throw new IOException("windows_vault_root_identity_changed");
        }

        // Reopen the named ancestry while the original pins are held: a substituted name cannot
        // silently adopt the old capability. File IDs remain diagnostic and never article identity.
        using WindowsVaultRootPathScope currentScope = Open(_rootPath, _manifest, Scope.AgentIdentity);
        if (currentScope._rootFacts.FileId != _rootFacts.FileId
            || currentScope._rootFacts.VolumeIdentity != _rootFacts.VolumeIdentity
            || currentScope._controlBytesSha256 != _controlBytesSha256)
        {
            throw new IOException("windows_vault_root_or_control_binding_changed");
        }
    }

    private bool InspectRelative(string relativePath)
    {
        ArticleVaultValidationResult pathValidation = ArticleVaultPathStructureValidator.ValidateRelativePath(relativePath);
        if (!pathValidation.IsValid)
        {
            throw new InvalidDataException(pathValidation.ReasonCode);
        }

        var handles = new List<SafeFileHandle>();
        try
        {
            SafeFileHandle parent = _ancestors[^1];
            string[] segments = relativePath.Split('/');
            string current = _rootPath;
            for (int index = 0; index < segments.Length; index++)
            {
                SafeFileHandle handle = WindowsVaultRootPathNative.OpenRelative(parent, segments[index], index < segments.Length - 1);
                handles.Add(handle);
                current = Path.Combine(current, segments[index]);
                CheckFacts(WindowsVaultRootPathNative.Inspect(handle), current, _rootFacts.VolumeIdentity);
                parent = handle;
            }

            return true;
        }
        catch (FileNotFoundException)
        {
            return false;
        }
        finally
        {
            foreach (SafeFileHandle handle in handles.AsEnumerable().Reverse())
            {
                handle.Dispose();
            }
        }
    }

    private static byte[] ReadControl(SafeFileHandle root, string rootPath, string volume, ArticleVaultRootManifest expected)
    {
        using SafeFileHandle control = WindowsVaultRootPathNative.OpenRelative(root, ".fsus", true);
        CheckFacts(WindowsVaultRootPathNative.Inspect(control), Path.Combine(rootPath, ".fsus"), volume);
        string manifestName = ArticleVaultSchemas.RootManifestPath.Split('/')[1];
        using SafeFileHandle manifest = WindowsVaultRootPathNative.OpenRelative(control, manifestName, false, readControl: true);
        CheckFacts(WindowsVaultRootPathNative.Inspect(manifest), Path.Combine(rootPath, ".fsus", manifestName), volume);
        long length = RandomAccess.GetLength(manifest);
        if (length is < 1 or > 1024 * 1024)
        {
            throw new InvalidDataException("windows_vault_control_manifest_size_invalid");
        }

        var bytes = new byte[checked((int)length)];
        int read = 0;
        while (read < bytes.Length)
        {
            int received = RandomAccess.Read(manifest, bytes.AsSpan(read), read);
            if (received == 0)
            {
                throw new IOException("windows_vault_control_manifest_short_read");
            }

            read += received;
        }

        if (RandomAccess.GetLength(manifest) != length)
        {
            throw new IOException("windows_vault_control_manifest_changed");
        }

        ArticleVaultRootManifest actual = ArticleVaultManifestCodec.DeserializeRoot(bytes);
        if (!ArticleVaultManifestValidator.Validate(actual).IsValid
            || actual.ContentSha256 != expected.ContentSha256 || actual.SiteIdentity != expected.SiteIdentity
            || actual.VaultIdentity != expected.VaultIdentity || actual.DeviceIdentity != expected.DeviceIdentity)
        {
            throw new InvalidDataException("windows_vault_control_manifest_binding_mismatch");
        }

        return bytes;
    }

    private static void CheckFacts(WindowsVaultRootPathNative.Facts facts, string expectedPath, string volume)
    {
        if (facts.VolumeIdentity != volume || !string.Equals(facts.FinalPath, Path.TrimEndingDirectorySeparator(expectedPath), StringComparison.Ordinal))
        {
            throw new IOException("windows_vault_path_identity_or_spelling_changed");
        }
    }

    private static string Hash(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}
