using System.Security.Cryptography;
using System.Text;

using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.ArticleVault.Linux;

internal static class LinuxVaultRootVerifier
{
    private const int MaxControlManifestBytes = 1024 * 1024;
    private static readonly HashSet<string> s_supportedFileSystems = new(StringComparer.Ordinal)
    {
        "btrfs",
        "ext4",
        "f2fs",
        "xfs"
    };

    internal static VerifiedLinuxVaultRoot Verify(LinuxVaultWatchRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        request.Options.Validate();
        ArticleVaultValidationResult manifestResult = ArticleVaultManifestValidator.Validate(request.RootManifest);
        if (!manifestResult.IsValid)
        {
            throw new LinuxVaultWatcherException(manifestResult.ReasonCode ?? "article_vault_root_manifest_invalid");
        }

        if (!IsIdentity(request.AgentIdentity))
        {
            throw new LinuxVaultWatcherException("linux_vault_agent_identity_invalid");
        }

        if (!Path.IsPathFullyQualified(request.RootPath) || !Directory.Exists(request.RootPath))
        {
            throw new LinuxVaultWatcherException("linux_vault_root_missing");
        }

        string suppliedRoot = TrimRoot(Path.GetFullPath(request.RootPath));
        string canonicalRoot = TrimRoot(ResolveRealPath(suppliedRoot));
        if (!string.Equals(suppliedRoot, canonicalRoot, StringComparison.Ordinal))
        {
            throw new LinuxVaultWatcherException("linux_vault_root_symlink_rejected");
        }

        MountRecord mount = ResolveMount(canonicalRoot);
        if (!s_supportedFileSystems.Contains(mount.FileSystemType))
        {
            throw new LinuxVaultWatcherException("linux_vault_filesystem_unsupported");
        }

        VerifyControlManifest(canonicalRoot, request.RootManifest);
        var semantics = new LinuxVaultFilesystemSemantics(
            mount.FileSystemType,
            mount.MountIdentity,
            mount.MountPoint,
            CaseSensitive: true,
            UnicodeNormalization: "none");
        string rootIdentity = ComputeSha256(string.Join(
            '\n',
            LinuxVaultWatcherSchemas.Platform,
            request.RootManifest.SiteIdentity,
            request.RootManifest.VaultIdentity,
            request.RootManifest.DeviceIdentity,
            request.AgentIdentity,
            request.RootManifest.ContentSha256,
            canonicalRoot,
            mount.MountIdentity.ToString(System.Globalization.CultureInfo.InvariantCulture),
            mount.FileSystemType));
        return new VerifiedLinuxVaultRoot(canonicalRoot, rootIdentity, semantics, request.RootManifest);
    }

    internal static PathVerification VerifyRelativePath(VerifiedLinuxVaultRoot root, string relativePath)
    {
        if (!IsSafeRelativePath(relativePath))
        {
            return new(LinuxVaultPathDisposition.Blocked, "linux_vault_path_invalid");
        }

        string[] segments = relativePath.Split('/');
        bool controlTree = string.Equals(segments[0], ".fsus", StringComparison.OrdinalIgnoreCase);
        if (controlTree)
        {
            if (!string.Equals(segments[0], ".fsus", StringComparison.Ordinal))
            {
                return new(LinuxVaultPathDisposition.Blocked, "linux_vault_control_tree_case_collision");
            }
        }

        string fullPath = Path.GetFullPath(Path.Combine(root.CanonicalPath, relativePath));
        if (!IsContained(root.CanonicalPath, fullPath))
        {
            return new(LinuxVaultPathDisposition.Blocked, "linux_vault_path_escape");
        }

        string current = root.CanonicalPath;
        foreach (string segment in segments)
        {
            current = Path.Combine(current, segment);
            if (IsSymbolicLink(current))
            {
                return new(LinuxVaultPathDisposition.Blocked, "linux_vault_symlink_rejected");
            }

            if (!Path.Exists(current))
            {
                PathVerification parent = VerifyExistingParent(root, Path.GetDirectoryName(current)!);
                return parent.Disposition == LinuxVaultPathDisposition.MissingEntry && controlTree
                    ? new(LinuxVaultPathDisposition.ControlTree, null)
                    : parent;
            }
        }

        try
        {
            string canonical = TrimRoot(ResolveRealPath(fullPath));
            if (!IsContained(root.CanonicalPath, canonical))
            {
                return new(LinuxVaultPathDisposition.Blocked, "linux_vault_realpath_escape");
            }

            MountRecord mount = ResolveMount(canonical);
            if (mount.MountIdentity != root.Filesystem.MountIdentity
                || !string.Equals(mount.FileSystemType, root.Filesystem.FileSystemType, StringComparison.Ordinal))
            {
                return new(LinuxVaultPathDisposition.Blocked, "linux_vault_mount_changed");
            }

            if (!HasRequiredAccess(fullPath))
            {
                return new(LinuxVaultPathDisposition.Blocked, "linux_vault_path_permission_blocked");
            }

            return new(
                controlTree ? LinuxVaultPathDisposition.ControlTree : LinuxVaultPathDisposition.Source,
                null);
        }
        catch (LinuxVaultWatcherException exception)
        {
            return new(LinuxVaultPathDisposition.Blocked, exception.ReasonCode);
        }
        catch (UnauthorizedAccessException)
        {
            return new(LinuxVaultPathDisposition.Blocked, "linux_vault_path_permission_blocked");
        }
    }

