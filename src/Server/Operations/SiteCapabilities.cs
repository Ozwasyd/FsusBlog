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
    internal bool SiteTrafficReadable { get; }
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
    internal bool SiteConfigEditor { get; }
    internal bool SiteConfigOverrideActive { get; }
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
        PrivateMediaRoot = ResolvePath(MediaEndpoints.StorageSetting, dir => EnsureDirectory(Path.Combine(dir, "private-media")));
        PublicMediaRoot = ResolvePath(PublishedMediaEndpoints.StorageSetting,
            dir => PrivateMediaRoot is null ? null : EnsureDirectory(Path.Combine(dir, "public-media")));
        SitePagesRoot = ResolvePath("FSUSBLOG_SITE_PAGES", dir => DiscoverAssets(dir, "site-pages", BaselineSitePageFiles));
        AppearanceRoot = ResolvePath(AppearanceAssets.RootSetting, dir => DiscoverAssets(dir, "appearance", ["appearance.json"]));
        TrafficRegionsPath = ResolvePath(Analytics.SiteTraffic.RegionsSetting, dir => DiscoverExistingFile(dir, "traffic-regions.json"));

        PublicSearchMode = (configuration[PublicSearchModeSetting] ?? "auto").Trim().ToLowerInvariant();
        if (PublicSearchMode is not ("auto" or "local" or "server"))
            throw new InvalidOperationException($"{PublicSearchModeSetting} must be auto, local, or server.");

        PublicCommentSubmissions = Enabled(PublicCommentsSetting);
        SignedInCommentReplies = PublicCommentSubmissions && Enabled(CommentReplies.Setting);
        PrivateInboxWrites = Enabled(InboxWriteEndpoints.Setting);
        DocumentExportTasks = Enabled(DocumentExportEndpoints.Setting);
        PublicHotArticles = Enabled(Analytics.PublicHotArticles.Setting);
        WideSearchCorpus = Enabled(WideSearchCorpusEndpoints.Setting);
        PrivateMediaResumable = PrivateMediaRoot is not null && Enabled(MediaUploadEndpoints.Setting);

        var hasHttpsPublic = publicSite.Origin is not null &&
            Uri.TryCreate(publicSite.Origin, UriKind.Absolute, out var publicUri) &&
            publicUri.Scheme == Uri.UriSchemeHttps;

        ArticleReadProof = ResolveRequired(ReadOptionalBool(configuration, ArticleReadEndpoints.Setting), publicSite.Origin is not null,
            "Article read proof requires an explicit public HTTPS origin.");

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
        var loopbackAdmin = adminIdentity is { Origin: { Scheme: "http", IsLoopback: true } };
        SiteTrafficReadable = requestedTraffic != false && (SiteTraffic || loopbackAdmin);

        AdminInboxReplies = hasAdmin && Enabled(AdminInboxEndpoints.ReplySetting);
        AdminInboxStatus = hasAdmin && Enabled(AdminInboxEndpoints.StatusSetting);
        AdminInboxNotice = hasAdmin && Enabled(AdminInboxEndpoints.NoticeSetting);
        AdminInboxSharedRead = hasAdmin && Enabled(AdminInboxEndpoints.SharedReadSetting);
        AdminInboxLive = hasAdmin && Enabled(AdminInboxEndpoints.LiveSetting);
        AdminInboxActivityOrder = hasAdmin && Enabled(InboxActivityFence.Setting);
        AdminCommentBatch = hasAdmin && Enabled(AdminModerationBatchEndpoints.Setting);

        AdminArticleRollback = ResolveRequired(ReadOptionalBool(configuration, AdminArticleRollbackEndpoints.Setting), hasAdmin,
            "Published article rollback requires an administrator origin.");

        AdminTagMetadata = ResolveRequired(ReadOptionalBool(configuration, AdminTagMetadataEndpoints.Setting), hasAdmin,
            "Tag metadata editing requires an administrator origin.");

        AdminCategoryMetadata = ResolveRequired(ReadOptionalBool(configuration, AdminTagMetadataEndpoints.CategorySetting), hasAdmin,
            "Category metadata editing requires an administrator origin.");

        var siteAndAdminReady = (httpsAdmin && publicSite.Origin is not null) || loopbackAdmin;
        SitePageEditor = ResolveRequired(ReadOptionalBool(configuration, SitePages.EditorSetting), siteAndAdminReady,
            "The site page editor requires HTTPS administrator and public origins or a loopback administrator origin.");

        var requestedSiteConfigEditor = ReadOptionalBool(configuration, PublicSiteConfiguration.EditorSetting);
        SiteConfigEditor = ResolveRequired(requestedSiteConfigEditor, siteAndAdminReady,
            "The site configuration editor requires HTTPS administrator and public origins or a loopback administrator origin.");
        SiteConfigOverrideActive = requestedSiteConfigEditor ?? true;

        OnlineAppearance = ReadOptionalBool(configuration, AppearanceAssets.OnlineSetting) ??
            (AppearanceRoot is not null && siteAndAdminReady);
        if (OnlineAppearance && !siteAndAdminReady)
            throw new InvalidOperationException("Online appearance requires HTTPS administrator and public origins or a loopback administrator origin.");
        if (OnlineAppearance && string.IsNullOrWhiteSpace(AppearanceRoot))
            throw new InvalidOperationException("Online appearance requires a signed deployment registry.");

        PdfExport = PdfDocumentExport.Read(configuration);
        PluginPreview = PluginPreviewEndpoints.Read(configuration, publicSite.Origin, webDist, PrivateMediaRoot);

        bool Enabled(string key) => ReadOptionalBool(configuration, key) ?? true;

        string? ResolvePath(string key, Func<string, string?> discover)
        {
            var value = configuration[key];
            if (value is not null) return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
            return dataDir is null ? null : discover(dataDir);
        }
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

    private static bool ResolveRequired(bool? requested, bool available, string error)
    {
        if (requested == true && !available) throw new InvalidOperationException(error);
        return requested ?? available;
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
        return EnsureDirectory(full);
    }

    private static string EnsureDirectory(string path)
    {
        if (!Directory.Exists(path))
        {
            if (OperatingSystem.IsWindows()) Directory.CreateDirectory(path);
            else Directory.CreateDirectory(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        return path;
    }

    private static string? DiscoverAssets(string dataDir, string name, string[] files)
    {
        var path = Path.Combine(dataDir, name);
        return Directory.Exists(path) && files.All(file => File.Exists(Path.Combine(path, file))) ? path : null;
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
