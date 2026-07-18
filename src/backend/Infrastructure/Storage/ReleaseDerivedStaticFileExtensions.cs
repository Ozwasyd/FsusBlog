using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.FileProviders;

namespace FsusBlog.Server.Infrastructure.Storage;

public static class ReleaseDerivedStaticFileExtensions
{
    public const string RequestPath = "/release-derived";

    public static IApplicationBuilder UseFsusReleaseDerivedArtifacts(
        this IApplicationBuilder app,
        string releaseDerivedRoot)
    {
        ArgumentNullException.ThrowIfNull(app);
        string normalizedRoot = Path.GetFullPath(releaseDerivedRoot);
        if (!Directory.Exists(normalizedRoot))
        {
            throw new DirectoryNotFoundException($"Release-derived root does not exist: {normalizedRoot}");
        }

        var contentTypes = new FileExtensionContentTypeProvider();
        contentTypes.Mappings[".aeds"] = "application/octet-stream";
        contentTypes.Mappings[".patch"] = "application/octet-stream";

        return app.UseStaticFiles(new StaticFileOptions
        {
            RequestPath = RequestPath,
            FileProvider = new PhysicalFileProvider(normalizedRoot),
            ContentTypeProvider = contentTypes,
            ServeUnknownFileTypes = false,
            OnPrepareResponse = context =>
            {
                string fileName = context.File.Name;
                bool mutablePointer = fileName is "index.bin" or "index.manifest.aeds" or "current.json"
                    || (context.Context.Request.Path.Value?.Contains("/dictionaries/", StringComparison.Ordinal) ?? false);
                context.Context.Response.Headers.CacheControl = ReleaseStorageLayout.CacheControlFor(!mutablePointer);
                context.Context.Response.Headers["X-Content-Type-Options"] = "nosniff";
                context.Context.Response.Headers["X-Fsus-Release-Derived"] = ResolveReleaseId(context.Context.Request.Path);
            }
        });
    }

    internal static string ResolveReleaseId(PathString requestPath)
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
