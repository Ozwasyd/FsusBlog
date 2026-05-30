using System.Collections.Frozen;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Infrastructure.Spa;

public interface ISpaAssetManifestService
{
    IReadOnlyList<string> GetPreloadsForPath(string path, HttpContext? context = null);

    SpaAssetSet GetPublicAssetSet(HttpContext? context = null);

    string GetFrontendAssetVersion();
}

public sealed class SpaAssetManifestService : ISpaAssetManifestService
{
    private const string StableSpaEntry = "/assets/fsus-spa-entry.js";
    private static readonly string[] PublicCriticalCssNames =
    [
        "public-shell-critical",
        "tailwind",
        "vendor-element-plus",
        "markdown",
        "public-page",
        "full-app-core",
        "entry-runtime",
        "vendor-progress"
    ];
    private static readonly string[] PublicPrimaryCssNames =
    [
        "index",
        "main",
        "public-page-runtime",
    ];
    private static readonly Regex StringPropertyRegex = new(
        "\"(?<name>[^\"]+)\"\\s*:\\s*\"(?<value>[^\"]*)\"",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex ArrayStringRegex = new(
        "\"(?<value>[^\"]*)\"",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private readonly IWebHostEnvironment _env;
    private readonly ILogger<SpaAssetManifestService> _logger;
    private readonly Lock _loadLock = new();
    private FrozenDictionary<string, List<string>> _routeAssetMap = FrozenDictionary<string, List<string>>.Empty;
    private FrozenDictionary<string, ManifestAsset> _manifestByKey = FrozenDictionary<string, ManifestAsset>.Empty;
    private DateTime _lastManifestWriteTime = DateTime.MinValue;
    private string _manifestPath = string.Empty;
    private string _frontendAssetVersion = "missing-manifest";
    private SpaAssetSet _publicAssetSet = new(
        StableSpaEntry,
        [],
        [],
        "missing-manifest",
        UsesSourceAssets: false);

    public SpaAssetManifestService(IWebHostEnvironment env, ILogger<SpaAssetManifestService> logger)
    {
        _env = env;
        _logger = logger;
        LoadManifest();
    }

    public IReadOnlyList<string> GetPreloadsForPath(string path, HttpContext? context = null)
    {
        if (ShouldUseSourceAssets(context))
        {
            return [];
        }

        LoadManifest();

        if (string.IsNullOrWhiteSpace(path))
        {
            return [];
        }

        if (path.StartsWith("/user/", StringComparison.OrdinalIgnoreCase))
        {
            return GetAssets("route-user");
        }

        if (path.StartsWith("/admin/", StringComparison.OrdinalIgnoreCase))
        {
            return GetAssets("route-admin");
        }

        if (path.StartsWith("/login", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/register", StringComparison.OrdinalIgnoreCase))
        {
            return GetAssets("route-auth");
        }

        if (path.StartsWith("/403", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/404", StringComparison.OrdinalIgnoreCase))
        {
            return GetAssets("route-error");
        }

        return [];
    }

    public SpaAssetSet GetPublicAssetSet(HttpContext? context = null)
    {
        if (ShouldUseSourceAssets(context))
        {
            return new SpaAssetSet(
                "/src/bootstrap/entry.ts",
                [
                    "/src/assets/public-shell-critical.css",
                    "/src/assets/tailwind.css",
                    "/src/assets/markdown.css",
                    "/src/assets/public-page.css?direct"
                ],
                [],
                GetFrontendAssetVersion(),
                UsesSourceAssets: true);
        }

        LoadManifest();
        return _publicAssetSet;
    }

    public string GetFrontendAssetVersion()
    {
        LoadManifest();
        return _frontendAssetVersion;
    }

    private List<string> GetAssets(string key)
        => _routeAssetMap.TryGetValue(key, out var assets) ? assets : [];

    private bool ShouldUseSourceAssets(HttpContext? context)
    {
        if (!_env.IsDevelopment() || context is null)
        {
            return false;
        }

        string forwardedHost = context.Request.Headers["X-Forwarded-Host"].ToString();
        string host = string.IsNullOrWhiteSpace(forwardedHost)
            ? context.Request.Host.Value ?? string.Empty
            : forwardedHost;

        return host.Contains(":3000", StringComparison.Ordinal);
    }

    private void LoadManifest()
    {
        string manifestPath = ResolveCurrentManifestPath();
        if (string.IsNullOrWhiteSpace(manifestPath) || !File.Exists(manifestPath))
        {
            _frontendAssetVersion = ComputeFallbackAssetVersion();
            _publicAssetSet = CreatePublicAssetSet(FrozenDictionary<string, ManifestAsset>.Empty, _frontendAssetVersion);
            return;
        }

        DateTime lastWrite = File.GetLastWriteTimeUtc(manifestPath);
        if (lastWrite <= _lastManifestWriteTime && string.Equals(manifestPath, _manifestPath, StringComparison.Ordinal))
        {
            return;
        }

        lock (_loadLock)
        {
            if (lastWrite <= _lastManifestWriteTime && string.Equals(manifestPath, _manifestPath, StringComparison.Ordinal))
            {
                return;
            }

            try
            {
                string manifestText = File.ReadAllText(manifestPath);
                var newRouteMap = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
                var newManifest = new Dictionary<string, ManifestAsset>(StringComparer.OrdinalIgnoreCase);

                foreach ((string key, string body) in EnumerateManifestEntries(manifestText))
                {
                    string file = TryReadString(body, "file");
                    string name = TryReadString(body, "name");
                    string src = TryReadString(body, "src");
                    string[] css = ReadStringArray(body, "css");
                    string[] imports = ReadStringArray(body, "imports");

                    var asset = new ManifestAsset(
                        key,
                        name,
                        src,
                        ToAssetHref(file),
                        [.. css.Select(ToAssetHref).Where(static href => href.Length > 0)],
                        [.. imports]);
                    newManifest[key] = asset;
                    if (!string.IsNullOrWhiteSpace(name))
                    {
                        if (!newRouteMap.TryGetValue(name, out List<string>? routeAssets))
                        {
                            routeAssets = [];
                            newRouteMap[name] = routeAssets;
                        }

                        if (!string.IsNullOrWhiteSpace(asset.File))
                        {
                            routeAssets.Add(asset.File);
                        }

                        routeAssets.AddRange(asset.Css);
                    }
                }

                FrozenDictionary<string, ManifestAsset> manifestSnapshot = newManifest.ToFrozenDictionary(StringComparer.OrdinalIgnoreCase);
                _manifestByKey = manifestSnapshot;
                _routeAssetMap = newRouteMap.ToFrozenDictionary(StringComparer.OrdinalIgnoreCase);
                _manifestPath = manifestPath;
                _lastManifestWriteTime = lastWrite;
                _frontendAssetVersion = ComputeAssetVersion(manifestPath);
                _publicAssetSet = CreatePublicAssetSet(manifestSnapshot, _frontendAssetVersion);
                _logger.LogInformation("SPA manifest loaded from {ManifestPath}. chunks={ChunkCount}", manifestPath, _manifestByKey.Count);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to load SPA asset manifest from {ManifestPath}", manifestPath);
                _frontendAssetVersion = ComputeFallbackAssetVersion();
                _publicAssetSet = CreatePublicAssetSet(_manifestByKey, _frontendAssetVersion);
            }
        }
    }

    private SpaAssetSet CreatePublicAssetSet(
        IReadOnlyDictionary<string, ManifestAsset> manifest,
        string frontendAssetVersion)
        => new(
            StableSpaEntry,
            PickPublicStylesheets(manifest),
            PickPublicModulePreloads(manifest),
            frontendAssetVersion,
            UsesSourceAssets: false);

    private string ResolveCurrentManifestPath()
    {
        string currentManifestPath = _manifestPath;
        return !string.IsNullOrWhiteSpace(currentManifestPath) && File.Exists(currentManifestPath)
            ? currentManifestPath
            : ResolveManifestPath();
    }

    private string ResolveManifestPath()
    {
        string webRoot = string.IsNullOrWhiteSpace(_env.WebRootPath)
            ? Path.Combine(_env.ContentRootPath, "wwwroot")
            : _env.WebRootPath;
        string contentRootParent = Path.GetFullPath(Path.Combine(_env.ContentRootPath, ".."));
        string appBaseParent = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, ".."));
        string[] candidates =
        [
            Path.Combine(webRoot, ".vite", "manifest.json"),
            Path.Combine(_env.ContentRootPath, "..", "frontend", "dist", ".vite", "manifest.json"),
            Path.Combine(_env.ContentRootPath, "..", "..", "frontend", "dist", ".vite", "manifest.json"),
            Path.Combine(_env.ContentRootPath, "FsusBlog.Client", "dist", ".vite", "manifest.json"),
            Path.Combine(contentRootParent, "FsusBlog.Client", "dist", ".vite", "manifest.json"),
            Path.Combine(appBaseParent, "FsusBlog.Client", "dist", ".vite", "manifest.json")
        ];

        return candidates.FirstOrDefault(File.Exists) ?? string.Empty;
    }

    private IReadOnlyList<string> PickPublicStylesheets(IReadOnlyDictionary<string, ManifestAsset> manifest)
    {
        var styles = new List<string>();
        foreach (string needle in PublicCriticalCssNames.Concat(PublicPrimaryCssNames))
        {
            string? css = manifest.Values
                .SelectMany(static asset => asset.Css)
                .FirstOrDefault(href => href.Contains(needle, StringComparison.OrdinalIgnoreCase));
            if (!string.IsNullOrWhiteSpace(css) && !styles.Contains(css, StringComparer.Ordinal))
            {
                styles.Add(css);
            }
        }

        if (styles.Count == 0)
        {
            styles.AddRange(PickCssFromAssetsDirectory());
        }

        return styles.ToArray();
    }

    private static IReadOnlyList<string> PickPublicModulePreloads(IReadOnlyDictionary<string, ManifestAsset> manifest)
        => manifest.Values
            .Where(static asset => !string.IsNullOrWhiteSpace(asset.File) &&
                asset.File.EndsWith(".js", StringComparison.OrdinalIgnoreCase) &&
                (asset.File.Contains("entry-runtime-", StringComparison.OrdinalIgnoreCase) ||
                 asset.File.Contains("full-app-core-", StringComparison.OrdinalIgnoreCase)))
            .Select(static asset => asset.File)
            .Distinct(StringComparer.Ordinal)
            .ToArray();

    private IEnumerable<string> PickCssFromAssetsDirectory()
    {
        string assetsRoot = Path.Combine(string.IsNullOrWhiteSpace(_env.WebRootPath)
            ? Path.Combine(_env.ContentRootPath, "wwwroot")
            : _env.WebRootPath, "assets");
        if (!Directory.Exists(assetsRoot))
        {
            yield break;
        }

        foreach (string prefix in PublicCriticalCssNames.Concat(PublicPrimaryCssNames))
        {
            string? file = Directory.GetFiles(assetsRoot, $"{prefix}*.css", SearchOption.TopDirectoryOnly)
                .Select(Path.GetFileName)
                .Where(static name => !string.IsNullOrWhiteSpace(name))
                .OrderByDescending(static name => name, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
            if (!string.IsNullOrWhiteSpace(file))
            {
                yield return $"/assets/{file}";
            }
        }
    }

    private string ComputeFallbackAssetVersion()
    {
        string webRoot = string.IsNullOrWhiteSpace(_env.WebRootPath)
            ? Path.Combine(_env.ContentRootPath, "wwwroot")
            : _env.WebRootPath;
        string indexPath = Path.Combine(webRoot, "index.html");
        return File.Exists(indexPath)
            ? ComputeSha256(File.ReadAllBytes(indexPath))
            : "missing-manifest";
    }

    private string ComputeAssetVersion(string manifestPath)
    {
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        string? manifestDirectory = Path.GetDirectoryName(manifestPath);
        string? distRoot = manifestDirectory is null ? null : Path.GetFullPath(Path.Combine(manifestDirectory, ".."));
        string? indexPath = distRoot is null ? null : Path.Combine(distRoot, "index.html");
        if (indexPath is not null && File.Exists(indexPath))
        {
            sha.AppendData(File.ReadAllBytes(indexPath));
        }

        sha.AppendData(File.ReadAllBytes(manifestPath));
        return Convert.ToHexStringLower(sha.GetHashAndReset());
    }

    private static string ComputeSha256(byte[] bytes)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        return Convert.ToHexStringLower(hash);
    }

    private static IEnumerable<(string Key, string Body)> EnumerateManifestEntries(string text)
    {
        int offset = 0;
        while (TryReadQuotedString(text, offset, out string key, out int keyEnd))
        {
            int colon = text.IndexOf(':', keyEnd);
            if (colon < 0)
            {
                yield break;
            }

            int objectStart = text.IndexOf('{', colon);
            if (objectStart < 0)
            {
                yield break;
            }

            int objectEnd = FindMatchingBrace(text, objectStart);
            if (objectEnd < 0)
            {
                yield break;
            }

            yield return (key, text[(objectStart + 1)..objectEnd]);
            offset = objectEnd + 1;
        }
    }

    private static string TryReadString(string body, string propertyName)
    {
        foreach (Match match in StringPropertyRegex.Matches(body))
        {
            if (string.Equals(match.Groups["name"].Value, propertyName, StringComparison.Ordinal))
            {
                return Regex.Unescape(match.Groups["value"].Value);
            }
        }

        return string.Empty;
    }

    private static string[] ReadStringArray(string body, string propertyName)
    {
        string token = $"\"{propertyName}\"";
        int propertyIndex = body.IndexOf(token, StringComparison.Ordinal);
        if (propertyIndex < 0)
        {
            return [];
        }

        int arrayStart = body.IndexOf('[', propertyIndex);
        if (arrayStart < 0)
        {
            return [];
        }

        int arrayEnd = body.IndexOf(']', arrayStart);
        if (arrayEnd < 0)
        {
            return [];
        }

        return ArrayStringRegex.Matches(body[(arrayStart + 1)..arrayEnd])
            .Select(static match => Regex.Unescape(match.Groups["value"].Value))
            .Where(static value => value.Length > 0)
            .ToArray();
    }

    private static bool TryReadQuotedString(string text, int offset, out string value, out int end)
    {
        value = string.Empty;
        end = offset;
        int start = text.IndexOf('"', offset);
        if (start < 0)
        {
            return false;
        }

        var builder = new System.Text.StringBuilder();
        bool escaped = false;
        for (int i = start + 1; i < text.Length; i++)
        {
            char current = text[i];
            if (escaped)
            {
                builder.Append(current);
                escaped = false;
                continue;
            }

            if (current == '\\')
            {
                escaped = true;
                continue;
            }

            if (current == '"')
            {
                value = Regex.Unescape(builder.ToString());
                end = i + 1;
                return true;
            }

            builder.Append(current);
        }

        return false;
    }

    private static int FindMatchingBrace(string text, int start)
    {
        int depth = 0;
        bool inString = false;
        bool escaped = false;
        for (int i = start; i < text.Length; i++)
        {
            char current = text[i];
            if (inString)
            {
                if (escaped)
                {
                    escaped = false;
                    continue;
                }

                if (current == '\\')
                {
                    escaped = true;
                    continue;
                }

                if (current == '"')
                {
                    inString = false;
                }

                continue;
            }

            if (current == '"')
            {
                inString = true;
                continue;
            }

            if (current == '{')
            {
                depth++;
                continue;
            }

            if (current == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return i;
                }
            }
        }

        return -1;
    }

    private static string ToAssetHref(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return string.Empty;
        }

        string normalized = path.Replace('\\', '/').TrimStart('/');
        return normalized.StartsWith("assets/", StringComparison.OrdinalIgnoreCase)
            ? "/" + normalized
            : "/assets/" + Path.GetFileName(normalized);
    }

    private sealed record ManifestAsset(
        string Key,
        string Name,
        string Src,
        string File,
        IReadOnlyList<string> Css,
        IReadOnlyList<string> Imports);
}
