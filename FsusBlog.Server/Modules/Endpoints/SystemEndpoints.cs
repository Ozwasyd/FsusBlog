using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Http.HttpResults;

namespace FsusBlog.Server.Modules.Endpoints;

public static class SystemEndpoints
{
    private static readonly HashSet<string> _allowedPageSlugs = new(StringComparer.OrdinalIgnoreCase)
    {
        "about", "privacy", "guidelines"
    };

    public static void MapSystemEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("api/System").WithTags("System");

        group.MapGet("/seo", static async (ISystemService systemService) =>
        {
            var data = await systemService.GetSeoConfigAsync();
            return ApiResults.Ok(SystemProjection.ToPublicDto(data));
        })
        .AllowAnonymous()
        .CacheOutput(HttpCachePolicyCatalog.ApplySystemSeo);

        group.MapGet("/page/{slug}", static async Task<Results<Ok<ApiResponse<PageContentPublicDto>>, NotFound<ApiResponse>>> (
             string slug,
             ISystemService systemService,
             ILoggerFactory loggerFactory) =>
        {
            var slugSpan = slug.AsSpan();
            if (slugSpan.IsEmpty ||
                !FastCharValidator.IsAlphaNumericHyphen(slugSpan) ||
                !_allowedPageSlugs.Contains(slug))
            {
                var logger = loggerFactory.CreateLogger("SystemEndpoints");
                logger.LogWarning("拦截到非法的页面请求 Slug: {Slug}", slug);
                return ApiResults.NotFound("请求的页面不存在");
            }

            var data = await systemService.GetPageContentAsync(slug);
            return ApiResults.Ok(SystemProjection.ToPublicDto(data));
        })
         .AllowAnonymous()
         .CacheOutput(HttpCachePolicyCatalog.ApplySystemPage);
    }
}
