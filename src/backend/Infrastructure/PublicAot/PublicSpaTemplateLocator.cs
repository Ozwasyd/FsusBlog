using System.Collections.Concurrent;
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
    private static readonly byte[] s_minimalIndexTemplateBytes = Encoding.UTF8.GetBytes(MinimalIndexTemplate);
    private static readonly ConcurrentDictionary<string, string> s_assetPathCache = new(StringComparer.Ordinal);
    private static readonly ConcurrentDictionary<string, TemplateSnapshot> s_templateCache = new(StringComparer.Ordinal);

    internal static string ResolveIndexTemplatePath(
        IWebHostEnvironment env,
        bool preferSourceTemplate = false,
        string boundIndexPath = "")
    {
        if (!env.IsDevelopment())
        {
            return !string.IsNullOrWhiteSpace(boundIndexPath) && File.Exists(boundIndexPath)
                ? Path.GetFullPath(boundIndexPath)
                : string.Empty;
        }

        string contentRoot = env.ContentRootPath;
        string contentRootParent = Path.GetFullPath(Path.Combine(contentRoot, ".."));
        string appBase = AppContext.BaseDirectory;
        string appBaseParent = Path.GetFullPath(Path.Combine(appBase, ".."));
        string configuredWebRootIndex = string.IsNullOrWhiteSpace(env.WebRootPath)
            ? string.Empty
            : Path.Combine(env.WebRootPath, "index.html");

        string[] distCandidates =
        [
            configuredWebRootIndex,
            Path.Combine(contentRoot, "..", "frontend", "dist", "index.html"),
            Path.Combine(contentRoot, "..", "..", "frontend", "dist", "index.html"),
            Path.Combine(contentRoot, "FsusBlog.Client", "dist", "index.html"),
            Path.Combine(contentRootParent, "FsusBlog.Client", "dist", "index.html"),
            Path.Combine(appBaseParent, "FsusBlog.Client", "dist", "index.html"),
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

    internal static async Task<string> ReadIndexTemplateAsync(
        IWebHostEnvironment env,
        CancellationToken cancellationToken,
        bool preferSourceTemplate = false,
        string boundIndexPath = "")
        => (await GetTemplateSnapshotAsync(env, cancellationToken, preferSourceTemplate, boundIndexPath)).Text;

    internal static async Task<ReadOnlyMemory<byte>> ReadIndexTemplateBytesAsync(
        IWebHostEnvironment env,
        CancellationToken cancellationToken,
        bool preferSourceTemplate = false,
        string boundIndexPath = "")
        => (await GetTemplateSnapshotAsync(env, cancellationToken, preferSourceTemplate, boundIndexPath)).Bytes;

    internal static async Task<string> ReadFrontendAssetVersionAsync(
        IWebHostEnvironment env,
        CancellationToken cancellationToken,
        bool preferSourceTemplate = false,
        string boundIndexPath = "")
        => (await GetTemplateSnapshotAsync(env, cancellationToken, preferSourceTemplate, boundIndexPath)).AssetVersion;

    internal static string ResolveAssetPath(IWebHostEnvironment env, string prefix, string extension)
    {
        if (!env.IsDevelopment())
            return string.Empty;

        string assetsRoot = Path.Combine(env.WebRootPath ?? string.Empty, "assets");
        if (!Directory.Exists(assetsRoot))
            return string.Empty;

        string cacheKey = string.Concat(Path.GetFullPath(assetsRoot), '|', prefix, '|', extension);
        return s_assetPathCache.GetOrAdd(cacheKey, _ => ResolveAssetPathUncached(assetsRoot, prefix, extension));
    }

    private static string ResolveAssetPathUncached(string assetsRoot, string prefix, string extension)
    {
        var file = Directory.GetFiles(assetsRoot, $"{prefix}*.{extension}")
            .Select(Path.GetFileName)
            .OrderByDescending(f => f)
            .FirstOrDefault();

        return file != null ? $"/assets/{file}" : string.Empty;
    }

    internal static string BuildMinimalIndexHtml() => MinimalIndexTemplate;

    internal static void ResetCacheForTests()
    {
        s_templateCache.Clear();
        s_assetPathCache.Clear();
    }

    private static async Task<TemplateSnapshot> GetTemplateSnapshotAsync(
        IWebHostEnvironment env,
        CancellationToken cancellationToken,
        bool preferSourceTemplate,
        string boundIndexPath)
    {
        bool isDevelopment = env.IsDevelopment();
        bool canUseCachedTemplate = !preferSourceTemplate || !isDevelopment;
        string indexPath = ResolveIndexTemplatePath(env, preferSourceTemplate, boundIndexPath);

        if (string.IsNullOrWhiteSpace(indexPath))
        {
            if (!isDevelopment)
            {
                throw new InvalidOperationException("spa_index_template_unavailable");
            }
            string minimalKey = string.Concat("minimal|", Path.GetFullPath(env.ContentRootPath), '|', preferSourceTemplate ? "source" : "dist");
            return canUseCachedTemplate
                ? s_templateCache.GetOrAdd(minimalKey, static _ => TemplateSnapshot.Minimal)
                : TemplateSnapshot.Minimal;
        }

        DateTime lastWriteTimeUtc = isDevelopment
            ? File.GetLastWriteTimeUtc(indexPath)
            : DateTime.MinValue;
        string cacheKey = string.Concat(
            Path.GetFullPath(indexPath),
            '|',
            lastWriteTimeUtc.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture),
            '|',
            preferSourceTemplate ? "source" : "dist");
        if (canUseCachedTemplate && s_templateCache.TryGetValue(cacheKey, out TemplateSnapshot? cachedTemplate))
        {
            return cachedTemplate;
        }

        byte[] bytes = await File.ReadAllBytesAsync(indexPath, cancellationToken);
        var snapshot = new TemplateSnapshot(
            indexPath,
            lastWriteTimeUtc,
            bytes,
            ComputeAssetVersion(bytes));

        if (canUseCachedTemplate)
        {
            s_templateCache[cacheKey] = snapshot;
        }

        return snapshot;
    }

    private static string ComputeAssetVersion(ReadOnlySpan<byte> bytes)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        return Convert.ToHexStringLower(hash);
    }

    private sealed record TemplateSnapshot(string Path, DateTime LastWriteTimeUtc, byte[] Bytes, string AssetVersion)
    {
        public static TemplateSnapshot Minimal
        {
            get;
        } = new(
            string.Empty,
            DateTime.MinValue,
            s_minimalIndexTemplateBytes,
            ComputeAssetVersion(s_minimalIndexTemplateBytes));

        private string? _lazyText;

        public string Text => _lazyText ??= Encoding.UTF8.GetString(Bytes);
    }
}
