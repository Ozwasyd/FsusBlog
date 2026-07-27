using System.Collections.Frozen;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Infrastructure.Spa;

public interface ISpaAssetManifestService
{
    IReadOnlyList<string> GetPreloadsForPath(string path, HttpContext? context = null);

    SpaAssetSet GetPublicAssetSet(HttpContext? context = null, PublicPageId? pageId = null);

    string GetFrontendAssetVersion(HttpContext? context = null);

    string GetIndexTemplatePath()
        => string.Empty;

    SpaAssetManifestReadiness GetReadiness()
        => SpaAssetManifestReadiness.Failed("spa_manifest_readiness_unavailable");
}

public sealed record SpaAssetManifestReadiness(
    string Status,
    string? DescriptorPath,
    string? DescriptorContentDigest,
    string? BuildReceiptPath,
    string? BuildReceiptDigest,
    string? SourceCommit,
    string? WorktreeFingerprint,
    string? ReleaseId,
    string? AssetRoot,
    string? IndexPath,
    string? ManifestPath,
    string? ManifestDigest,
    string? AssetInventoryPath,
    string? AssetInventoryDigest,
    string? Error) : IProductionHealthCheck
{
    internal static SpaAssetManifestReadiness Failed(string error)
        => new(
            "failed",
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            error);

    internal static SpaAssetManifestReadiness Ready(SpaManifestDescriptor descriptor)
        => new(
            "ok",
            descriptor.DescriptorPath,
            descriptor.DescriptorContentDigest,
            descriptor.BuildReceiptPath,
            descriptor.BuildReceiptDigest,
            descriptor.SourceCommit,
            descriptor.WorktreeFingerprint,
            descriptor.ReleaseId,
            descriptor.AssetRoot,
            descriptor.IndexPath,
            descriptor.ManifestPath,
            descriptor.ManifestDigest,
            descriptor.AssetInventoryPath,
            descriptor.AssetInventoryDigest,
            null);
}

public sealed class SpaAssetManifestService : ISpaAssetManifestService
{
    public const string DevSourceAssetVersion = "dev-source-assets";
    private const string StableSpaEntry = "/assets/fsus-spa-entry.js";
    private static readonly string[] s_publicBaseCssNames =
    [
        "public-shell-critical",
        "tailwind",
        "public-page"
    ];

    private static readonly string[] s_publicMarkdownCssNames =
    [
        "markdown"
    ];

    private static readonly string[] s_fullAppTakeoverModuleNames =
    [
        "entry-runtime",
        "public-page-runtime",
        "full-app-core",
        "vendor-runtime",
        "vendor-vue",
        "vendor-element-plus",
        "vendor-progress",
        "markdown-runtime"
    ];

    private static readonly string[] s_fullAppTakeoverCssNames =
    [
        "full-app-core",
        "vendor-element-plus",
        "vendor-progress",
        "route-user",
        "route-admin",
        "route-auth",
        "route-error",
        "index",
        "main"
    ];

    private static readonly FrozenSet<string> s_supportedManifestProperties =
    new[]
    {
        "file",
        "name",
        "src",
        "css",
        "imports",
        "dynamicImports",
        "assets",
        "isEntry",
        "isDynamicEntry"
    }.ToFrozenSet(StringComparer.Ordinal);

    // Machine-readable catalog: each owner must occur exactly once as a manifest entry name.
    private const string RequiredEntryCatalogJson = """
        {"owners":["route-public","entry-runtime","public-page-runtime","public-shell-critical","tailwind","public-page","full-app-core","route-user","route-admin","route-auth","route-error"]}
        """;

