using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Analytics;
using FsusBlog.V2.Server.Authoring;
using FsusBlog.V2.Server.Comments;
using FsusBlog.V2.Server.Communication;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Passkeys;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Operations;

/// <summary>
/// Single-source-of-truth capability resolver: every mature capability activates by default
/// whenever its security/runtime prerequisites are satisfied, while retaining strict fail-closed
/// overrides via explicit FSUSBLOG_* settings.
/// </summary>
internal sealed class SiteCapabilities
{
    internal const string DataDirSetting = "FSUSBLOG_DATA_DIR";
    internal const string PublicCommentsSetting = "FSUSBLOG_PUBLIC_COMMENT_SUBMISSIONS";
    internal const string ReaderRegistrationSetting = "FSUSBLOG_READER_REGISTRATION";
    internal const string PublicSearchModeSetting = "FSUSBLOG_PUBLIC_SEARCH_MODE";

    private static readonly string[] BaselineSitePageFiles = ["about.md", "privacy.md", "guidelines.md", "copyright.md"];

    internal bool TrustLoopbackProxy { get; }
    internal PublicSiteConfiguration PublicSite { get; }
    internal PasskeyConfiguration? SitePasskey { get; }
    internal PasskeyConfiguration? AdminIdentity { get; }
    internal RecoveryKeySecret? RecoveryKey { get; }
    internal SubscriptionIdentity? Subscription { get; }
    internal PdfDocumentExport? PdfExport { get; }
    internal PluginPreviewEndpoints? PluginPreview { get; }

    internal string? PrivateMediaRoot { get; }
    internal string? PublicMediaRoot { get; }
    internal string? SitePagesRoot { get; }
    internal string? AppearanceRoot { get; }
    internal string? TrafficRegionsPath { get; }

    internal bool PublicCommentSubmissions { get; }
    internal bool SignedInCommentReplies { get; }
    internal bool PrivateInboxWrites { get; }
    internal bool DocumentExportTasks { get; }
    internal bool PublicHotArticles { get; }
    internal bool WideSearchCorpus { get; }
    internal string PublicSearchMode { get; }
    internal bool PrivateMediaResumable { get; }
    internal bool ArticleReadProof { get; }
    internal bool SiteTraffic { get; }
    internal Uri? TrafficOrigin { get; }
    internal bool ReaderRegistration { get; }
    internal bool SitePersistentRefresh { get; }

    internal bool AdminInboxReplies { get; }
    internal bool AdminInboxStatus { get; }
    internal bool AdminInboxNotice { get; }
    internal bool AdminInboxSharedRead { get; }
    internal bool AdminInboxLive { get; }
    internal bool AdminInboxActivityOrder { get; }
    internal bool AdminCommentBatch { get; }
    internal bool AdminArticleRollback { get; }
    internal bool AdminTagMetadata { get; }
    internal bool AdminCategoryMetadata { get; }
    internal bool SitePageEditor { get; }
    internal bool OnlineAppearance { get; }