    internal static PathVerification VerifyWatchedRoot(VerifiedLinuxVaultRoot root)
    {
        try
        {
            if (!Directory.Exists(root.CanonicalPath))
            {
                return new(LinuxVaultPathDisposition.Blocked, "linux_vault_root_missing");
            }

            if (IsSymbolicLink(root.CanonicalPath))
            {
                return new(LinuxVaultPathDisposition.Blocked, "linux_vault_root_symlink_rejected");
            }

            string canonical = TrimRoot(ResolveRealPath(root.CanonicalPath));
            if (!string.Equals(canonical, root.CanonicalPath, StringComparison.Ordinal))
            {
                return new(LinuxVaultPathDisposition.Blocked, "linux_vault_root_changed");
            }

            MountRecord mount = ResolveMount(canonical);
            if (mount.MountIdentity != root.Filesystem.MountIdentity
                || !string.Equals(mount.FileSystemType, root.Filesystem.FileSystemType, StringComparison.Ordinal))
            {
                return new(LinuxVaultPathDisposition.Blocked, "linux_vault_mount_changed");
            }

            if (!HasRequiredAccess(canonical))
            {
                return new(LinuxVaultPathDisposition.Blocked, "linux_vault_path_permission_blocked");
            }

            VerifyControlManifest(canonical, root.Manifest);
            return new(LinuxVaultPathDisposition.None, null);
        }
        catch (LinuxVaultWatcherException exception)
        {
            return new(LinuxVaultPathDisposition.Blocked, exception.ReasonCode);
        }
        catch (UnauthorizedAccessException)
        {
            return new(LinuxVaultPathDisposition.Blocked, "linux_vault_path_permission_blocked");
        }
    }