    private readonly IWebHostEnvironment _env;
    private readonly IConfiguration _configuration;
    private readonly IReleaseIdentityProvider _releaseIdentity;
    private readonly ILogger<SpaAssetManifestService> _logger;
    private readonly Lock _loadLock = new();
    private bool _manifestLoaded;
    private FrozenDictionary<string, List<string>> _routeAssetMap = FrozenDictionary<string, List<string>>.Empty;
    private FrozenDictionary<string, ManifestAsset> _manifestByKey = FrozenDictionary<string, ManifestAsset>.Empty;
    private DateTime _lastManifestWriteTime = DateTime.MinValue;
    private string _manifestPath = string.Empty;
    private string _indexTemplatePath = string.Empty;
    private string _frontendAssetVersion = "missing-manifest";
    private SpaAssetManifestReadiness _readiness = SpaAssetManifestReadiness.Failed("spa_manifest_not_loaded");
    private SpaAssetSet _publicAssetSet = new(
        StableSpaEntry,
        [],
        [],
        "missing-manifest",
        UsesSourceAssets: false);

    public SpaAssetManifestService(
        IWebHostEnvironment env,
        IConfiguration configuration,
        IReleaseIdentityProvider releaseIdentity,
        ILogger<SpaAssetManifestService> logger)
    {
        _env = env;
        _configuration = configuration;
        _releaseIdentity = releaseIdentity;
        _logger = logger;
        LoadManifest();
    }

    public SpaAssetManifestReadiness GetReadiness() => _readiness;