    private SiteCapabilities(
        IConfiguration configuration,
        string webDist,
        bool trustLoopbackProxy,
        PublicSiteConfiguration publicSite,
        PasskeyConfiguration? sitePasskey,
        PasskeyConfiguration? adminIdentity,
        RecoveryKeySecret? recoveryKey,
        SubscriptionIdentity? subscription)
    {
        TrustLoopbackProxy = trustLoopbackProxy;
        PublicSite = publicSite;
        SitePasskey = sitePasskey;
        AdminIdentity = adminIdentity;
        RecoveryKey = recoveryKey;
        Subscription = subscription;

        var dataDir = ResolveDataDir(configuration, webDist);
        PrivateMediaRoot = ResolveOptionalPath(configuration, MediaEndpoints.StorageSetting,
            () => dataDir is null ? null : EnsurePrivateSubdirectory(dataDir, "private-media"));
        PublicMediaRoot = ResolveOptionalPath(configuration, PublishedMediaEndpoints.StorageSetting,
            () => dataDir is not null && PrivateMediaRoot is not null ? EnsurePrivateSubdirectory(dataDir, "public-media") : null);
        SitePagesRoot = ResolveOptionalPath(configuration, "FSUSBLOG_SITE_PAGES",
            () => dataDir is null ? null : DiscoverSitePages(dataDir));
        AppearanceRoot = ResolveOptionalPath(configuration, AppearanceAssets.RootSetting,
            () => dataDir is null ? null : DiscoverAppearance(dataDir));
        TrafficRegionsPath = ResolveOptionalPath(configuration, Analytics.SiteTraffic.RegionsSetting,
            () => dataDir is null ? null : DiscoverExistingFile(dataDir, "traffic-regions.json"));

        PublicSearchMode = (configuration[PublicSearchModeSetting] ?? "auto").Trim().ToLowerInvariant();
        if (PublicSearchMode is not ("auto" or "local" or "server"))
            throw new InvalidOperationException($"{PublicSearchModeSetting} must be auto, local, or server.");

        PublicCommentSubmissions = ReadOptionalBool(configuration, PublicCommentsSetting) ?? true;
        SignedInCommentReplies = PublicCommentSubmissions && (ReadOptionalBool(configuration, CommentReplies.Setting) ?? true);
        PrivateInboxWrites = ReadOptionalBool(configuration, InboxWriteEndpoints.Setting) ?? true;
        DocumentExportTasks = ReadOptionalBool(configuration, DocumentExportEndpoints.Setting) ?? true;
        PublicHotArticles = ReadOptionalBool(configuration, Analytics.PublicHotArticles.Setting) ?? true;
        WideSearchCorpus = ReadOptionalBool(configuration, WideSearchCorpusEndpoints.Setting) ?? true;
        PrivateMediaResumable = PrivateMediaRoot is not null && (ReadOptionalBool(configuration, MediaUploadEndpoints.Setting) ?? true);

        var hasHttpsPublic = publicSite.Origin is not null &&
            Uri.TryCreate(publicSite.Origin, UriKind.Absolute, out var publicUri) &&
            publicUri.Scheme == Uri.UriSchemeHttps;

        var requestedReadProof = ReadOptionalBool(configuration, ArticleReadEndpoints.Setting);
        ArticleReadProof = requestedReadProof ?? (publicSite.Origin is not null);
        if (ArticleReadProof && publicSite.Origin is null)
            throw new InvalidOperationException("Article read proof requires an explicit public HTTPS origin.");

        var requestedTraffic = ReadOptionalBool(configuration, Analytics.SiteTraffic.EnabledSetting);
        SiteTraffic = requestedTraffic ?? hasHttpsPublic;
        TrafficOrigin = SiteTraffic
            ? new Uri(publicSite.Origin ?? throw new InvalidOperationException("Traffic statistics require an explicit public HTTPS origin."))
            : null;
        if (SiteTraffic && TrafficOrigin?.Scheme != Uri.UriSchemeHttps)
            throw new InvalidOperationException("Traffic statistics require an explicit public HTTPS origin.");

        var requestedRegistration = ReadOptionalBool(configuration, ReaderRegistrationSetting);
        ReaderRegistration = requestedRegistration ?? (sitePasskey is not null);
        if (ReaderRegistration && sitePasskey is null)
            throw new InvalidOperationException("A Passkey relying party is required to enable reader registration.");

        var requestedPersistentRefresh = ReadOptionalBool(configuration, SiteRefreshStore.Setting);
        SitePersistentRefresh = requestedPersistentRefresh ?? (sitePasskey is not null);
        if (SitePersistentRefresh && sitePasskey is null)
            throw new InvalidOperationException("A Passkey relying party is required to enable persistent site sessions.");

        if (subscription is not null && publicSite.Origin is null)
            throw new InvalidOperationException("Subscription preferences require an explicit public HTTPS origin.");

        var hasAdmin = adminIdentity is not null;
        var httpsAdmin = adminIdentity?.Origin.Scheme == Uri.UriSchemeHttps;

        AdminInboxReplies = hasAdmin && (ReadOptionalBool(configuration, AdminInboxEndpoints.ReplySetting) ?? true);
        AdminInboxStatus = hasAdmin && (ReadOptionalBool(configuration, AdminInboxEndpoints.StatusSetting) ?? true);
        AdminInboxNotice = hasAdmin && (ReadOptionalBool(configuration, AdminInboxEndpoints.NoticeSetting) ?? true);
        AdminInboxSharedRead = hasAdmin && (ReadOptionalBool(configuration, AdminInboxEndpoints.SharedReadSetting) ?? true);
        AdminInboxLive = hasAdmin && (ReadOptionalBool(configuration, AdminInboxEndpoints.LiveSetting) ?? true);
        AdminInboxActivityOrder = hasAdmin && (ReadOptionalBool(configuration, InboxActivityFence.Setting) ?? true);
        AdminCommentBatch = hasAdmin && (ReadOptionalBool(configuration, AdminModerationBatchEndpoints.Setting) ?? true);

        AdminArticleRollback = ReadOptionalBool(configuration, AdminArticleRollbackEndpoints.Setting) ?? httpsAdmin;
        if (AdminArticleRollback && !httpsAdmin)
            throw new InvalidOperationException("Published article rollback requires an HTTPS administrator origin.");

        AdminTagMetadata = ReadOptionalBool(configuration, AdminTagMetadataEndpoints.Setting) ?? httpsAdmin;
        if (AdminTagMetadata && !httpsAdmin)
            throw new InvalidOperationException("Tag metadata editing requires an HTTPS administrator origin.");

        AdminCategoryMetadata = ReadOptionalBool(configuration, AdminTagMetadataEndpoints.CategorySetting) ?? httpsAdmin;
        if (AdminCategoryMetadata && !httpsAdmin)
            throw new InvalidOperationException("Category metadata editing requires an HTTPS administrator origin.");

        var httpsSiteAndAdmin = httpsAdmin && publicSite.Origin is not null;
        SitePageEditor = ReadOptionalBool(configuration, SitePages.EditorSetting) ??
            (httpsSiteAndAdmin && SitePagesRoot is not null);
        if (SitePageEditor && !httpsSiteAndAdmin)
            throw new InvalidOperationException("The site page editor requires HTTPS administrator and public origins.");
        if (SitePageEditor && string.IsNullOrWhiteSpace(SitePagesRoot))
            throw new InvalidOperationException("The site page editor requires the four deployment baseline files.");

        OnlineAppearance = ReadOptionalBool(configuration, AppearanceAssets.OnlineSetting) ??
            (AppearanceRoot is not null && httpsSiteAndAdmin);
        if (OnlineAppearance && !httpsSiteAndAdmin)
            throw new InvalidOperationException("Online appearance requires HTTPS administrator and public origins.");
        if (OnlineAppearance && string.IsNullOrWhiteSpace(AppearanceRoot))
            throw new InvalidOperationException("Online appearance requires a signed deployment registry.");

        PdfExport = PdfDocumentExport.Read(configuration);
        PluginPreview = PluginPreviewEndpoints.Read(configuration, publicSite.Origin, webDist, PrivateMediaRoot);
    }

