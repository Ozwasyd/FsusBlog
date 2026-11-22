using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using FsusBlog.V2.Core.Extensions;
using FsusBlog.V2.Platform.Extensions;
using FsusBlog.V2.Server.Operations;
using Npgsql;

namespace FsusBlog.V2.Server.Content;

internal sealed class AppearanceAssets(AppearanceRegistry registry, bool online)
{
    internal const string RootSetting = "FSUSBLOG_APPEARANCE_ROOT";
    internal const string OnlineSetting = "FSUSBLOG_APPEARANCE_ACTIVATION";
    private const string CurrentStyleRoute = "/site-appearance/current.css";
    private const string StyleRoute = "/site-appearance/{digest}.css";
    private const string FontRoute = "/site-appearance/font/{digest}.woff2";

    internal AppearanceRegistry Registry { get; } = registry;
    internal bool Online { get; } = online;

    internal static AppearanceAssets? Load(string? setting, string webDist, string? mediaRoot, bool online = false)
    {
        if (string.IsNullOrEmpty(setting))
            return online ? throw new InvalidOperationException("Online appearance requires a signed deployment registry.") : null;
        if (!Path.IsPathFullyQualified(setting)) throw new InvalidOperationException("The appearance registry requires an absolute path.");
        var root = new DirectoryInfo(setting);
        RequireSeparate(webDist);
        if (!string.IsNullOrWhiteSpace(mediaRoot)) RequireSeparate(Path.GetFullPath(mediaRoot));
        return new(AppearanceRegistryLoader.Load(root, TimeProvider.System), online);

        void RequireSeparate(string other)
        {
            if (!Outside(Path.GetRelativePath(other, root.FullName)) || !Outside(Path.GetRelativePath(root.FullName, other)))
                throw new InvalidOperationException("Appearance inputs must use a directory separate from the web build and author media.");
        }

        static bool Outside(string relative) => relative == ".." || relative.StartsWith("../", StringComparison.Ordinal);
    }

    internal string? StylesheetPath =>
        Online ? CurrentStyleRoute : Registry.StyleDigest is { } digest ? $"/site-appearance/{digest}.css" : null;

    internal string? StylesheetLink =>
        StylesheetPath is { } path ? $"<link rel=\"stylesheet\" href=\"{path}\">" : null;

    internal void Map(WebApplication app)
    {
        if (Online)
        {
            MapOnline(app);
            return;
        }
        if (Registry.StyleDigest is null) return;
        app.MapGet(StyleRoute, (HttpContext ctx, string digest) => Serve(ctx, Registry.ReadStyle(digest), "text/css; charset=utf-8"));
        if (Registry.FontDigest is not null)
            app.MapGet(FontRoute, (HttpContext ctx, string digest) => Serve(ctx, Registry.ReadFont(digest), "font/woff2"));
    }

    private void MapOnline(WebApplication app)
    {
        string[] read = [HttpMethods.Get, HttpMethods.Head];
        var source = app.Services.GetRequiredService<NpgsqlDataSource>();
        var lease = app.Services.GetRequiredService<InstanceLease>();
        app.MapMethods(CurrentStyleRoute, read, (HttpContext ctx, CancellationToken ct) =>
            Read(ctx, source, lease, null, null, false, ct)).RequireRateLimiting("query");
        app.MapMethods("/site-appearance/{revision:long}/{digest}.css", read,
            (HttpContext ctx, long revision, string digest, CancellationToken ct) =>
                Read(ctx, source, lease, revision, digest, false, ct)).RequireRateLimiting("query");
        app.MapMethods("/site-appearance/font/{revision:long}/{digest}.woff2", read,
            (HttpContext ctx, long revision, string digest, CancellationToken ct) =>
                Read(ctx, source, lease, revision, digest, true, ct)).RequireRateLimiting("query");
    }

    private async Task<IResult> Read(HttpContext ctx, NpgsqlDataSource source, InstanceLease lease, long? revision,
        string? digest, bool font, CancellationToken ct)
    {
        ctx.Response.Headers.CacheControl = "no-store";
        ctx.Response.Headers["Cross-Origin-Resource-Policy"] = "same-origin";
        if (ctx.Request.Headers.TryGetValue("Sec-Fetch-Site", out var site) && site.ToString() is not ("same-origin" or "none"))
            return Results.NotFound();
        var origin = ctx.Request.Headers.Origin;
        if (origin.Count > 0 && (origin.Count != 1 ||
            !string.Equals(origin[0], $"{ctx.Request.Scheme}://{ctx.Request.Host}", StringComparison.OrdinalIgnoreCase)))
            return Results.NotFound();
        if ((!ctx.Request.IsHttps && (ctx.Connection.RemoteIpAddress is not { } peer || !IPAddress.IsLoopback(peer))) ||
            revision is < 0 || (digest is not null && !ValidDigest(digest)))
            return Results.NotFound();
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(TimeSpan.FromSeconds(1));
        try
        {
            // Only current coordinates authorize reads. Release DB custody before writing to a potentially slow client.
            await using var db = await source.OpenConnectionAsync(budget.Token);
            await using var tx = await InstanceLease.BeginProtected(db, lease, budget.Token);
            var active = await AppearanceActivationStore.Read(db, tx, Registry, budget.Token);
            if (revision.HasValue && revision != active.Revision)
                return Unavailable(revision);
            var bytes = font ? Registry.SelectedFont(active.Selected, digest!)
                : Registry.SelectedStyle(active.Selected, active.Revision);
            var response = Response(bytes, active.Revision, revision, digest, font);
            // Recheck after preparing bounded bytes. An update that wins the row first invalidates this token.
            if (!await AppearanceActivationStore.StillActive(db, tx, active.Revision, budget.Token))
                return Unavailable(revision);
            if (!Registry.IsCurrent(active.Selected)) return Unavailable(revision);
            await InstanceLease.CommitProtected(tx, lease, budget.Token);
            return response;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return revision.HasValue ? Results.StatusCode(StatusCodes.Status503ServiceUnavailable) : Unavailable(null);
        }
    }

    private static IResult Response(byte[]? bytes, long active, long? revision, string? digest, bool font)
    {
        if (bytes is null || bytes.Length == 0)
            return Unavailable(revision);
        var actual = Convert.ToHexStringLower(SHA256.HashData(bytes));
        if (!revision.HasValue)
            return Results.Redirect("/site-appearance/" + active.ToString(CultureInfo.InvariantCulture) + "/" + actual + ".css");
        return actual == digest
            ? Results.Bytes(bytes, font ? "font/woff2" : "text/css; charset=utf-8")
            : Results.NotFound();
    }

    private static bool ValidDigest(string value) => value.Length == 64 &&
        value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static IResult Unavailable(long? revision) => revision.HasValue
        ? Results.NotFound() : Results.Bytes(Array.Empty<byte>(), "text/css; charset=utf-8");

    private static IResult Serve(HttpContext context, byte[]? bytes, string type)
    {
        context.Response.Headers.CacheControl = "no-store";
        return bytes is null ? Results.NotFound() : Results.Bytes(bytes, type);
    }
}