    public string GetIndexTemplatePath()
    {
        LoadManifest();
        return _indexTemplatePath;
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

    public SpaAssetSet GetPublicAssetSet(HttpContext? context = null, PublicPageId? pageId = null)
    {
        if (ShouldUseSourceAssets(context))
        {
            string[] sourceStylesheets = ShouldIncludeMarkdownCss(pageId)
                ? [
                    "/src/assets/public-shell-critical.css?direct",
                    "/src/assets/tailwind.css?direct",
                    "/src/assets/public-page.css?direct",
                    "/src/assets/markdown.css?direct"
                ]
                : [
                    "/src/assets/public-shell-critical.css?direct",
                    "/src/assets/tailwind.css?direct",
                    "/src/assets/public-page.css?direct"
                ];

            return new SpaAssetSet(
                "/src/bootstrap/entry.ts",
                sourceStylesheets,
                [],
                GetFrontendAssetVersion(context),
                UsesSourceAssets: true);
        }

        LoadManifest();
        return pageId is null
            ? _publicAssetSet
            : CreatePublicAssetSet(_manifestByKey, _frontendAssetVersion, pageId);
    }

    public string GetFrontendAssetVersion(HttpContext? context = null)
    {
        if (ShouldUseSourceAssets(context))
        {
            return DevSourceAssetVersion;
        }

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

        return string.Equals(host, "localhost:3000", StringComparison.OrdinalIgnoreCase)
            || string.Equals(host, "127.0.0.1:3000", StringComparison.OrdinalIgnoreCase);
    }

    private void LoadManifest()
    {
        bool isDevelopment = _env.IsDevelopment();
        if (!isDevelopment && Volatile.Read(ref _manifestLoaded))
        {
            return;
        }

        lock (_loadLock)
        {
            if (!isDevelopment && _manifestLoaded)
            {
                return;
            }

            string manifestPath;
            SpaManifestDescriptor? descriptor = null;
            try
            {
                descriptor = ResolveDescriptor();
                manifestPath = descriptor.ManifestPath;
            }
            catch (Exception exception) when (exception is IOException
                or UnauthorizedAccessException
                or JsonException
                or InvalidOperationException
                or ArgumentException
                or NotSupportedException
                or PathTooLongException)
            {
                SetManifestFailure(ToStableFailureCode(exception));
                return;
            }
            if (string.IsNullOrWhiteSpace(manifestPath) || !File.Exists(manifestPath))
            {
                SetManifestFailure("spa_manifest_missing");
                return;
            }

            DateTime lastWrite = isDevelopment
                ? File.GetLastWriteTimeUtc(manifestPath)
                : DateTime.MaxValue;
            if (isDevelopment
                && lastWrite <= _lastManifestWriteTime
                && string.Equals(manifestPath, _manifestPath, StringComparison.Ordinal))
            {
                return;
            }

            try
            {
                using JsonDocument manifestDocument = JsonDocument.Parse(
                    File.ReadAllBytes(manifestPath),
                    new JsonDocumentOptions { AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow });
                var newRouteMap = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
                var newManifest = new Dictionary<string, ManifestAsset>(StringComparer.OrdinalIgnoreCase);

                if (manifestDocument.RootElement.ValueKind != JsonValueKind.Object)
                {
                    throw new SpaManifestValidationException("spa_manifest_schema_invalid");
                }
                foreach (JsonProperty entry in manifestDocument.RootElement.EnumerateObject())
                {
                    string key = RequireManifestString(entry.Name, "key");
                    ManifestAsset asset = ParseManifestAsset(key, entry.Value);

                    if (!newManifest.TryAdd(key, asset))
                    {
                        throw new SpaManifestValidationException("spa_manifest_schema_invalid");
                    }
                    if (!string.IsNullOrWhiteSpace(asset.Name))
                    {
                        if (!newRouteMap.TryGetValue(asset.Name, out List<string>? routeAssets))
                        {
                            routeAssets = [];
                            newRouteMap[asset.Name] = routeAssets;
                        }

                        if (!string.IsNullOrWhiteSpace(asset.File))
                        {
                            routeAssets.Add(asset.File);
                        }

                        routeAssets.AddRange(asset.Css);
                    }
                }

                FrozenDictionary<string, ManifestAsset> manifestSnapshot = newManifest.ToFrozenDictionary(StringComparer.OrdinalIgnoreCase);
                ValidateRequiredEntryCatalog(manifestSnapshot);
                ValidateImportGraph(manifestSnapshot);
                ValidateManifestAssetBindings(manifestSnapshot, descriptor);
                _manifestByKey = manifestSnapshot;
                _routeAssetMap = newRouteMap.ToFrozenDictionary(StringComparer.OrdinalIgnoreCase);
                _manifestPath = manifestPath;
                _indexTemplatePath = descriptor.IndexPath;
                _lastManifestWriteTime = lastWrite;
                _frontendAssetVersion = ComputeSemanticAssetVersion(manifestSnapshot, descriptor.IndexPath);
                _publicAssetSet = CreatePublicAssetSet(manifestSnapshot, _frontendAssetVersion, pageId: null);
                _manifestLoaded = !isDevelopment;
                _readiness = SpaAssetManifestReadiness.Ready(descriptor);
                _logger.LogInformation("SPA manifest loaded from {ManifestPath}. chunks={ChunkCount}", manifestPath, _manifestByKey.Count);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to load SPA asset manifest from {ManifestPath}", manifestPath);
                SetManifestFailure(ex is SpaManifestValidationException validation
                    ? validation.Code
                    : "spa_manifest_parse_failed");
            }
        }
    }

    private SpaAssetSet CreatePublicAssetSet(
        IReadOnlyDictionary<string, ManifestAsset> manifest,
        string frontendAssetVersion,
        PublicPageId? pageId)
    {
        IReadOnlyList<string> publicStylesheets = PickPublicStylesheets(manifest, pageId);
        return new SpaAssetSet(
            StableSpaEntry,
            publicStylesheets,
            [],
            frontendAssetVersion,
            UsesSourceAssets: false)
        {
            FullAppTakeover = new FullAppTakeoverAssetSet(
                PickFullAppTakeoverModulePreloads(manifest),
                PickFullAppTakeoverStylesheets(manifest, publicStylesheets))
        };
    }

    private SpaManifestDescriptor ResolveDescriptor()
    {
        if (_env.IsDevelopment())
        {
            string webRoot = string.IsNullOrWhiteSpace(_env.WebRootPath)
                ? Path.Combine(_env.ContentRootPath, "wwwroot")
                : _env.WebRootPath;
            string manifestPath = ResolveDevelopmentManifestPath();
            return new SpaManifestDescriptor(
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                webRoot,
                Path.Combine(webRoot, "index.html"),
                manifestPath,
                null,
                null,
                null);
        }

        string descriptorPath = _configuration["FSUSBLOG_SPA_MANIFEST_DESCRIPTOR"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_SPA_MANIFEST_DESCRIPTOR")
            ?? string.Empty;
        if (string.IsNullOrWhiteSpace(descriptorPath))
        {
            throw new SpaManifestValidationException("spa_manifest_descriptor_missing");
        }

        string buildReceiptPath = _configuration["FSUSBLOG_PRODUCTION_BUILD_RECEIPT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_PRODUCTION_BUILD_RECEIPT")
            ?? string.Empty;
        string releaseAssetBase = _configuration["FSUSBLOG_RELEASE_ASSET_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_ASSET_ROOT")
            ?? string.Empty;
        return SpaManifestDescriptor.ReadAndValidate(
            descriptorPath,
            buildReceiptPath,
            releaseAssetBase,
            _releaseIdentity.Current);
    }

    private string ResolveDevelopmentManifestPath()
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

    private void SetManifestFailure(string error)
    {
        _manifestByKey = FrozenDictionary<string, ManifestAsset>.Empty;
        _routeAssetMap = FrozenDictionary<string, List<string>>.Empty;
        _manifestPath = string.Empty;
        _indexTemplatePath = string.Empty;
        _frontendAssetVersion = _env.IsDevelopment()
            ? ComputeFallbackAssetVersion()
            : "missing-manifest";
        _publicAssetSet = CreatePublicAssetSet(_manifestByKey, _frontendAssetVersion, pageId: null);
        _manifestLoaded = !_env.IsDevelopment();
        _readiness = SpaAssetManifestReadiness.Failed(error);
    }

    private static string ToStableFailureCode(Exception exception)
        => exception switch
        {
            SpaManifestValidationException validation => validation.Code,
            JsonException => "spa_manifest_descriptor_invalid_json",
            IOException => "spa_manifest_descriptor_io_failed",
            UnauthorizedAccessException => "spa_manifest_descriptor_access_denied",
            _ => "spa_manifest_validation_failed"
        };

    private IReadOnlyList<string> PickPublicStylesheets(IReadOnlyDictionary<string, ManifestAsset> manifest, PublicPageId? pageId)
    {
        var styles = new List<string>();
        IEnumerable<string> allowedNames = ShouldIncludeMarkdownCss(pageId)
            ? s_publicBaseCssNames.Concat(s_publicMarkdownCssNames)
            : s_publicBaseCssNames;
        IReadOnlyList<string> cssHrefs = EnumerateCssHrefs(manifest).ToArray();

        foreach (string name in allowedNames)
        {
            string? css = cssHrefs.FirstOrDefault(href => AssetFileNameMatches(href, name));
            if (!string.IsNullOrWhiteSpace(css) && !styles.Contains(css, StringComparer.Ordinal))
            {
                styles.Add(css);
            }
        }

        if (styles.Count == 0 && _env.IsDevelopment())
        {
            styles.AddRange(PickCssFromAssetsDirectory(pageId));
        }

        return styles.ToArray();
    }

    private static IReadOnlyList<string> PickFullAppTakeoverModulePreloads(IReadOnlyDictionary<string, ManifestAsset> manifest)
        => manifest.Values
            .Where(static asset => !string.IsNullOrWhiteSpace(asset.File) &&
                asset.File.EndsWith(".js", StringComparison.OrdinalIgnoreCase) &&
                s_fullAppTakeoverModuleNames.Any(name => AssetNameMatches(asset, name)))
            .Select(static asset => asset.File)
            .Distinct(StringComparer.Ordinal)
            .ToArray();

    private static IReadOnlyList<string> PickFullAppTakeoverStylesheets(
        IReadOnlyDictionary<string, ManifestAsset> manifest,
        IReadOnlyList<string> publicStylesheets)
    {
        var publicSet = publicStylesheets.ToHashSet(StringComparer.Ordinal);
        return EnumerateCssHrefs(manifest)
            .Where(href => !publicSet.Contains(href) &&
                s_fullAppTakeoverCssNames.Any(name => AssetFileNameMatches(href, name)))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
    }

    private IEnumerable<string> PickCssFromAssetsDirectory(PublicPageId? pageId)
    {
        string assetsRoot = Path.Combine(string.IsNullOrWhiteSpace(_env.WebRootPath)
            ? Path.Combine(_env.ContentRootPath, "wwwroot")
            : _env.WebRootPath, "assets");
        if (!Directory.Exists(assetsRoot))
        {
            yield break;
        }

        IEnumerable<string> allowedNames = ShouldIncludeMarkdownCss(pageId)
            ? s_publicBaseCssNames.Concat(s_publicMarkdownCssNames)
            : s_publicBaseCssNames;
        foreach (string prefix in allowedNames)
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

    private static IEnumerable<string> EnumerateCssHrefs(IReadOnlyDictionary<string, ManifestAsset> manifest)
    {
        foreach (ManifestAsset asset in manifest.Values)
        {
            if (asset.File.EndsWith(".css", StringComparison.OrdinalIgnoreCase))
            {
                yield return asset.File;
            }

            foreach (string css in asset.Css)
            {
                yield return css;
            }
        }
    }

    private static bool ShouldIncludeMarkdownCss(PublicPageId? pageId)
        => pageId is null
            or PublicPageId.ArticleDetail
            or PublicPageId.About
            or PublicPageId.Privacy
            or PublicPageId.Guidelines
            or PublicPageId.Copyright;

    private static bool AssetNameMatches(ManifestAsset asset, string expectedName)
        => string.Equals(asset.Name, expectedName, StringComparison.OrdinalIgnoreCase)
            || AssetFileNameMatches(asset.File, expectedName)
            || AssetFileNameMatches(asset.Key, expectedName)
            || AssetFileNameMatches(asset.Src, expectedName);

    private static bool AssetFileNameMatches(string href, string expectedName)
    {
        if (string.IsNullOrWhiteSpace(href))
        {
            return false;
        }

        string fileName = Path.GetFileNameWithoutExtension(href.Replace('\\', '/'));
        return string.Equals(fileName, expectedName, StringComparison.OrdinalIgnoreCase)
            || fileName.StartsWith(expectedName + "-", StringComparison.OrdinalIgnoreCase);
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

    private static string ComputeSemanticAssetVersion(
        IReadOnlyDictionary<string, ManifestAsset> manifest,
        string indexPath)
    {
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        if (File.Exists(indexPath))
        {
            sha.AppendData(File.ReadAllBytes(indexPath));
        }
        foreach (ManifestAsset asset in manifest.Values.OrderBy(static asset => asset.Key, StringComparer.Ordinal))
        {
            sha.AppendData(System.Text.Encoding.UTF8.GetBytes(string.Join('\n', new[]
            {
                asset.Key, asset.Name, asset.Src, asset.File,
                string.Join(',', asset.Css),
                string.Join(',', asset.Imports),
                string.Join(',', asset.DynamicImports),
                string.Join(',', asset.Assets)
            })));
        }
        return Convert.ToHexStringLower(sha.GetHashAndReset());
    }

    private static string ComputeSha256(byte[] bytes)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        return Convert.ToHexStringLower(hash);
    }

    private static ManifestAsset ParseManifestAsset(string key, JsonElement entry)
    {
        if (entry.ValueKind != JsonValueKind.Object || HasDuplicateProperties(entry))
        {
            throw new SpaManifestValidationException("spa_manifest_schema_invalid");
        }
        string file = RequireManifestProperty(entry, "file");
        string name = OptionalManifestProperty(entry, "name");
        string src = OptionalManifestProperty(entry, "src");
        string[] css = ReadManifestStringArray(entry, "css");
        string[] imports = ReadManifestStringArray(entry, "imports");
        string[] dynamicImports = ReadManifestStringArray(entry, "dynamicImports");
        string[] assets = ReadManifestStringArray(entry, "assets");
        ValidateManifestProperties(entry);
        return new ManifestAsset(
            key,
            name,
            src,
            ToAssetHref(file),
            [.. css.Select(ToAssetHref)],
            imports,
            dynamicImports,
            [.. assets.Select(ToAssetHref)]);
    }

    private static bool HasDuplicateProperties(JsonElement entry)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        return entry.EnumerateObject().Any(property => !names.Add(property.Name));
    }

    private static void ValidateManifestProperties(JsonElement entry)
    {
        foreach (JsonProperty property in entry.EnumerateObject())
        {
            if (!s_supportedManifestProperties.Contains(property.Name))
            {
                throw new SpaManifestValidationException("spa_manifest_schema_invalid");
            }

            if (property.Name is "isEntry" or "isDynamicEntry"
                && property.Value.ValueKind != JsonValueKind.True
                && property.Value.ValueKind != JsonValueKind.False)
            {
                throw new SpaManifestValidationException("spa_manifest_schema_invalid");
            }
        }
    }

    private static string RequireManifestProperty(JsonElement entry, string propertyName)
    {
        if (!entry.TryGetProperty(propertyName, out JsonElement value))
            throw new SpaManifestValidationException("spa_manifest_schema_invalid");
        return RequireManifestString(
            value.ValueKind == JsonValueKind.String ? value.GetString() : null,
            propertyName,
            value.ValueKind);
    }

    private static string OptionalManifestProperty(JsonElement entry, string propertyName)
    {
        return entry.TryGetProperty(propertyName, out JsonElement value)
            ? RequireManifestString(
                value.ValueKind == JsonValueKind.String ? value.GetString() : null,
                propertyName,
                value.ValueKind)
            : string.Empty;
    }

    private static string[] ReadManifestStringArray(JsonElement entry, string propertyName)
    {
        if (!entry.TryGetProperty(propertyName, out JsonElement value))
        {
            return [];
        }
        if (value.ValueKind != JsonValueKind.Array)
        {
            throw new SpaManifestValidationException("spa_manifest_schema_invalid");
        }
        return value.EnumerateArray().Select(item => RequireManifestString(
            item.ValueKind == JsonValueKind.String ? item.GetString() : null,
            propertyName,
            item.ValueKind)).ToArray();
    }

    private static string RequireManifestString(string? value, string propertyName, JsonValueKind? kind = null)
    {
        if (kind is not null && kind != JsonValueKind.String || string.IsNullOrWhiteSpace(value))
        {
            throw new SpaManifestValidationException("spa_manifest_schema_invalid");
        }
        return value.Trim();
    }

    private static void ValidateRequiredEntryCatalog(IReadOnlyDictionary<string, ManifestAsset> manifest)
    {
        using JsonDocument catalog = JsonDocument.Parse(RequiredEntryCatalogJson);
        JsonElement owners = catalog.RootElement.GetProperty("owners");
        if (owners.ValueKind != JsonValueKind.Array)
            throw new SpaManifestValidationException("spa_manifest_required_catalog_invalid");
        foreach (JsonElement ownerElement in owners.EnumerateArray())
        {
            string owner = RequireManifestString(ownerElement.GetString(), "owner", ownerElement.ValueKind);
            int matches = manifest.Values.Count(asset => string.Equals(asset.Name, owner, StringComparison.Ordinal));
            if (matches != 1)
                throw new SpaManifestValidationException("spa_manifest_required_entry_invalid");
        }
    }

    private static void ValidateImportGraph(IReadOnlyDictionary<string, ManifestAsset> manifest)
    {
        var visiting = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string key in manifest.Keys)
        {
            Visit(key);
        }
        return;

        void Visit(string key)
        {
            if (visited.Contains(key))
            {
                return;
            }
            if (!manifest.ContainsKey(key))
            {
                throw new SpaManifestValidationException("spa_manifest_import_missing");
            }
            if (!visiting.Add(key))
            {
                throw new SpaManifestValidationException("spa_manifest_import_cycle");
            }
            foreach (string import in manifest[key].Imports)
            {
                Visit(import);
            }
            visiting.Remove(key);
            visited.Add(key);
        }
    }

    private static void ValidateManifestAssetBindings(
        IReadOnlyDictionary<string, ManifestAsset> manifest,
        SpaManifestDescriptor descriptor)
    {
        // Development manifests have no immutable release inventory. Production
        // reaches this point only after the descriptor has authenticated it.
        if (string.IsNullOrWhiteSpace(descriptor.AssetInventoryPath))
        {
            return;
        }

        var inventory = new Dictionary<string, string>(StringComparer.Ordinal);
        using JsonDocument document = JsonDocument.Parse(File.ReadAllBytes(descriptor.AssetInventoryPath));
        if (document.RootElement.ValueKind != JsonValueKind.Object
            || !document.RootElement.TryGetProperty("files", out JsonElement files)
            || files.ValueKind != JsonValueKind.Array)
        {
            throw new SpaManifestValidationException("spa_asset_inventory_invalid");
        }

        foreach (JsonElement entry in files.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Object
                || !entry.TryGetProperty("path", out JsonElement path)
                || !entry.TryGetProperty("sha256", out JsonElement digest)
                || path.ValueKind != JsonValueKind.String
                || digest.ValueKind != JsonValueKind.String)
            {
                throw new SpaManifestValidationException("spa_asset_inventory_invalid");
            }

            string relativePath = NormalizeInventoryPath(path.GetString());
            string expectedDigest = digest.GetString() ?? string.Empty;
            if (!expectedDigest.StartsWith("sha256:", StringComparison.Ordinal)
                || !inventory.TryAdd(relativePath, expectedDigest))
            {
                throw new SpaManifestValidationException("spa_asset_inventory_invalid");
            }
        }

        foreach (ManifestAsset asset in manifest.Values)
        {
            ValidateReference(asset.File);
            foreach (string css in asset.Css)
            {
                ValidateReference(css);
            }
            foreach (string referencedAsset in asset.Assets)
            {
                ValidateReference(referencedAsset);
            }
        }

        return;

        void ValidateReference(string href)
        {
            string relativePath = NormalizeManifestAssetPath(href.TrimStart('/'));
            if (!inventory.TryGetValue(relativePath, out string? expectedDigest))
            {
                throw new SpaManifestValidationException("spa_manifest_asset_missing_from_inventory");
            }

            string physicalPath = Path.GetFullPath(Path.Combine(
                descriptor.AssetRoot,
                relativePath.Replace('/', Path.DirectorySeparatorChar)));
            if (!physicalPath.StartsWith(
                    Path.TrimEndingDirectorySeparator(descriptor.AssetRoot) + Path.DirectorySeparatorChar,
                    OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal)
                || !File.Exists(physicalPath)
                || !string.Equals("sha256:" + ComputeSha256(File.ReadAllBytes(physicalPath)), expectedDigest, StringComparison.Ordinal))
            {
                throw new SpaManifestValidationException("spa_manifest_asset_digest_mismatch");
            }
        }
    }

    private static string ToAssetHref(string path)
    {
        return "/" + NormalizeManifestAssetPath(path);
    }

    private static string NormalizeManifestAssetPath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)
            || Path.IsPathRooted(path)
            || path.Contains('\\')
            || path.Split('/').Any(static segment => string.IsNullOrEmpty(segment) || segment is "." or "..")
            || !path.StartsWith("assets/", StringComparison.Ordinal))
        {
            throw new SpaManifestValidationException("spa_manifest_asset_path_invalid");
        }

        return path;
    }

    private static string NormalizeInventoryPath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)
            || Path.IsPathRooted(path)
            || path.Contains('\\')
            || path.Split('/').Any(static segment => string.IsNullOrEmpty(segment) || segment is "." or ".."))
        {
            throw new SpaManifestValidationException("spa_asset_inventory_invalid");
        }

        return path;
    }

    private sealed record ManifestAsset(
        string Key,
        string Name,
        string Src,
        string File,
        IReadOnlyList<string> Css,
        IReadOnlyList<string> Imports,
        IReadOnlyList<string> DynamicImports,
        IReadOnlyList<string> Assets);
}