    internal static SiteCapabilities Resolve(IConfiguration configuration, string webDist)
    {
        var trustLoopbackProxy = LoopbackProxy.ReadConfiguration(configuration);
        var publicSite = PublicSiteConfiguration.Read(configuration);
        var sitePasskey = PasskeyConfiguration.Read(configuration, publicSite.Origin);
        var adminIdentity = AdminIdentityEndpoints.ReadConfiguration(configuration, publicSite.Origin);
        var recoveryKey = RecoveryKeySecret.Read(configuration);
        var subscription = SubscriptionIdentity.Read(configuration[SubscriptionIdentity.KeySetting]);
        return new(configuration, webDist, trustLoopbackProxy, publicSite, sitePasskey, adminIdentity, recoveryKey, subscription);
    }

    internal static bool? ReadOptionalBool(IConfiguration configuration, string key)
    {
        var raw = configuration[key];
        if (raw is null || raw.Trim().Length == 0) return null;
        return raw.Trim().ToLowerInvariant() switch
        {
            "true" => true,
            "false" => false,
            _ => throw new InvalidOperationException($"{key} must be true or false.")
        };
    }

    private static string? ResolveOptionalPath(IConfiguration configuration, string key, Func<string?> fallback)
    {
        var explicitValue = configuration[key];
        if (explicitValue is not null)
            return string.IsNullOrWhiteSpace(explicitValue) ? null : explicitValue.Trim();
        return fallback();
    }

    private static string? ResolveDataDir(IConfiguration configuration, string webDist)
    {
        var raw = configuration[DataDirSetting];
        if (string.IsNullOrWhiteSpace(raw)) return null;
        if (!Path.IsPathFullyQualified(raw))
            throw new InvalidOperationException($"{DataDirSetting} must be an absolute directory path.");
        var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(raw));
        if (full == "/")
            throw new InvalidOperationException($"{DataDirSetting} cannot be the filesystem root.");
        var resolvedDist = Path.TrimEndingDirectorySeparator(Path.GetFullPath(webDist));
        if (Contains(full, resolvedDist) || Contains(resolvedDist, full))
            throw new InvalidOperationException($"{DataDirSetting} must be separate from the web build directory.");
        if (!Directory.Exists(full))
        {
            if (OperatingSystem.IsWindows()) Directory.CreateDirectory(full);
            else Directory.CreateDirectory(full, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        return full;
    }

    private static string EnsurePrivateSubdirectory(string dataDir, string name)
    {
        var path = Path.Combine(dataDir, name);
        if (!Directory.Exists(path))
        {
            if (OperatingSystem.IsWindows()) Directory.CreateDirectory(path);
            else Directory.CreateDirectory(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        return path;
    }

    private static string? DiscoverSitePages(string dataDir)
    {
        var path = Path.Combine(dataDir, "site-pages");
        if (!Directory.Exists(path)) return null;
        return BaselineSitePageFiles.All(file => File.Exists(Path.Combine(path, file))) ? path : null;
    }

    private static string? DiscoverAppearance(string dataDir)
    {
        var path = Path.Combine(dataDir, "appearance");
        return Directory.Exists(path) && File.Exists(Path.Combine(path, "appearance.json")) ? path : null;
    }

    private static string? DiscoverExistingFile(string dataDir, string name)
    {
        var path = Path.Combine(dataDir, name);
        return File.Exists(path) ? path : null;
    }

    private static bool Contains(string parent, string child) =>
        string.Equals(parent, child, StringComparison.Ordinal) ||
        child.StartsWith(parent + Path.DirectorySeparatorChar, StringComparison.Ordinal);
}