    internal static bool IsContained(string root, string candidate)
        => string.Equals(root, candidate, StringComparison.Ordinal)
            || (root == Path.DirectorySeparatorChar.ToString()
                ? candidate.StartsWith(Path.DirectorySeparatorChar)
                : candidate.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal));

    internal static string ResolveRealPath(string path)
    {
        nint pointer = InotifyNative.RealPath(path, nint.Zero);
        if (pointer == nint.Zero)
        {
            throw new LinuxVaultWatcherException("linux_vault_realpath_failed");
        }

        try
        {
            return System.Runtime.InteropServices.Marshal.PtrToStringUTF8(pointer)
                ?? throw new LinuxVaultWatcherException("linux_vault_realpath_failed");
        }
        finally
        {
            InotifyNative.Free(pointer);
        }
    }

    private static PathVerification VerifyExistingParent(VerifiedLinuxVaultRoot root, string parentPath)
    {
        string current = parentPath;
        while (!Path.Exists(current) && IsContained(root.CanonicalPath, current))
        {
            current = Path.GetDirectoryName(current) ?? string.Empty;
        }

        if (!IsContained(root.CanonicalPath, current) || IsSymbolicLink(current))
        {
            return new(LinuxVaultPathDisposition.Blocked, "linux_vault_missing_path_parent_invalid");
        }

        try
        {
            string canonicalParent = TrimRoot(ResolveRealPath(current));
            MountRecord mount = ResolveMount(canonicalParent);
            if (!IsContained(root.CanonicalPath, canonicalParent)
                || mount.MountIdentity != root.Filesystem.MountIdentity)
            {
                return new(LinuxVaultPathDisposition.Blocked, "linux_vault_missing_path_parent_changed");
            }

            return new(LinuxVaultPathDisposition.MissingEntry, null);
        }
        catch (LinuxVaultWatcherException exception)
        {
            return new(LinuxVaultPathDisposition.Blocked, exception.ReasonCode);
        }
    }

    private static void VerifyControlManifest(string root, ArticleVaultRootManifest expected)
    {
        string controlDirectory = Path.Combine(root, ".fsus");
        string manifestPath = Path.Combine(root, ArticleVaultSchemas.RootManifestPath.Replace('/', Path.DirectorySeparatorChar));
        if (!Directory.Exists(controlDirectory)
            || IsSymbolicLink(controlDirectory)
            || !File.Exists(manifestPath)
            || IsSymbolicLink(manifestPath))
        {
            throw new LinuxVaultWatcherException("linux_vault_control_tree_missing_or_unsafe");
        }

        ArticleVaultRootManifest actual;
        try
        {
            using var stream = new FileStream(manifestPath, FileMode.Open, FileAccess.Read, FileShare.Read, bufferSize: 1);
            actual = ReadControlManifest(stream);
        }
        catch (LinuxVaultWatcherException)
        {
            throw;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            throw new LinuxVaultWatcherException("linux_vault_root_manifest_unreadable", exception);
        }

        ArticleVaultValidationResult actualResult = ArticleVaultManifestValidator.Validate(actual);
        if (!actualResult.IsValid
            || !string.Equals(actual.ContentSha256, expected.ContentSha256, StringComparison.Ordinal)
            || !string.Equals(actual.SiteIdentity, expected.SiteIdentity, StringComparison.Ordinal)
            || !string.Equals(actual.VaultIdentity, expected.VaultIdentity, StringComparison.Ordinal)
            || !string.Equals(actual.DeviceIdentity, expected.DeviceIdentity, StringComparison.Ordinal))
        {
            throw new LinuxVaultWatcherException("linux_vault_root_manifest_binding_mismatch");
        }
    }

    private static ArticleVaultRootManifest ReadControlManifest(Stream stream)
    {
        // The raw-byte budget includes one sentinel, even if the file grows after opening.
        // Short reads are not EOF; never deserialize a truncated prefix of an oversized manifest.
        byte[] bytes = new byte[MaxControlManifestBytes + 1];
        int length = stream.ReadAtLeast(bytes, bytes.Length, throwOnEndOfStream: false);
        if (length > MaxControlManifestBytes)
        {
            throw new LinuxVaultWatcherException("linux_vault_root_manifest_too_large");
        }

        return ArticleVaultManifestCodec.DeserializeRoot(bytes.AsSpan(0, length));
    }

    private static MountRecord ResolveMount(string canonicalPath)
    {
        MountRecord? selected = null;
        foreach (string line in File.ReadLines("/proc/self/mountinfo"))
        {
            int separator = line.IndexOf(" - ", StringComparison.Ordinal);
            if (separator < 0)
            {
                continue;
            }

            string[] left = line[..separator].Split(' ', StringSplitOptions.RemoveEmptyEntries);
            string[] right = line[(separator + 3)..].Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (left.Length < 5 || right.Length < 1 || !int.TryParse(left[0], out int mountIdentity))
            {
                continue;
            }

            string mountPoint = TrimRoot(UnescapeMountInfo(left[4]));
            if (!IsContained(mountPoint, canonicalPath))
            {
                continue;
            }

            if (selected is null || mountPoint.Length > selected.MountPoint.Length)
            {
                selected = new(mountIdentity, mountPoint, right[0]);
            }
        }

        return selected ?? throw new LinuxVaultWatcherException("linux_vault_mount_unknown");
    }

    private static string UnescapeMountInfo(string value)
        => value.Replace("\\040", " ", StringComparison.Ordinal)
            .Replace("\\011", "\t", StringComparison.Ordinal)
            .Replace("\\012", "\n", StringComparison.Ordinal)
            .Replace("\\134", "\\", StringComparison.Ordinal);

    private static bool IsSafeRelativePath(string value)
    {
        if (string.IsNullOrWhiteSpace(value)
            || value.IndexOfAny(['\0', '\r', '\n', '\\']) >= 0
            || Path.IsPathFullyQualified(value))
        {
            return false;
        }

        string[] segments = value.Split('/', StringSplitOptions.None);
        return segments.All(static segment => segment.Length > 0 && segment is not "." and not "..");
    }

    private static bool IsSymbolicLink(string path)
    {
        FileSystemInfo info = Directory.Exists(path) ? new DirectoryInfo(path) : new FileInfo(path);
        try
        {
            return info.LinkTarget is not null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return true;
        }
    }

    private static bool HasRequiredAccess(string path)
    {
        if (!OperatingSystem.IsLinux())
        {
            return false;
        }

        try
        {
            UnixFileMode mode = File.GetUnixFileMode(path);
            UnixFileMode read = UnixFileMode.UserRead | UnixFileMode.GroupRead | UnixFileMode.OtherRead;
            if ((mode & read) == 0)
            {
                return false;
            }

            if (!Directory.Exists(path))
            {
                return true;
            }

            UnixFileMode execute = UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute;
            return (mode & execute) != 0;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static bool IsIdentity(string value)
        => !string.IsNullOrWhiteSpace(value)
            && value.Length <= 256
            && value.IndexOfAny(['\0', '\r', '\n', '/', '\\']) < 0;

    private static string TrimRoot(string path)
        => path == Path.DirectorySeparatorChar.ToString()
            ? path
            : Path.TrimEndingDirectorySeparator(path);

    private static string ComputeSha256(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    internal sealed record VerifiedLinuxVaultRoot(
        string CanonicalPath,
        string RootIdentity,
        LinuxVaultFilesystemSemantics Filesystem,
        ArticleVaultRootManifest Manifest);

    internal readonly record struct PathVerification(
        LinuxVaultPathDisposition Disposition,
        string? ErrorCode);

    private sealed record MountRecord(int MountIdentity, string MountPoint, string FileSystemType);
}
