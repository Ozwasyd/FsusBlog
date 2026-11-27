namespace FsusBlog.V2.Server;

internal sealed class ServerBootstrapContext(
    string webDist,
    SiteCapabilities capabilities,
    IntegrityKeys integrityKeys,
    AppearanceAssets? appearance,
    PublicationProofKeys? proofKeys,
    PublicationCheckpointArchive? checkpointArchive,
    bool publicMediaEnabled) : IDisposable
{
    internal string WebDist { get; } = webDist;
    internal SiteCapabilities Capabilities { get; } = capabilities;
    internal IntegrityKeys IntegrityKeys { get; } = integrityKeys;
    internal AppearanceAssets? Appearance { get; } = appearance;
    internal PublicationProofKeys? ProofKeys { get; } = proofKeys;
    internal PublicationCheckpointArchive? CheckpointArchive { get; } = checkpointArchive;
    internal bool PublicMediaEnabled { get; } = publicMediaEnabled;

    public void Dispose() => ProofKeys?.Dispose();
}

internal static class ServerServices
{
    internal static async Task<ServerBootstrapContext> ConfigureAsync(WebApplicationBuilder builder, CancellationToken ct = default)
    {
        var dist = WebPages.ResolveWebDist(builder.Configuration, builder.Environment);
        var capabilities = SiteCapabilities.Resolve(builder.Configuration, dist);
        var connectionString = builder.Configuration["FSUSBLOG_DB"] ?? throw new InvalidOperationException("FSUSBLOG_DB is required.");
        var integrityKeys = new IntegrityKeys(builder.Configuration);
        var template = await WebPages.LoadTemplateAsync(dist, capabilities, ct);
        var appearance = AppearanceAssets.Load(capabilities.AppearanceRoot, dist, capabilities.PrivateMediaRoot, capabilities.OnlineAppearance);

        builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = WireLimits.MaxCommandFrameBytes);
        builder.Services.AddSingleton(capabilities);
        builder.Services.AddSingleton(NpgsqlDataSource.Create(connectionString));
        builder.Services.AddSingleton(services => new InstanceLease(connectionString, services.GetService<RuntimeEvidence>()));

        var evidenceDirectory = builder.Configuration["FSUSBLOG_RUNTIME_EVIDENCE_CONTROL"];
        if (!string.IsNullOrEmpty(evidenceDirectory))
        {
            var output = builder.Configuration["FSUSBLOG_RUNTIME_EVIDENCE_OUTPUT"] ??
                throw new InvalidOperationException("Runtime evidence output is required.");
            builder.Services.AddHttpContextAccessor();
            var slowRequests = builder.Configuration.GetValue("FSUSBLOG_RUNTIME_SLOW_REQUESTS", false);
            builder.Services.AddSingleton(services => new RuntimeEvidence(evidenceDirectory, output,
                services.GetRequiredService<IHttpContextAccessor>(), slowRequests));
        }

        var publicSite = capabilities.PublicSite;
        builder.Services.AddSingleton<SiteTraffic>();
        if (capabilities.SiteTraffic)
            builder.Services.AddHostedService(services => services.GetRequiredService<SiteTraffic>());

        if (capabilities.DocumentExportTasks)
        {
            builder.Services.AddHostedService(services => new DocumentExportWorker(services.GetRequiredService<NpgsqlDataSource>(),
                services.GetRequiredService<InstanceLease>(), capabilities.PdfExport, services.GetService<MediaFiles>(),
                services.GetRequiredService<ILogger<DocumentExportWorker>>(), services.GetService<RuntimeEvidence>()));
        }

        if (capabilities.PublicHotArticles)
        {
            builder.Services.AddSingleton<PublicHotArticles>();
            builder.Services.AddHostedService(services => services.GetRequiredService<PublicHotArticles>());
        }

        if (capabilities.ArticleReadProof)
        {
            builder.Services.AddSingleton(services => new ArticleReadAuthority(connectionString,
                services.GetRequiredService<InstanceLease>(), TimeProvider.System));
        }

