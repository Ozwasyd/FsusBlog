using Microsoft.Extensions.FileProviders;

namespace FsusBlog.Server.Infrastructure.Storage;

public static class ReleaseAssetStaticFileExtensions
{
    public const string RequestPath = "/release-assets";

    private static readonly HashSet<string> s_mutableEntryNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "index.html",
        "sw.js",
        "manifest.webmanifest",
        "release-compatibility.json"
    };

    /// <summary>
    /// Serves only materialized, release-scoped assets. The configured store root
    /// points at the directory that contains one immutable child directory per release.
    /// </summary>
    public static IApplicationBuilder UseFsusReleaseAssets(
        this IApplicationBuilder app,
        string materializedReleaseRoot)
    {
        ArgumentNullException.ThrowIfNull(app);
        string normalizedRoot = Path.GetFullPath(materializedReleaseRoot);
        if (!Directory.Exists(normalizedRoot))
        {
            throw new DirectoryNotFoundException($"Materialized release asset root does not exist: {normalizedRoot}");
        }

        return app.UseStaticFiles(new StaticFileOptions
        {
            RequestPath = RequestPath,
            FileProvider = new PhysicalFileProvider(normalizedRoot),
            ServeUnknownFileTypes = false,
            OnPrepareResponse = context =>
            {
                string fileName = context.File.Name;
                bool mutableEntry = s_mutableEntryNames.Contains(fileName);
                context.Context.Response.Headers.CacheControl = ReleaseStorageLayout.CacheControlFor(!mutableEntry);
                context.Context.Response.Headers["X-Content-Type-Options"] = "nosniff";
                context.Context.Response.Headers["X-Fsus-Frontend-Build"] = ResolveBuildId(context.Context.Request.Path);
            }
        });
    }

    internal static string ResolveBuildId(PathString requestPath)
    {
        string value = requestPath.Value ?? string.Empty;
        string prefix = RequestPath + "/";
        if (!value.StartsWith(prefix, StringComparison.Ordinal))
        {
            return "unknown";
        }

        int separator = value.IndexOf('/', prefix.Length);
        string candidate = separator < 0 ? value[prefix.Length..] : value[prefix.Length..separator];
        return candidate.Length is >= 6 and <= 128
            && char.IsAsciiLetterOrDigit(candidate[0])
            && candidate.All(static character => char.IsAsciiLetterOrDigit(character)
                || character is '.' or '_' or '-')
            ? candidate
            : "unknown";
    }
}
