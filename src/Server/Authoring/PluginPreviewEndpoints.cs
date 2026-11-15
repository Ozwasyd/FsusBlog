using System.Globalization;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Extensions;
using FsusBlog.V2.Server.Operations;
using FsusBlog.V2.Server.Sessions;
using Microsoft.AspNetCore.Http.Features;

namespace FsusBlog.V2.Server.Authoring;

internal sealed class PluginPreviewEndpoints(string pluginId, DirectoryInfo registry, LinuxPluginRunner worker, string origin)
{
    internal const string Setting = "FSUSBLOG_AUTHOR_PLUGIN_PREVIEW_ID";
    internal const string Marker = "<meta name=\"fsus-author-plugin-preview\" content=\"1\">";
    internal const string RatePolicy = "author-plugin-preview";
    private const string Route = "/api/v2/authoring/draft/{id:int}/plugin-preview.md";

    internal static PluginPreviewEndpoints? Read(IConfiguration configuration, string? origin, string dist, string? mediaRoot)
    {
        if (configuration[Setting] is not { } id) return null;
        try
        {
            if (origin is null || !ExtensionManifestReader.IsIdentifier(id) || id.Count(c => c is '.' or '-') < 2 ||
                Environment.GetEnvironmentVariable("FSUSBLOG_PLATFORM_PLUGIN_ROOT") is not { } raw || !Path.IsPathFullyQualified(raw))
                throw Invalid();
            var registry = new DirectoryInfo(raw);
            var path = ExtensionDisk.ValidatePrivateRoot(registry);
            if (Related(path, dist) || (mediaRoot is { Length: > 0 } && Related(path, Path.GetFullPath(mediaRoot)))) throw Invalid();
            return new(id, registry, LinuxPluginRunner.Open(), origin);
        }
        catch (Exception error) when (error is ExtensionRejectedException or IOException or UnauthorizedAccessException or
            ArgumentException or NotSupportedException)
        {
            throw Invalid();
        }

        static InvalidOperationException Invalid() => new("Author plugin preview requires an explicit HTTPS site origin, private registry and verified Linux ARM64 worker configuration.");
        static bool Related(string left, string right) => Contains(left, right) || Contains(right, left);
        static bool Contains(string parent, string candidate) =>
            Path.GetRelativePath(parent, candidate).Split(Path.DirectorySeparatorChar, 2)[0] != "..";
    }

    internal void Map(WebApplication app, string cookie, Func<HttpContext, string, int, string?> query)
    {
        app.MapPost(Route, async (HttpContext ctx, Store store, InstanceLease lease, int id, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "private, no-store";
            ctx.Response.Headers.XContentTypeOptions = "nosniff";
            ctx.Response.Headers["Cross-Origin-Resource-Policy"] = "same-origin";
            ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
            if (!ctx.Request.IsHttps || !string.Equals($"https://{ctx.Request.Host}", origin, StringComparison.OrdinalIgnoreCase) ||
                ctx.Request.Headers.Origin is not { Count: 1 } supplied || !string.Equals(supplied[0], origin, StringComparison.OrdinalIgnoreCase))
                throw new BusinessException(Rejection.Forbidden, "A same-origin HTTPS request is required.");
            if (ctx.Features.Get<IHttpRequestBodyDetectionFeature>()?.CanHaveBody != false ||
                id <= 0 || !long.TryParse(query(ctx, "revision", 19), NumberStyles.None, CultureInfo.InvariantCulture, out var revision) || revision <= 0)
                throw new BusinessException(Rejection.Invalid, "An empty request and a valid current revision are required.");

            var token = ctx.Request.Cookies[cookie];
            var session = SiteSessions.Requested(ctx);
            using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct, lease.Stopped, app.Lifetime.ApplicationStopping);
            lifetime.CancelAfter(TimeSpan.FromSeconds(12));
            try
            {
                var source = await Read(lifetime.Token);
                if (Encoding.UTF8.GetByteCount(source.Body) > PureRenderPlugin.MaximumMarkdownBytes)
                    throw new BusinessException(Rejection.Invalid, "This saved revision exceeds the plugin preview size limit.");
                await PureRenderInvocation.RunAsync(registry, pluginId, source.Body, worker.RunAsync, async cancellation =>
                {
                    // The signed worker does not hold account, session or article transaction locks.
                    if (await Read(cancellation) != source)
                        throw new BusinessException(Rejection.Conflict, "The saved revision changed. Reload to preview it.");
                }, (result, cancellation) =>
                {
                    ctx.Response.ContentType = "text/plain; charset=utf-8";
                    ctx.Response.ContentLength = result.Length;
                    return ctx.Response.Body.WriteAsync(result, cancellation).AsTask();
                }, lifetime.Token);
            }
            catch (Exception error) when (!ctx.Response.HasStarted && IsUnavailable(error, ct))
            {
                app.Logger.LogWarning("Author plugin preview unavailable ({Reason}); cleanupFailed={CleanupFailed}",
                    error is ExtensionRejectedException rejected ? rejected.Code : "plugin-local-operation",
                    PluginWorkerCompletion.CleanupFailure(error) is not null);
                throw new PublicUnavailableException();
            }

            Task<(Guid Author, long Generation, string Body)> Read(CancellationToken cancellation) =>
                store.WithSession(token, true, async (db, tx, actor) =>
                {
                    SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, session);
                    await RevisionHistoryStore.LockCurrent(db, tx, actor, id, revision, cancellation);
                    var source = await RevisionHistoryStore.ReadSource(db, tx, id, revision, cancellation);
                    return (actor.Id, actor.Generation, source.Body);
                }, cancellation);
        }).RequireRateLimiting(RatePolicy);
    }

    private static bool IsUnavailable(Exception error, CancellationToken request) =>
        error is ExtensionRejectedException or IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException or
            TimeoutException or System.ComponentModel.Win32Exception or NotSupportedException ||
        error is OperationCanceledException && !request.IsCancellationRequested;
}
