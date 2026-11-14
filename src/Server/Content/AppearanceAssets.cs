using FsusBlog.V2.Core.Extensions;

namespace FsusBlog.V2.Server.Content;

internal sealed class AppearanceAssets(AppearanceRegistry registry)
{
    internal const string RootSetting = "FSUSBLOG_APPEARANCE_ROOT";
    private const string StyleRoute = "/site-appearance/{digest}.css";
    private const string FontRoute = "/site-appearance/font/{digest}.woff2";

    internal static AppearanceAssets? Load(string? setting, string webDist, string? mediaRoot)
    {
        if (string.IsNullOrEmpty(setting)) return null;
        if (!Path.IsPathFullyQualified(setting)) throw new InvalidOperationException("The appearance registry requires an absolute path.");
        var root = new DirectoryInfo(setting);
        RequireSeparate(webDist);
        if (!string.IsNullOrWhiteSpace(mediaRoot)) RequireSeparate(Path.GetFullPath(mediaRoot));
        return new(AppearanceRegistry.Load(root, TimeProvider.System));

        void RequireSeparate(string other)
        {
            if (!Outside(Path.GetRelativePath(other, root.FullName)) || !Outside(Path.GetRelativePath(root.FullName, other)))
                throw new InvalidOperationException("Appearance inputs must use a directory separate from the web build and author media.");
        }

        static bool Outside(string relative) => relative == ".." || relative.StartsWith("../", StringComparison.Ordinal);
    }

    internal string WithStylesheet(string template) => registry.StyleDigest is { } digest
        ? template.Replace("</head>", $"<link rel=\"stylesheet\" href=\"/site-appearance/{digest}.css\"></head>", StringComparison.Ordinal)
        : template;

    internal void Map(WebApplication app)
    {
        if (registry.StyleDigest is null) return;
        app.MapGet(StyleRoute, (HttpContext ctx, string digest) => Serve(ctx, registry.ReadStyle(digest), "text/css; charset=utf-8"));
        if (registry.FontDigest is not null)
            app.MapGet(FontRoute, (HttpContext ctx, string digest) => Serve(ctx, registry.ReadFont(digest), "font/woff2"));
    }

    private static IResult Serve(HttpContext context, byte[]? bytes, string type)
    {
        context.Response.Headers.CacheControl = "no-store";
        return bytes is null ? Results.NotFound() : Results.Bytes(bytes, type);
    }
}
