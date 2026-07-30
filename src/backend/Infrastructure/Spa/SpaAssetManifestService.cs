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
    string? Error,
    string State = "uninitialized",
    string? DescriptorGeneration = null,
    string? LastFailureKind = null,
    int Attempts = 0,
    string? LoadedDigest = null,
    string? AssetSetDigest = null) : IProductionHealthCheck
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
            error,
            "retryable-failed",
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
            null,
            "ready",
            descriptor.DescriptorContentDigest,
            null,
            0,
            descriptor.ManifestDigest);
}

public sealed class SpaAssetManifestService : ISpaAssetManifestService
{
    public const string DevSourceAssetVersion = "dev-source-assets";
    private const string StableSpaEntry = "/assets/fsus-spa-entry.js";
    private const int MaxFailureDiagnostics = 8;
    private static readonly string[] s_publicBaseCssOwners =
    [
        "public-shell-critical",
        "tailwind",
        "public-page"
    ];

    private static readonly string[] s_publicMarkdownCssOwners =
    [
        "markdown"
    ];

    private static readonly string[] s_fullAppTakeoverModuleOwners =
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

    private static readonly string[] s_fullAppTakeoverCssOwners =
    [
        "full-app-core",
        "vendor-element-plus",
        "vendor-progress",
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
    // The HTML owner "index" is additionally the manifest's only primary entry.
    private const string RequiredEntryCatalogJson = """
        {"owners":["index","entry-runtime","public-page-runtime","public-shell-critical","tailwind","markdown","public-page","full-app-core","route-user","route-admin","route-auth","route-error"]}
        """;

    private readonly IWebHostEnvironment _env;
    private readonly IConfiguration _configuration;
    private readonly IReleaseIdentityProvider _releaseIdentity;
    private readonly ILogger<SpaAssetManifestService> _logger;
    private readonly Action? _onLoadStartedForTests;
    private readonly Lock _loadLock = new();
    private ManifestRuntimeSnapshot _runtimeSnapshot = null!;
    private bool _loadInProgress;
    private bool _admissionInitialized;
    private string? _admissionGeneration;
    private DateTime _admissionDeadlineUtc;
    private int _loadAttempts;
    private DateTime _nextProductionProbeUtc;

    public SpaAssetManifestService(
        IWebHostEnvironment env,
        IConfiguration configuration,
        IReleaseIdentityProvider releaseIdentity,
        ILogger<SpaAssetManifestService> logger)
        : this(env, configuration, releaseIdentity, logger, onLoadStartedForTests: null)
    {
    }

    internal SpaAssetManifestService(
        IWebHostEnvironment env,
        IConfiguration configuration,
        IReleaseIdentityProvider releaseIdentity,
        ILogger<SpaAssetManifestService> logger,
        Action? onLoadStartedForTests)
    {
        _env = env;
        _configuration = configuration;
        _releaseIdentity = releaseIdentity;
        _logger = logger;
        _onLoadStartedForTests = onLoadStartedForTests;
        ManifestAssetSnapshot emptyAssets = CreateEmptyAssetSnapshot();
        _runtimeSnapshot = new ManifestRuntimeSnapshot(
            emptyAssets,
            SpaAssetManifestReadiness.Failed("spa_manifest_not_loaded") with
            {
                State = "uninitialized"
            });
        LoadManifest();
    }

    public SpaAssetManifestReadiness GetReadiness()
    {
        LoadManifest();
        return Volatile.Read(ref _runtimeSnapshot).Readiness;
    }

    public string GetIndexTemplatePath()
    {
        LoadManifest();
        return Volatile.Read(ref _runtimeSnapshot).Assets.IndexTemplatePath;
    }

    public IReadOnlyList<string> GetPreloadsForPath(string path, HttpContext? context = null)
    {
        if (ShouldUseSourceAssets(context))
        {
            return [];
        }

        LoadManifest();
        ManifestAssetSnapshot snapshot = Volatile.Read(ref _runtimeSnapshot).Assets;

        if (string.IsNullOrWhiteSpace(path))
        {
            return [];
        }

        if (path.StartsWith("/user/", StringComparison.OrdinalIgnoreCase))
        {
            return GetAssets(snapshot, "route-user");
        }

        if (path.StartsWith("/admin/", StringComparison.OrdinalIgnoreCase))
        {
            return GetAssets(snapshot, "route-admin");
        }

        if (path.StartsWith("/login", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/register", StringComparison.OrdinalIgnoreCase))
        {
            return GetAssets(snapshot, "route-auth");
        }

        if (path.StartsWith("/403", StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith("/404", StringComparison.OrdinalIgnoreCase))
        {
            return GetAssets(snapshot, "route-error");
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
                UsesSourceAssets: true)
            {
                FrontendBuildIdentity = ReleaseIdContract.LocalSentinel
            };
        }

        LoadManifest();
        ManifestAssetSnapshot snapshot = Volatile.Read(ref _runtimeSnapshot).Assets;
        return pageId is null || !snapshot.IsReady
            ? snapshot.PublicAssetSet
            : CreatePublicAssetSet(
                snapshot.ManifestByKey,
                snapshot.FrontendAssetVersion,
                snapshot.AssetSetDigest,
                pageId);
    }

    public string GetFrontendAssetVersion(HttpContext? context = null)
    {
        if (ShouldUseSourceAssets(context))
        {
            return DevSourceAssetVersion;
        }

        LoadManifest();
        return Volatile.Read(ref _runtimeSnapshot).Assets.FrontendAssetVersion;
    }

    private static IReadOnlyList<string> GetAssets(ManifestAssetSnapshot snapshot, string key)
        => snapshot.RouteAssetMap.TryGetValue(key, out var assets) ? assets : [];

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
        DateTime now = DateTime.UtcNow;
        ManifestRuntimeSnapshot beforeLoad;
        lock (_loadLock)
        {
            if (!isDevelopment && now < _nextProductionProbeUtc)
            {
                return;
            }
            if (_loadInProgress)
            {
                return;
            }

            _loadInProgress = true;
            beforeLoad = Volatile.Read(ref _runtimeSnapshot);
        }

        string? observedGeneration = isDevelopment ? null : TryReadDescriptorGeneration();
        string? effectiveGeneration = observedGeneration ?? beforeLoad.Assets.DescriptorGeneration;
        int attempts;
        lock (_loadLock)
        {
            if (!isDevelopment)
            {
                if (!_admissionInitialized
                    || !string.Equals(effectiveGeneration, _admissionGeneration, StringComparison.Ordinal))
                {
                    _admissionInitialized = true;
                    _admissionGeneration = effectiveGeneration;
                    _admissionDeadlineUtc = now.Add(GetAdmissionWindow());
                    _loadAttempts = 0;
                }
                else if (beforeLoad.Readiness.State == "ready")
                {
                    _admissionDeadlineUtc = now.Add(GetAdmissionWindow());
                    _loadAttempts = 0;
                }

                if (beforeLoad.Readiness.State == "terminal-failed"
                    && (observedGeneration is null
                        || string.Equals(observedGeneration, beforeLoad.Readiness.DescriptorGeneration, StringComparison.Ordinal)))
                {
                    ScheduleNextProductionProbe(now);
                    _loadInProgress = false;
                    return;
                }

                if (beforeLoad.Readiness.State == "retryable-failed"
                    && now > _admissionDeadlineUtc)
                {
                    _admissionDeadlineUtc = now.Add(GetAdmissionWindow());
                    ScheduleNextProductionProbe(now);
                    _loadInProgress = false;
                    return;
                }
            }

            attempts = ++_loadAttempts;
            bool generationChanged = beforeLoad.Assets.IsReady
                && observedGeneration is not null
                && !string.Equals(
                    observedGeneration,
                    beforeLoad.Assets.DescriptorGeneration,
                    StringComparison.Ordinal);
            ManifestAssetSnapshot servingAssets = generationChanged
                ? CreateEmptyAssetSnapshot()
                : beforeLoad.Assets;
            var loadingReadiness = SpaAssetManifestReadiness.Failed("spa_manifest_loading") with
            {
                State = "loading",
                DescriptorGeneration = effectiveGeneration,
                LastFailureKind = beforeLoad.Readiness.LastFailureKind,
                Attempts = attempts,
                LoadedDigest = servingAssets.LoadedDigest
            };
            Volatile.Write(
                ref _runtimeSnapshot,
                new ManifestRuntimeSnapshot(servingAssets, loadingReadiness));
        }

        try
        {
            _onLoadStartedForTests?.Invoke();
            ManifestAssetSnapshot? candidate = BuildManifestCandidate(
                isDevelopment,
                effectiveGeneration,
                beforeLoad.Assets);
            lock (_loadLock)
            {
                if (candidate is null)
                {
                    Volatile.Write(ref _runtimeSnapshot, beforeLoad);
                }
                else
                {
                    SpaManifestDescriptor descriptor = candidate.Descriptor;
                    var readiness = SpaAssetManifestReadiness.Ready(descriptor) with
                    {
                        DescriptorGeneration = candidate.DescriptorGeneration,
                        Attempts = attempts,
                        LoadedDigest = candidate.LoadedDigest,
                        AssetSetDigest = candidate.AssetSetDigest
                    };
                    Volatile.Write(
                        ref _runtimeSnapshot,
                        new ManifestRuntimeSnapshot(candidate, readiness));
                    _logger.LogInformation(
                        "SPA manifest loaded from {ManifestPath}. chunks={ChunkCount}",
                        candidate.ManifestPath,
                        candidate.ManifestByKey.Count);
                }
                ScheduleNextProductionProbe(DateTime.UtcNow);
            }
        }
        catch (Exception exception) when (exception is IOException
            or UnauthorizedAccessException
            or JsonException
            or InvalidOperationException
            or ArgumentException
            or NotSupportedException
            or PathTooLongException)
        {
            string failure = exception is SpaManifestValidationException validation
                ? validation.Code
                : exception is ManifestParseException
                    ? "spa_manifest_parse_failed"
                    : ToStableFailureCode(exception);
            if (attempts <= MaxFailureDiagnostics)
            {
                _logger.LogError(exception, "Failed to load SPA asset manifest. generation={DescriptorGeneration}", effectiveGeneration);
            }
            else
            {
                _logger.LogDebug(
                    "SPA manifest reload remains failed after bounded diagnostics. kind={FailureKind}",
                    exception.GetType().Name);
            }
            PublishManifestFailure(failure, effectiveGeneration, exception, attempts);
        }
        finally
        {
            lock (_loadLock)
            {
                _loadInProgress = false;
            }
        }
    }

    private ManifestAssetSnapshot? BuildManifestCandidate(
        bool isDevelopment,
        string? descriptorGeneration,
        ManifestAssetSnapshot previousAssets)
    {
        SpaManifestDescriptor descriptor = ResolveDescriptor();
        string manifestPath = descriptor.ManifestPath;
        if (string.IsNullOrWhiteSpace(manifestPath) || !File.Exists(manifestPath))
        {
            throw new SpaManifestValidationException("spa_manifest_missing");
        }

        DateTime lastWrite = isDevelopment
            ? File.GetLastWriteTimeUtc(manifestPath)
            : DateTime.MaxValue;
        if (isDevelopment
            && lastWrite <= previousAssets.LastManifestWriteTime
            && string.Equals(manifestPath, previousAssets.ManifestPath, StringComparison.Ordinal))
        {
            return null;
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
            ValidateImportReferences(manifestSnapshot);
            SpaAssetSetReceipt assetSetReceipt = CreateAssetSetReceipt(manifestSnapshot, descriptor);
            string frontendAssetVersion = isDevelopment
                ? ComputeDevelopmentAssetVersion(manifestSnapshot, descriptor.IndexPath)
                : assetSetReceipt.Digest;
            string assetSetDigest = isDevelopment ? string.Empty : assetSetReceipt.Digest;
            return new ManifestAssetSnapshot(
                newRouteMap.ToFrozenDictionary(
                    static pair => pair.Key,
                    static pair => (IReadOnlyList<string>)pair.Value.ToArray(),
                    StringComparer.OrdinalIgnoreCase),
                manifestSnapshot,
                lastWrite,
                manifestPath,
                descriptor.IndexPath,
                frontendAssetVersion,
                CreatePublicAssetSet(manifestSnapshot, frontendAssetVersion, assetSetDigest, pageId: null),
                descriptorGeneration ?? descriptor.DescriptorContentDigest,
                descriptor.ManifestDigest,
                descriptor,
                assetSetDigest,
                IsReady: true);
        }
        catch (JsonException exception)
        {
            throw new ManifestParseException(exception);
        }
    }

    private SpaAssetSet CreatePublicAssetSet(
        IReadOnlyDictionary<string, ManifestAsset> manifest,
        string frontendAssetVersion,
        string assetSetDigest,
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
            FrontendBuildIdentity = _releaseIdentity.Current.ReleaseId,
            FullAppTakeover = new FullAppTakeoverAssetSet(
                PickFullAppTakeoverModulePreloads(manifest),
                PickFullAppTakeoverStylesheets(manifest)),
            AssetSetDigest = assetSetDigest
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

    private void PublishManifestFailure(
        string error,
        string? descriptorGeneration,
        Exception exception,
        int attempts)
    {
        lock (_loadLock)
        {
            ManifestAssetSnapshot servingAssets = Volatile.Read(ref _runtimeSnapshot).Assets;
            string state = IsTerminalFailure(error, exception)
                ? "terminal-failed"
                : "retryable-failed";
            var readiness = SpaAssetManifestReadiness.Failed(error) with
            {
                State = state,
                DescriptorGeneration = descriptorGeneration,
                LastFailureKind = error,
                Attempts = attempts,
                LoadedDigest = servingAssets.LoadedDigest
            };
            Volatile.Write(
                ref _runtimeSnapshot,
                new ManifestRuntimeSnapshot(servingAssets, readiness));
            ScheduleNextProductionProbe(DateTime.UtcNow);
        }
    }

    private ManifestAssetSnapshot CreateEmptyAssetSnapshot()
    {
        FrozenDictionary<string, ManifestAsset> emptyManifest = FrozenDictionary<string, ManifestAsset>.Empty;
        string version = _env.IsDevelopment()
            ? ComputeFallbackAssetVersion()
            : "missing-manifest";
        SpaAssetSet emptyPublicAssets = _env.IsDevelopment()
            ? CreatePublicAssetSet(emptyManifest, version, string.Empty, pageId: null)
            : new SpaAssetSet(
                string.Empty,
                [],
                [],
                version,
                UsesSourceAssets: false);
        return new ManifestAssetSnapshot(
            FrozenDictionary<string, IReadOnlyList<string>>.Empty,
            emptyManifest,
            DateTime.MinValue,
            string.Empty,
            string.Empty,
            version,
            emptyPublicAssets,
            DescriptorGeneration: null,
            LoadedDigest: null,
            Descriptor: new SpaManifestDescriptor(
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                string.Empty,
                string.Empty,
                string.Empty,
                null,
                null,
                null),
            AssetSetDigest: string.Empty,
            IsReady: false);
    }

    private TimeSpan GetAdmissionWindow()
    {
        int configuredMilliseconds = _configuration.GetValue<int?>(
            "FSUSBLOG_SPA_MANIFEST_RETRY_ADMISSION_DEADLINE_MS") ?? 30_000;
        return TimeSpan.FromMilliseconds(Math.Clamp(configuredMilliseconds, 100, 600_000));
    }

    private void ScheduleNextProductionProbe(DateTime now)
    {
        if (_env.IsDevelopment())
        {
            return;
        }

        int configuredMilliseconds = _configuration.GetValue<int?>("FSUSBLOG_SPA_MANIFEST_RETRY_INTERVAL_MS") ?? 1_000;
        int boundedMilliseconds = Math.Clamp(configuredMilliseconds, 50, 30_000);
        _nextProductionProbeUtc = now.AddMilliseconds(boundedMilliseconds);
    }

    private string? TryReadDescriptorGeneration()
    {
        try
        {
            string descriptorPath = _configuration["FSUSBLOG_SPA_MANIFEST_DESCRIPTOR"]
                ?? Environment.GetEnvironmentVariable("FSUSBLOG_SPA_MANIFEST_DESCRIPTOR")
                ?? string.Empty;
            if (string.IsNullOrWhiteSpace(descriptorPath) || !File.Exists(descriptorPath))
            {
                return null;
            }

            byte[] descriptorBytes = File.ReadAllBytes(descriptorPath);
            try
            {
                using JsonDocument descriptor = JsonDocument.Parse(descriptorBytes);
                if (descriptor.RootElement.ValueKind == JsonValueKind.Object
                    && descriptor.RootElement.TryGetProperty("contentDigest", out JsonElement digest)
                    && digest.ValueKind == JsonValueKind.String
                    && !string.IsNullOrWhiteSpace(digest.GetString()))
                {
                    return digest.GetString();
                }
            }
            catch (JsonException)
            {
                // A malformed descriptor still needs a stable observation so an
                // atomically replaced descriptor can reopen admission.
            }

            return "sha256:" + Convert.ToHexStringLower(SHA256.HashData(descriptorBytes));
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static bool IsTerminalFailure(string error, Exception? exception)
        => error is not (
                "spa_manifest_missing"
                or "spa_manifest_descriptor_missing"
                or "spa_build_receipt_missing"
                or "spa_asset_inventory_file_missing")
            && exception is not (IOException or JsonException)
            && (error.Contains("schema", StringComparison.Ordinal)
            || error.Contains("identity", StringComparison.Ordinal)
            || error.Contains("digest", StringComparison.Ordinal)
            || error.Contains("authority", StringComparison.Ordinal)
            || exception is SpaManifestValidationException);

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
        IEnumerable<string> owners = ShouldIncludeMarkdownCss(pageId)
            ? s_publicBaseCssOwners.Concat(s_publicMarkdownCssOwners)
            : s_publicBaseCssOwners;

        foreach (string owner in owners)
        {
            foreach (string css in GetOwnedCss(manifest, owner))
            {
                if (!styles.Contains(css, StringComparer.Ordinal))
                {
                    styles.Add(css);
                }
            }
        }

        if (styles.Count == 0 && _env.IsDevelopment())
        {
            styles.AddRange(PickCssFromAssetsDirectory(pageId));
        }

        return styles.ToArray();
    }

    private static IReadOnlyList<string> PickFullAppTakeoverModulePreloads(IReadOnlyDictionary<string, ManifestAsset> manifest)
        => s_fullAppTakeoverModuleOwners
            .SelectMany(owner => GetOwnedAssets(manifest, owner))
            .Where(static asset => asset.File.EndsWith(".js", StringComparison.OrdinalIgnoreCase))
            .Select(static asset => asset.File)
            .Distinct(StringComparer.Ordinal)
            .ToArray();

    private static IReadOnlyList<string> PickFullAppTakeoverStylesheets(
        IReadOnlyDictionary<string, ManifestAsset> manifest)
    {
        HashSet<string> publicSet = s_publicBaseCssOwners
            .Concat(s_publicMarkdownCssOwners)
            .SelectMany(owner => GetOwnedCss(manifest, owner))
            .ToHashSet(StringComparer.Ordinal);
        return s_fullAppTakeoverCssOwners
            .SelectMany(owner => GetOwnedCss(manifest, owner))
            .Where(href => !publicSet.Contains(href))
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
            ? s_publicBaseCssOwners.Concat(s_publicMarkdownCssOwners)
            : s_publicBaseCssOwners;
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

    private static IEnumerable<string> GetOwnedCss(IReadOnlyDictionary<string, ManifestAsset> manifest, string owner)
        => GetOwnedAssets(manifest, owner)
            .SelectMany(static asset => asset.File.EndsWith(".css", StringComparison.OrdinalIgnoreCase)
                ? new[] { asset.File }.Concat(asset.Css)
                : asset.Css)
            .Distinct(StringComparer.Ordinal);

    private static IEnumerable<ManifestAsset> GetOwnedAssets(IReadOnlyDictionary<string, ManifestAsset> manifest, string owner)
    {
        ManifestAsset? root = manifest.Values.SingleOrDefault(asset => string.Equals(asset.Name, owner, StringComparison.Ordinal));
        if (root is null)
        {
            return [];
        }

        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        return Visit(root);

        IEnumerable<ManifestAsset> Visit(ManifestAsset asset)
        {
            if (!visited.Add(asset.Key))
            {
                yield break;
            }

            yield return asset;
            foreach (string import in asset.Imports)
            {
                foreach (ManifestAsset imported in Visit(manifest[import]))
                {
                    yield return imported;
                }
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

    private static string ComputeDevelopmentAssetVersion(
        IReadOnlyDictionary<string, ManifestAsset> manifest,
        string indexPath)
    {
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendLengthFramed(sha, "index", File.Exists(indexPath) ? ComputeSha256(File.ReadAllBytes(indexPath)) : "missing");
        foreach (ManifestAsset asset in manifest.Values.OrderBy(static asset => asset.Key, StringComparer.Ordinal))
        {
            AppendLengthFramed(sha, "key", asset.Key);
            AppendLengthFramed(sha, "file", asset.File);
            foreach (string css in asset.Css.OrderBy(static path => path, StringComparer.Ordinal))
            {
                AppendLengthFramed(sha, "css", css);
            }
        }

        return Convert.ToHexStringLower(sha.GetHashAndReset());
    }

    private static SpaAssetSetReceipt CreateAssetSetReceipt(
        IReadOnlyDictionary<string, ManifestAsset> manifest,
        SpaManifestDescriptor descriptor)
    {
        ValidateManifestAssetBindings(manifest, descriptor);
        if (string.IsNullOrWhiteSpace(descriptor.AssetInventoryPath)
            || string.IsNullOrWhiteSpace(descriptor.ManifestDigest)
            || string.IsNullOrWhiteSpace(descriptor.AssetInventoryDigest)
            || string.IsNullOrWhiteSpace(descriptor.DescriptorContentDigest))
        {
            // Development has no sealed receipt. It deliberately remains outside
            // the Production asset-generation contract.
            return SpaAssetSetReceipt.Development();
        }

        IReadOnlyDictionary<string, string> perFileDigests = ReadInventoryDigests(descriptor.AssetInventoryPath);
        string entryFile = StableSpaEntry.TrimStart('/');
        if (!perFileDigests.ContainsKey(entryFile)
            || !perFileDigests.TryGetValue("index.html", out string? indexDigest))
        {
            throw new SpaManifestValidationException("spa_asset_set_required_file_missing");
        }

        string[] cssFiles = EnumerateCssHrefs(manifest)
            .Select(static href => href.TrimStart('/'))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static href => href, StringComparer.Ordinal)
            .ToArray();
        string[] preloadFiles = manifest.Values
            .Where(static asset => asset.File.EndsWith(".js", StringComparison.OrdinalIgnoreCase))
            .Select(static asset => asset.File.TrimStart('/'))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static href => href, StringComparer.Ordinal)
            .ToArray();
        if (cssFiles.Concat(preloadFiles).Any(path => !perFileDigests.ContainsKey(path)))
        {
            throw new SpaManifestValidationException("spa_asset_set_required_file_missing");
        }

        return SpaAssetSetReceipt.Create(
            descriptor.DescriptorContentDigest,
            entryFile,
            cssFiles,
            preloadFiles,
            indexDigest,
            descriptor.ManifestDigest,
            descriptor.AssetInventoryDigest,
            perFileDigests);
    }

    private static IReadOnlyDictionary<string, string> ReadInventoryDigests(string inventoryPath)
    {
        var inventory = new Dictionary<string, string>(StringComparer.Ordinal);
        using JsonDocument document = JsonDocument.Parse(File.ReadAllBytes(inventoryPath));
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

        return inventory;
    }

    private sealed record SpaAssetSetReceipt(
        string Generation,
        string EntryFile,
        IReadOnlyList<string> CssFiles,
        IReadOnlyList<string> PreloadFiles,
        string IndexDigest,
        string ManifestDigest,
        string InventoryDigest,
        IReadOnlyDictionary<string, string> PerFileDigests,
        string Digest)
    {
        public static SpaAssetSetReceipt Development()
            => new(string.Empty, string.Empty, [], [], string.Empty, string.Empty, string.Empty,
                FrozenDictionary<string, string>.Empty, DevSourceAssetVersion);

        public static SpaAssetSetReceipt Create(
            string generation,
            string entryFile,
            IReadOnlyList<string> cssFiles,
            IReadOnlyList<string> preloadFiles,
            string indexDigest,
            string manifestDigest,
            string inventoryDigest,
            IReadOnlyDictionary<string, string> perFileDigests)
        {
            using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            // Generation and raw metadata digests remain receipt audit fields. The
            // runtime version intentionally binds only normalized served semantics.
            AppendLengthFramed(sha, "entryFile", entryFile);
            AppendLengthFramed(sha, "indexDigest", indexDigest);
            foreach (string css in cssFiles)
                AppendLengthFramed(sha, "css", css);
            foreach (string preload in preloadFiles)
                AppendLengthFramed(sha, "preload", preload);
            foreach ((string path, string digest) in perFileDigests
                .Where(static pair => IsRuntimeInventoryFile(pair.Key))
                .OrderBy(static pair => pair.Key, StringComparer.Ordinal))
            {
                AppendLengthFramed(sha, "path", path);
                AppendLengthFramed(sha, "digest", digest);
            }
            return new(
                generation,
                entryFile,
                cssFiles,
                preloadFiles,
                indexDigest,
                manifestDigest,
                inventoryDigest,
                perFileDigests,
                Convert.ToHexStringLower(sha.GetHashAndReset()));
        }
    }

    private static bool IsRuntimeInventoryFile(string path)
        => path is not ".vite/manifest.json" and not "asset-manifest.json";

    private static void AppendLengthFramed(IncrementalHash hash, string name, string value)
    {
        byte[] nameBytes = System.Text.Encoding.UTF8.GetBytes(name);
        byte[] valueBytes = System.Text.Encoding.UTF8.GetBytes(value);
        Span<byte> length = stackalloc byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(length, nameBytes.Length);
        hash.AppendData(length);
        hash.AppendData(nameBytes);
        System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(length, valueBytes.Length);
        hash.AppendData(length);
        hash.AppendData(valueBytes);
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
        bool isEntry = ReadManifestBoolean(entry, "isEntry");
        ValidateManifestProperties(entry);
        return new ManifestAsset(
            key,
            name,
            src,
            ToAssetHref(file),
            [.. css.Select(ToAssetHref)],
            imports,
            dynamicImports,
            [.. assets.Select(ToAssetHref)],
            isEntry);
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

    private static bool ReadManifestBoolean(JsonElement entry, string propertyName)
    {
        if (!entry.TryGetProperty(propertyName, out JsonElement value))
        {
            return false;
        }
        if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            throw new SpaManifestValidationException("spa_manifest_schema_invalid");
        }
        return value.GetBoolean();
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
        ManifestAsset? htmlEntry = null;
        foreach (JsonElement ownerElement in owners.EnumerateArray())
        {
            string owner = RequireManifestString(ownerElement.GetString(), "owner", ownerElement.ValueKind);
            ManifestAsset[] matches = manifest.Values
                .Where(asset => string.Equals(asset.Name, owner, StringComparison.Ordinal))
                .ToArray();
            if (matches.Length != 1)
                throw new SpaManifestValidationException("spa_manifest_required_entry_invalid");
            if (string.Equals(owner, "index", StringComparison.Ordinal))
            {
                htmlEntry = matches[0];
            }
        }
        if (htmlEntry is null
            || !htmlEntry.IsEntry
            || manifest.Values.Count(static asset => asset.IsEntry) != 1)
        {
            throw new SpaManifestValidationException("spa_manifest_required_entry_invalid");
        }
    }

    private static void ValidateImportReferences(IReadOnlyDictionary<string, ManifestAsset> manifest)
    {
        foreach (ManifestAsset asset in manifest.Values)
        {
            foreach (string import in asset.Imports.Concat(asset.DynamicImports))
            {
                if (!manifest.ContainsKey(import))
                {
                    throw new SpaManifestValidationException("spa_manifest_import_missing");
                }
            }
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
            || path.Any(char.IsControl)
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
            || path.Any(char.IsControl)
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
        IReadOnlyList<string> Assets,
        bool IsEntry);

    private sealed record ManifestAssetSnapshot(
        FrozenDictionary<string, IReadOnlyList<string>> RouteAssetMap,
        FrozenDictionary<string, ManifestAsset> ManifestByKey,
        DateTime LastManifestWriteTime,
        string ManifestPath,
        string IndexTemplatePath,
        string FrontendAssetVersion,
        SpaAssetSet PublicAssetSet,
        string? DescriptorGeneration,
        string? LoadedDigest,
        SpaManifestDescriptor Descriptor,
        string AssetSetDigest,
        bool IsReady);

    private sealed record ManifestRuntimeSnapshot(
        ManifestAssetSnapshot Assets,
        SpaAssetManifestReadiness Readiness);

    private sealed class ManifestParseException(JsonException innerException)
        : IOException("SPA manifest parse failed.", innerException);
}
