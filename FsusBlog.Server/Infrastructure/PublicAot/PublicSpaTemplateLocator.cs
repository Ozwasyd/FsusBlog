namespace FsusBlog.Server.Infrastructure.PublicAot;

internal static class PublicSpaTemplateLocator
{
    private const string FallbackIndexTemplate = """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Loading...</title>
</head>
<body>
    <div id="app"></div>
</body>
</html>
""";

    internal static string ResolveIndexTemplatePath(IWebHostEnvironment env)
    {
        string[] candidates =
        [
            Path.Combine(env.WebRootPath ?? string.Empty, "index.html"),
            Path.Combine(AppContext.BaseDirectory, "wwwroot", "index.html"),
            Path.Combine(env.ContentRootPath, "..", "FsusBlog.Client", "index.html")
        ];

        foreach (string candidate in candidates)
        {
            if (!string.IsNullOrWhiteSpace(candidate) && File.Exists(candidate))
            {
                return candidate;
            }
        }

        return string.Empty;
    }

    internal static async Task<string> ReadIndexTemplateAsync(IWebHostEnvironment env, CancellationToken cancellationToken)
    {
        string indexPath = ResolveIndexTemplatePath(env);
        return string.IsNullOrWhiteSpace(indexPath)
            ? FallbackIndexTemplate
            : await File.ReadAllTextAsync(indexPath, cancellationToken);
    }

    internal static string BuildFallbackIndexHtml() => FallbackIndexTemplate;
}
