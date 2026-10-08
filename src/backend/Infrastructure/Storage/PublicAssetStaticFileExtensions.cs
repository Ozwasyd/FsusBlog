using System.Globalization;
using System.Threading.RateLimiting;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Security;

using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.FileProviders;

namespace FsusBlog.Server.Infrastructure.Storage;

public static class PublicAssetStaticFileExtensions
{
    public static IApplicationBuilder UseFsusPublicAssets(this IApplicationBuilder app, ReleaseStoragePaths paths)
    {
        PublicAssetDeliveryPolicy policy = PublicAssetDeliveryPolicy.Default;
        return UseFsusPublicAssets(app, policy, new PublicAssetFileProvider(Path.Combine(paths.PublicAssetRoot, "illustration")));
    }

    internal static IApplicationBuilder UseFsusPublicAssets(
        this IApplicationBuilder app,
        PublicAssetDeliveryPolicy policy,
        IFileProvider provider)
    {
        var admission = new PublicAssetAdmission(policy);
        app.ApplicationServices.GetRequiredService<IHostApplicationLifetime>().ApplicationStopped.Register(admission.Dispose);
        var contentTypes = new FileExtensionContentTypeProvider();
        contentTypes.Mappings.Clear();
        foreach ((string extension, string mediaType) in policy.MediaTypes)
        {
            contentTypes.Mappings.Add(extension, mediaType);
        }
        app.MapWhen(context => context.Request.Path.StartsWithSegments("/uploads", StringComparison.OrdinalIgnoreCase), branch =>
        {
            branch.Use(async (context, next) =>
            {
                if (!policy.Methods.Contains(context.Request.Method))
                {
                    context.Response.Headers.Allow = string.Join(", ", policy.Methods.Order(StringComparer.Ordinal));
                    Reject(context, StatusCodes.Status405MethodNotAllowed);
                    return;
                }
                if (context.Request.Headers.ContainsKey("Range"))
                {
                    Reject(context, StatusCodes.Status416RangeNotSatisfiable);
                    return;
                }
                string path = context.Request.Path.Value ?? string.Empty;
                if (!context.Request.Path.StartsWithSegments(policy.RoutePrefix, StringComparison.Ordinal, out PathString remaining)
                    || path.IndexOfAny(['%', '\\', '\0', ':']) >= 0
                    || remaining.Value?.Split('/').Skip(1).Any(static segment => segment.Length == 0 || segment.StartsWith(".", StringComparison.Ordinal)) != false
                    || !policy.MediaTypes.ContainsKey(Path.GetExtension(path).ToLowerInvariant()))
                {
                    Reject(context, StatusCodes.Status404NotFound);
                    return;
                }
                using RateLimitLease lease = await admission.AcquireAsync(context);
                if (!lease.IsAcquired)
                {
                    context.Response.Headers.RetryAfter = lease.TryGetMetadata(MetadataName.RetryAfter, out TimeSpan retry)
                        ? Math.Max(1, (int)Math.Ceiling(retry.TotalSeconds)).ToString(CultureInfo.InvariantCulture)
                        : policy.WindowSeconds.ToString(CultureInfo.InvariantCulture);
                    FsusObservability.RecordSecurityEvent("public_asset", "rate_limited", "rejected");
                    if (RateLimiterRejectionRiskSampler.ShouldWriteRiskSignal(context)
                        && context.RequestServices.GetService<ISecurityRiskSignalSink>() is { } risk)
                    {
                        await risk.AddRiskAsync(new SecurityRiskSignal(context, SecurityRiskReason.RateLimited, 10,
                            TimeSpan.FromMinutes(10), SecurityRiskSources.RateLimiter, "public_asset", "fixed_window_rejected"), context.RequestAborted);
                    }
                    Reject(context, StatusCodes.Status429TooManyRequests);
                    return;
                }
                IFileInfo file = provider.GetFileInfo(remaining.Value!);
                if (!file.Exists || file.IsDirectory || file.Length <= 0 || file.Length > policy.MaxFileBytes)
                {
                    Reject(context, StatusCodes.Status404NotFound);
                    return;
                }
                await next();
            });
            branch.UseStaticFiles(new StaticFileOptions
            {
                RequestPath = policy.RoutePrefix,
                FileProvider = provider,
                ContentTypeProvider = contentTypes,
                ServeUnknownFileTypes = false,
                OnPrepareResponse = response =>
                {
                    foreach ((string name, string value) in policy.Headers)
                    {
                        response.Context.Response.Headers[name] = value;
                    }
                }
            });
            branch.Run(context =>
            {
                Reject(context, StatusCodes.Status404NotFound);
                return Task.CompletedTask;
            });
        });
        return app;
    }

    private static void Reject(HttpContext context, int status)
    {
        context.Response.StatusCode = status;
        context.Response.ContentLength = 0;
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers["Cross-Origin-Resource-Policy"] = "same-origin";
        context.Response.Headers["X-Content-Type-Options"] = "nosniff";
        context.Response.Headers["Accept-Ranges"] = "none";
    }
}
