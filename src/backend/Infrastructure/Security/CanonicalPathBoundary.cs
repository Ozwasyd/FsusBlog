namespace FsusBlog.Server.Infrastructure.Security;

internal static class CanonicalPathBoundary
{
    internal static bool TryResolveRelative(
        string rootDirectory,
        string? untrustedRelativePath,
        out string canonicalPath)
        => TryResolve(rootDirectory, untrustedRelativePath, allowAbsolutePath: false, out canonicalPath);

    internal static bool TryResolveCandidate(
        string rootDirectory,
        string? untrustedCandidatePath,
        out string canonicalPath)
        => TryResolve(rootDirectory, untrustedCandidatePath, allowAbsolutePath: true, out canonicalPath);

    private static bool TryResolve(
        string rootDirectory,
        string? untrustedPath,
        bool allowAbsolutePath,
        out string canonicalPath)
    {
        canonicalPath = string.Empty;
        if (string.IsNullOrWhiteSpace(rootDirectory) || string.IsNullOrWhiteSpace(untrustedPath))
        {
            return false;
        }

        try
        {
            string normalized = DecodeSeparators(untrustedPath.Trim());
            if (normalized.Length == 0 || normalized.Contains('\0', StringComparison.Ordinal))
            {
                return false;
            }

            normalized = normalized
                .Replace(Path.AltDirectorySeparatorChar, Path.DirectorySeparatorChar)
                .Replace('\\', Path.DirectorySeparatorChar);
            bool isAbsolute = Path.IsPathRooted(normalized);
            if (isAbsolute && !allowAbsolutePath)
            {
                return false;
            }

            string lexicalRoot = Path.GetFullPath(rootDirectory);
            if (!Directory.Exists(lexicalRoot))
            {
                return false;
            }

            string lexicalCandidate = Path.GetFullPath(
                isAbsolute ? normalized : Path.Combine(lexicalRoot, normalized));
            if (!IsWithin(lexicalRoot, lexicalCandidate))
            {
                return false;
            }

            string physicalRoot = ResolveExistingEntry(new DirectoryInfo(lexicalRoot));
            string relative = Path.GetRelativePath(lexicalRoot, lexicalCandidate);
            if (relative is "." or "")
            {
                canonicalPath = physicalRoot;
                return true;
            }

            string lexicalCursor = lexicalRoot;
            string physicalCursor = physicalRoot;
            foreach (string segment in relative.Split(
                Path.DirectorySeparatorChar,
                StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (segment is "." or "..")
                {
                    return false;
                }

                lexicalCursor = Path.Combine(lexicalCursor, segment);
                FileSystemInfo entry = Directory.Exists(lexicalCursor)
                    ? new DirectoryInfo(lexicalCursor)
                    : new FileInfo(lexicalCursor);
                string? linkTarget = entry.LinkTarget;
                if (!string.IsNullOrWhiteSpace(linkTarget))
                {
                    FileSystemInfo? resolved = entry.ResolveLinkTarget(returnFinalTarget: true);
                    if (resolved is null)
                    {
                        return false;
                    }

                    physicalCursor = Path.GetFullPath(resolved.FullName);
                }
                else
                {
                    physicalCursor = Path.GetFullPath(Path.Combine(physicalCursor, segment));
                }

                if (!IsWithin(physicalRoot, physicalCursor))
                {
                    return false;
                }
            }

            canonicalPath = physicalCursor;
            return true;
        }
        catch (Exception exception) when (exception is
            ArgumentException or
            IOException or
            NotSupportedException or
            UnauthorizedAccessException or
            UriFormatException)
        {
            canonicalPath = string.Empty;
            return false;
        }
    }

    private static string DecodeSeparators(string value)
    {
        string decoded = value;
        for (int pass = 0; pass < 2; pass++)
        {
            string next = Uri.UnescapeDataString(decoded);
            if (string.Equals(next, decoded, StringComparison.Ordinal))
            {
                break;
            }

            decoded = next;
        }

        return decoded;
    }

    private static string ResolveExistingEntry(FileSystemInfo entry)
    {
        FileSystemInfo? resolved = entry.ResolveLinkTarget(returnFinalTarget: true);
        return Path.GetFullPath(resolved?.FullName ?? entry.FullName);
    }

    private static bool IsWithin(string rootDirectory, string candidatePath)
    {
        string relative = Path.GetRelativePath(
            Path.GetFullPath(rootDirectory),
            Path.GetFullPath(candidatePath));
        return relative.Length == 0 ||
            (!relative.StartsWith("..", StringComparison.Ordinal) && !Path.IsPathRooted(relative));
    }
}
