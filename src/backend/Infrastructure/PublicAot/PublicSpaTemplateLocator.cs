using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal static class PublicSpaTemplateLocator
{
    private const string MinimalIndexTemplate = """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Loading...</title>
</head>
<body>
    <div id="app"></div>
</body>
</html>
""";
    private static readonly byte[] MinimalIndexTemplateBytes = Encoding.UTF8.GetBytes(MinimalIndexTemplate);
    private static readonly Lock CacheGate = new();
    private static TemplateSnapshot? _cachedTemplate;

    internal static string ResolveIndexTemplatePath(IWebHostEnvironment env, bool preferSourceTemplate = false)
    {
        string contentRoot = env.ContentRootPath;
        string contentRootParent = Path.GetFullPath(Path.Combine(contentRoot, ".."));
        string appBase = AppContext.BaseDirectory;
        string appBaseParent = Path.GetFullPath(Path.Combine(appBase, ".."));

        string[] distCandidates =
        [
            Path.Combine(contentRoot, "..", "frontend", "dist", "index.html"),
            Path.Combine(contentRoot, "..", "..", "frontend", "dist", "index.html"),
            Path.Combine(contentRoot, "FsusBlog.Client", "dist", "index.html"),
            Path.Combine(contentRootParent, "FsusBlog.Client", "dist", "index.html"),
            Path.Combine(appBaseParent, "FsusBlog.Client", "dist", "index.html"),
            Path.Combine(env.WebRootPath ?? string.Empty, "index.html"),
            Path.Combine(AppContext.BaseDirectory, "wwwroot", "index.html")
        ];

        string[] sourceCandidates =
        [
            Path.Combine(contentRoot, "..", "frontend", "index.html"),
            Path.Combine(contentRoot, "..", "..", "frontend", "index.html"),
            Path.Combine(contentRoot, "FsusBlog.Client", "index.html"),
            Path.Combine(contentRootParent, "FsusBlog.Client", "index.html"),
            Path.Combine(appBaseParent, "FsusBlog.Client", "index.html")
        ];

        string[] candidates = preferSourceTemplate
            ? [.. sourceCandidates, .. distCandidates]
            : [.. distCandidates, .. sourceCandidates];

        foreach (string candidate in candidates)
        {
            if (!string.IsNullOrWhiteSpace(candidate) && File.Exists(candidate))
            {
                return candidate;
            }
        }

        return string.Empty;
    }

    internal static async Task<string> ReadIndexTemplateAsync(IWebHostEnvironment env, CancellationToken cancellationToken, bool preferSourceTemplate = false)
        => (await GetTemplateSnapshotAsync(env, cancellationToken, preferSourceTemplate)).Text;

    internal static async Task<ReadOnlyMemory<byte>> ReadIndexTemplateBytesAsync(IWebHostEnvironment env, CancellationToken cancellationToken, bool preferSourceTemplate = false)
        => (await GetTemplateSnapshotAsync(env, cancellationToken, preferSourceTemplate)).Bytes;

    internal static async Task<string> ReadFrontendAssetVersionAsync(IWebHostEnvironment env, CancellationToken cancellationToken, bool preferSourceTemplate = false)
        => (await GetTemplateSnapshotAsync(env, cancellationToken, preferSourceTemplate)).AssetVersion;

    internal static string ResolveAssetPath(IWebHostEnvironment env, string prefix, string extension)
    {
        string assetsRoot = Path.Combine(env.WebRootPath ?? string.Empty, "assets");
        if (!Directory.Exists(assetsRoot)) return string.Empty;

        var file = Directory.GetFiles(assetsRoot, $"{prefix}*.{extension}")
            .Select(Path.GetFileName)
            .OrderByDescending(f => f)
            .FirstOrDefault();

        return file != null ? $"/assets/{file}" : string.Empty;
    }

    internal static string BuildMinimalIndexHtml() => MinimalIndexTemplate;

    internal static void ResetCacheForTests()
    {
        lock (CacheGate)
        {
            _cachedTemplate = null;
        }
    }

    private static async Task<TemplateSnapshot> GetTemplateSnapshotAsync(IWebHostEnvironment env, CancellationToken cancellationToken, bool preferSourceTemplate)
    {
        bool canUseCachedTemplate = !preferSourceTemplate || !env.IsDevelopment();
        string indexPath = string.Empty;
        if (canUseCachedTemplate)
        {
            lock (CacheGate)
            {
                if (_cachedTemplate is { Path.Length: > 0 } cachedTemplate && File.Exists(cachedTemplate.Path))
                {
                    indexPath = cachedTemplate.Path;
                }
            }
        }

        if (string.IsNullOrWhiteSpace(indexPath))
        {
            indexPath = ResolveIndexTemplatePath(env, preferSourceTemplate);
        }

        if (string.IsNullOrWhiteSpace(indexPath))
        {
            return TemplateSnapshot.Minimal;
        }

        DateTime lastWriteTimeUtc = File.GetLastWriteTimeUtc(indexPath);

        if (canUseCachedTemplate)
        {
            lock (CacheGate)
            {
                if (_cachedTemplate is not null
                    && string.Equals(_cachedTemplate.Path, indexPath, StringComparison.Ordinal)
                    && _cachedTemplate.LastWriteTimeUtc == lastWriteTimeUtc)
                {
                    return _cachedTemplate;
                }
            }
        }

        byte[] bytes = await File.ReadAllBytesAsync(indexPath, cancellationToken);
        var snapshot = new TemplateSnapshot(
            indexPath,
            lastWriteTimeUtc,
            bytes,
            Encoding.UTF8.GetString(bytes),
            ComputeAssetVersion(bytes));

        if (canUseCachedTemplate)
        {
            lock (CacheGate)
            {
                _cachedTemplate = snapshot;
            }
        }

        return snapshot;
    }

    private static string ComputeAssetVersion(ReadOnlySpan<byte> bytes)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        return Convert.ToHexStringLower(hash);
    }

    private sealed record TemplateSnapshot(string Path, DateTime LastWriteTimeUtc, byte[] Bytes, string Text, string AssetVersion)
    {
        public static TemplateSnapshot Minimal { get; } = new(
            string.Empty,
            DateTime.MinValue,
            MinimalIndexTemplateBytes,
            MinimalIndexTemplate,
            ComputeAssetVersion(MinimalIndexTemplateBytes));
    }
}