        var proofKeys = PublicationProofKeys.Read(builder.Configuration, integrityKeys, publicSite.Origin, dist);
        try
        {
            var checkpointArchive = PublicationCheckpointArchive.Read(builder.Configuration, integrityKeys, publicSite.Origin, dist, TimeProvider.System);
            if (proofKeys is not null)
            {
                builder.Services.AddSingleton(proofKeys);
                builder.Services.AddSingleton<PublicationProofs>();
                builder.Services.AddHostedService(services => services.GetRequiredService<PublicationProofs>());
            }

            if (appearance is not null) builder.Services.AddSingleton(appearance);
            builder.Services.AddSingleton(publicSite);
            builder.Services.AddSingleton(new WebPages(template, publicSite, appearance));
            builder.Services.AddSingleton(services => new SitePages(capabilities.SitePagesRoot,
                services.GetRequiredService<WebPages>(), services.GetRequiredService<NpgsqlDataSource>(),
                services.GetRequiredService<InstanceLease>(), capabilities.SitePageEditor));
            builder.Services.AddSingleton(services => new DistributionSettings(publicSite,
                services.GetRequiredService<SitePages>().CurrentConfiguredPaths));
            builder.Services.AddSingleton<Store>();
            builder.Services.AddSingleton<PublicProjection>();
            builder.Services.AddSingleton(_ => new PublicSearchCache());
            builder.Services.AddSingleton(services => new Publications(
                services.GetRequiredService<NpgsqlDataSource>(),
                services.GetRequiredService<WebPages>(),
                services.GetRequiredService<ILogger<Publications>>(),
                services.GetService<InstanceLease>(),
                services.GetService<RuntimeEvidence>(),
                services.GetService<DistributionSettings>(),
                services.GetService<PublishedMediaStore>(),
                services.GetService<PublicProjection>(),
                capabilities.SiteConfigOverrideActive,
                services.GetRequiredService<SitePages>(),
                services.GetRequiredService<PublicSearchCache>(),
                capabilities.LocalSearchCorpus));

            if (capabilities.WideSearchCorpus)
            {
                builder.Services.AddSingleton<WideSearchCorpusSignal>();
                builder.Services.AddHostedService<WideSearchCorpusWorker>();
            }

            builder.Services.AddSingleton(services => new InboxWake(connectionString,
                services.GetRequiredService<ILogger<InboxWake>>(), services.GetService<RuntimeEvidence>()));
            builder.Services.AddHostedService(services => services.GetRequiredService<InboxWake>());
            builder.Services.AddSingleton<CommentReadStore>();
            builder.Services.AddSingleton(_ => new ScopedPow(TimeProvider.System));

            if (capabilities.PrivateMediaRoot is { Length: > 0 } mediaRoot)
            {
                builder.Services.AddSingleton(_ => new MediaFiles(mediaRoot, dist));
                builder.Services.AddSingleton<MediaStore>();
            }

            var publicMediaEnabled = PublishedMediaEndpoints.Configure(builder, dist, capabilities);
            builder.Services.AddHostedService<OutboxWorker>();
            builder.Services.AddSingleton<AuthorTextRebuildWorker>();
            builder.Services.AddHostedService(services => services.GetRequiredService<AuthorTextRebuildWorker>());

            AddRateLimiting(builder.Services, capabilities, publicMediaEnabled, proofKeys is not null || checkpointArchive is not null);
            return new ServerBootstrapContext(dist, capabilities, integrityKeys, appearance, proofKeys, checkpointArchive, publicMediaEnabled);
        }
        catch
        {
            proofKeys?.Dispose();
            throw;
        }
    }

    internal static void AddRateLimiting(IServiceCollection services, SiteCapabilities capabilities,
        bool publicMediaEnabled, bool hasPublicationProofs)
    {
        services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            options.OnRejected = async (context, _) =>
            {
                if (context.HttpContext.GetEndpoint()?.Metadata.GetMetadata<MediaEndpoints.PrivateRead>() is not null)
                    MediaEndpoints.SetHidden(context.HttpContext.Response);
                else if (publicMediaEnabled && context.HttpContext.Request.Path.StartsWithSegments(PublishedMediaEndpoints.PathPrefix))
                    PublishedMediaEndpoints.SetHeaders(context.HttpContext.Response);
                else await ServerHttp.Error(context.HttpContext, 429, "Rate limit reached.").ExecuteAsync(context.HttpContext);
            };
            options.AddPolicy("sign-in", context => RateLimitPartition.GetFixedWindowLimiter(
                context.Connection.RemoteIpAddress, _ => new FixedWindowRateLimiterOptions { PermitLimit = 12, Window = TimeSpan.FromMinutes(1) }));
            options.AddPolicy("reader-registration", context => RateLimitPartition.GetFixedWindowLimiter(
                context.Connection.RemoteIpAddress, _ => new FixedWindowRateLimiterOptions { PermitLimit = 9, Window = TimeSpan.FromMinutes(1) }));
            options.AddPolicy("mfa", context => RateLimitPartition.GetFixedWindowLimiter(
                (context.Connection.RemoteIpAddress, (context.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText),
                _ => new FixedWindowRateLimiterOptions { PermitLimit = 8, Window = TimeSpan.FromMinutes(1) }));
            options.AddImmediateConcurrency(CommandEndpoints.Policy, 32);
            if (capabilities.DocumentExportTasks)
                options.AddImmediateConcurrency("document-export-download", 4);
            if (capabilities.PluginPreview is not null)
                options.AddImmediateConcurrency(PluginPreviewEndpoints.RatePolicy, 1);
            if (capabilities.PdfExport is not null)
                options.AddImmediateConcurrency(PdfDocumentExport.RatePolicy, 1);
            options.AddPolicy("comment-author-challenge", context => RateLimitPartition.GetFixedWindowLimiter(
                context.Connection.RemoteIpAddress, _ => new FixedWindowRateLimiterOptions { PermitLimit = 24, Window = TimeSpan.FromMinutes(1) }));
            if (hasPublicationProofs)
                options.AddImmediateConcurrency("publication-proof", 4);
            if (capabilities.ArticleReadProof) ArticleReadEndpoints.AddRateLimit(options);
            options.AddImmediateConcurrency(CommandEndpoints.QueryPolicy, 32);
            if (capabilities.WideSearchCorpus)
            {
                options.AddImmediateConcurrency(WideSearchCorpusEndpoints.ManifestPolicy, 8);
                options.AddImmediateConcurrency(WideSearchCorpusEndpoints.PagePolicy, 2);
            }
            options.AddImmediateConcurrency("inbox-stream", 32);
            if (capabilities.AdminInboxLive)
                options.AddImmediateConcurrency(AdminInboxEndpoints.LivePolicy, 4);
            if (capabilities.AdminIdentity is not null)
                AdminIdentityEndpoints.AddRateLimits(options);
            if (capabilities.PrivateMediaRoot is { Length: > 0 })
                MediaEndpoints.AddRateLimits(options);
            if (publicMediaEnabled) PublishedMediaEndpoints.AddRateLimit(options);
            if (capabilities.Subscription is not null) SubscriptionEndpoints.AddRateLimits(options);
        });
    }

    internal static SchemaAdmission BuildSchemaAdmission(SiteCapabilities capabilities, bool publicMediaEnabled) => new(
        Subscription: capabilities.Subscription is null ? null : true,
        RecoveryKey: capabilities.RecoveryKey is null ? null : true,
        AdminInboxStatus: capabilities.AdminInboxStatus ? true : null,
        AdminInboxNotice: capabilities.AdminInboxNotice ? true : null,
        AdminInboxRead: capabilities.AdminInboxSharedRead ? true : null,
        AdminInboxReply: capabilities.AdminInboxReplies ? true : null,
        SiteRefresh: capabilities.SitePersistentRefresh ? true : null,
        SitePageEditor: capabilities.SitePageEditor ? true : null,
        SiteConfigEditor: capabilities.SiteConfigEditor ? true : null,
        AdminArticleRollback: capabilities.AdminArticleRollback ? true : null,
        AppearanceActivation: capabilities.OnlineAppearance ? true : null,
        AdminTagMetadata: capabilities.AdminTagMetadata ? true : null,
        PublicationMedia: publicMediaEnabled ? true : null,
        AdminCommentBatch: capabilities.AdminCommentBatch ? true : null,
        DocumentExports: capabilities.DocumentExportTasks ? true : null,
        AdminCategoryMetadata: capabilities.AdminCategoryMetadata ? true : null);

    internal static async Task<IDisposable> InitializeRuntimeAsync(WebApplication app, ServerBootstrapContext bootstrap)
    {
        var lease = app.Services.GetRequiredService<InstanceLease>();
        var publications = app.Services.GetRequiredService<Publications>();
        var searchCache = app.Services.GetRequiredService<PublicSearchCache>();
        app.Services.GetService<RuntimeEvidence>()?.RegisterSearchCache(searchCache);
        var stopLease = app.Lifetime.ApplicationStopping.Register(lease.Stop);
        var clearCacheOnLeaseStop = lease.Stopped.Register(() =>
        {
            publications.OnLeaseStopped();
            searchCache.OnSnapshotChanged(null);
        });
        try
        {
            await lease.Start(app.Logger, app.Lifetime.ApplicationStopping,
                BuildSchemaAdmission(bootstrap.Capabilities, bootstrap.PublicMediaEnabled));
            var publicationProofs = app.Services.GetService<PublicationProofs>();
            if (publicationProofs is not null) await publicationProofs.Initialize(app.Lifetime.ApplicationStopping);
            app.Logger.LogInformation("Building initial public projection from current PostgreSQL schema.");
            await publications.Refresh(CancellationToken.None);
            return new CombinedDisposable(clearCacheOnLeaseStop, stopLease);
        }
        catch
        {
            clearCacheOnLeaseStop.Dispose();
            stopLease.Dispose();
            throw;
        }
    }

    private sealed class CombinedDisposable(IDisposable first, IDisposable second) : IDisposable
    {
        public void Dispose()
        {
            try { first.Dispose(); }
            finally { second.Dispose(); }
        }
    }
}
