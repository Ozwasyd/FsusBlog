namespace FsusBlog.V2.Server.Authoring;

internal sealed record PdfExportToolchain(string Root, string Python, string ResolvedPython, string Font,
    string FontDigest, string[] ReadRoots, string[] LibraryRoots)
{
    private const int MaximumManifest = 2 * 1024 * 1024;
    private const int MaximumFiles = 8192;
    private const int MaximumRoots = 64;
    private static readonly JsonSerializerOptions ManifestJson = new(JsonSerializerDefaults.Web)
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        PropertyNameCaseInsensitive = false,
        AllowDuplicateProperties = false,
        RespectRequiredConstructorParameters = true,
        MaxDepth = 8
    };

    internal static PdfExportToolchain Read(string? root, string? expectedDigest)
    {
        try
        {
            if (!IsPath(root) || !IsDigest(expectedDigest) || !Directory.Exists(root))
                throw Invalid();
            using var file = File.OpenRead(Path.Combine(root, "toolchain.json"));
            if (file.Length is < 1 or > MaximumManifest) throw Invalid();
            var manifest = new byte[(int)file.Length];
            file.ReadExactly(manifest);
            if (file.ReadByte() != -1 || !Matches(SHA256.HashData(manifest), expectedDigest)) throw Invalid();
            var resolved = JsonSerializer.Deserialize<Manifest>(manifest, ManifestJson) ?? throw Invalid();
            if (!IsPath(resolved.Python) || !IsPath(resolved.Font) || !IsBelow(root, resolved.Python) ||
                !AreRoots(resolved.ReadRoots) || !AreRoots(resolved.LibraryRoots) ||
                resolved.LibraryRoots.Any(path => path.Contains(':') || !IsReadable(path)) ||
                resolved.Files is not { Length: > 0 and <= MaximumFiles })
                throw Invalid();

            var python = new FileInfo(resolved.Python);
            var resolvedPython = python.ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? python.FullName;
            if (!IsPath(resolvedPython) || !IsReadable(resolvedPython)) throw Invalid();
            var digests = new Dictionary<string, string>(resolved.Files.Length, StringComparer.Ordinal);
            foreach (var entry in resolved.Files)
            {
                if (entry is null || !IsPath(entry.Path) || !IsDigest(entry.Sha256) ||
                    (!IsReadable(entry.Path) && !string.Equals(entry.Path, resolved.Font, StringComparison.Ordinal)) ||
                    !digests.TryAdd(entry.Path, entry.Sha256))
                    throw Invalid();
                using var contents = File.OpenRead(entry.Path);
                if (contents.Length > 128 * 1024 * 1024 || !Matches(SHA256.HashData(contents), entry.Sha256))
                    throw Invalid();
            }
            if (!digests.ContainsKey(resolved.Python) || !digests.ContainsKey(resolvedPython) ||
                !digests.TryGetValue(resolved.Font, out var fontDigest))
                throw Invalid();
            return new(root, resolved.Python, resolvedPython, resolved.Font, fontDigest, resolved.ReadRoots, resolved.LibraryRoots);

            bool IsReadable(string path) => IsBelow(root, path) || resolved.ReadRoots!.Any(directory => IsBelow(directory, path));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or ArgumentException)
        {
            throw Invalid();
        }
    }

    private static bool IsPath([System.Diagnostics.CodeAnalysis.NotNullWhen(true)] string? path) =>
        path is { Length: > 1 and <= 1024 } && !path.Any(char.IsControl) && Path.IsPathFullyQualified(path) &&
        !Path.EndsInDirectorySeparator(path) && string.Equals(Path.GetFullPath(path), path, StringComparison.Ordinal);

    private static bool AreRoots([System.Diagnostics.CodeAnalysis.NotNullWhen(true)] string[]? paths) =>
        paths is { Length: > 0 and <= MaximumRoots } && paths.All(path => IsPath(path) && Directory.Exists(path)) &&
        paths.Distinct(StringComparer.Ordinal).Count() == paths.Length;

    private static bool IsBelow(string root, string path) => string.Equals(root, path, StringComparison.Ordinal) ||
        (path.Length > root.Length && path[root.Length] == Path.DirectorySeparatorChar && path.StartsWith(root, StringComparison.Ordinal));

    private static bool IsDigest([System.Diagnostics.CodeAnalysis.NotNullWhen(true)] string? digest) =>
        digest is { Length: 64 } && digest.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool Matches(byte[] digest, string expected) =>
        string.Equals(Convert.ToHexStringLower(digest), expected, StringComparison.Ordinal);

    private static InvalidOperationException Invalid() => new("Offline PDF toolchain paths or checksums could not be verified.");

    private sealed record Manifest(string? Python, string? Font, string[]? ReadRoots, string[]? LibraryRoots, FileDigest?[]? Files);
    private sealed record FileDigest(string? Path, string? Sha256);
}
