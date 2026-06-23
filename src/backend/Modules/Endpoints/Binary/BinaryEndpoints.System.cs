using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;
using System.Buffers;
using System.Data.Common;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private static void MapBinarySystemEndpoints(IEndpointRouteBuilder group)
    {
        group.MapGet("/system/seo", static async Task<BinaryFrameResult> (
            ISystemService systemService,
            IAedsEncoder aeds) =>
        {
            var data = await systemService.GetSeoConfigAsync();
            var dto = SystemProjection.ToPublicDto(data);
            return BinaryResults.Frame(aeds, AedsFrameType.SeoConfig, writer => PodBinaryCodec.WriteSeoConfig(dto, writer));
        })
        .AllowAnonymous()
        .CacheOutput(HttpCachePolicyCatalog.ApplySystemSeo);

        group.MapGet("/system/admin/seo", static async Task<BinaryFrameResult> (
            ISystemService systemService,
            IAedsEncoder aeds) =>
        {
            var data = await systemService.GetSeoConfigAsync();
            var dto = SystemProjection.ToAdminDto(data);
            return BinaryResults.Frame(aeds, AedsFrameType.SeoConfig, writer => PodBinaryCodec.WriteSeoConfig(dto, writer));
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig);

        group.MapPut("/system/seo", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            ISystemService systemService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.SeoConfigUpdateRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeSeoConfig(payload.Payload, out var dto))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "SEO 配置请求体非法"), aeds);
            }

            await systemService.UpdateSeoConfigAsync(new UpdateSeoConfigRequest
            {
                Title = dto.Title,
                Description = dto.Description,
                Keywords = dto.Keywords,
                Author = dto.Author,
                OgImage = dto.OgImage,
                BaseUrl = dto.BaseUrl,
                FaviconSvgUrl = dto.FaviconSvgUrl,
                FaviconIcoUrl = dto.FaviconIcoUrl,
                FaviconPngUrl = dto.FaviconPngUrl,
                AppleTouchIconUrl = dto.AppleTouchIconUrl,
                ManifestName = dto.ManifestName,
                ManifestShortName = dto.ManifestShortName,
                PwaIcon192Url = dto.PwaIcon192Url,
                PwaIcon512Url = dto.PwaIcon512Url,
                PwaMaskableIconUrl = dto.PwaMaskableIconUrl,
                ThemeColor = dto.ThemeColor,
                BackgroundColor = dto.BackgroundColor,
                SiteLogoUrl = dto.SiteLogoUrl,
                SiteLogoDarkUrl = dto.SiteLogoDarkUrl,
                SiteWordmarkUrl = dto.SiteWordmarkUrl,
                AdminLogoUrl = dto.AdminLogoUrl,
                AdminCollapsedIconUrl = dto.AdminCollapsedIconUrl,
                LoginLogoUrl = dto.LoginLogoUrl,
                LoginIconUrl = dto.LoginIconUrl
            });
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapGet("/system/compliance", static async Task<BinaryFrameResult> (
            ISystemService systemService,
            IAedsEncoder aeds) =>
        {
            var data = await systemService.GetSiteComplianceConfigAsync();
            var dto = SystemProjection.ToPublicDto(data);
            return BinaryResults.Frame(aeds, AedsFrameType.SiteComplianceConfig, writer => PodBinaryCodec.WriteSiteComplianceConfig(dto, writer));
        })
        .AllowAnonymous()
        .CacheOutput(HttpCachePolicyCatalog.ApplySystemCompliance);

        group.MapGet("/system/admin/compliance", static async Task<BinaryFrameResult> (
            ISystemService systemService,
            IAedsEncoder aeds) =>
        {
            var data = await systemService.GetSiteComplianceConfigAsync();
            var dto = SystemProjection.ToAdminDto(data);
            return BinaryResults.Frame(aeds, AedsFrameType.SiteComplianceConfig, writer => PodBinaryCodec.WriteSiteComplianceConfig(dto, writer));
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig);

        group.MapPut("/system/compliance", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            ISystemService systemService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.SiteComplianceConfigUpdateRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeSiteComplianceConfig(payload.Payload, out var dto))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "合规配置请求体非法"), aeds);
            }

            await systemService.UpdateSiteComplianceConfigAsync(new UpdateSiteComplianceConfigRequest
            {
                Enabled = dto.Enabled,
                RegionMode = dto.RegionMode,
                CopyrightOwner = dto.CopyrightOwner,
                CopyrightStartYear = dto.CopyrightStartYear,
                CopyrightText = dto.CopyrightText,
                ContentLicenseName = dto.ContentLicenseName,
                ContentLicenseUrl = dto.ContentLicenseUrl,
                IcpRecordNumber = dto.IcpRecordNumber,
                IcpRecordUrl = dto.IcpRecordUrl,
                PoliceRecordNumber = dto.PoliceRecordNumber,
                PoliceRecordUrl = dto.PoliceRecordUrl,
                PoliceBadgeIconUrl = dto.PoliceBadgeIconUrl,
                OperatorName = dto.OperatorName,
                ContactEmail = dto.ContactEmail
            });
            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapGet("/system/page/{slug}", static async Task<BinaryFrameResult> (
            string slug,
            ISystemService systemService,
            IAedsEncoder aeds,
            ILoggerFactory loggerFactory) =>
        {
            var slugSpan = slug.AsSpan();
            if (slugSpan.IsEmpty ||
                !FastCharValidator.IsAlphaNumericHyphen(slugSpan) ||
                !AllowedPageSlugs.Contains(slug))
            {
                var logger = loggerFactory.CreateLogger("BinarySystemEndpoints");
                logger.LogWarning("拦截到非法的二进制页面请求 Slug: {Slug}", slug);
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "请求的页面不存在"), aeds);
            }

            var data = await systemService.GetPageContentAsync(slug);
            var dto = SystemProjection.ToPublicDto(data);
            return BinaryResults.Frame(aeds, AedsFrameType.PageContent, writer => PodBinaryCodec.WritePageContent(dto, writer));
        })
        .AllowAnonymous()
        .CacheOutput(HttpCachePolicyCatalog.ApplySystemPage);

        group.MapGet("/system/admin/page/{slug}", static async Task<BinaryFrameResult> (
            string slug,
            ISystemService systemService,
            IAedsEncoder aeds,
            ILoggerFactory loggerFactory) =>
        {
            var slugSpan = slug.AsSpan();
            if (slugSpan.IsEmpty ||
                !FastCharValidator.IsAlphaNumericHyphen(slugSpan) ||
                !AllowedPageSlugs.Contains(slug))
            {
                var logger = loggerFactory.CreateLogger("BinarySystemEndpoints");
                logger.LogWarning("拦截到非法的管理页面请求 Slug: {Slug}", slug);
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "请求的页面不存在"), aeds);
            }

            var data = await systemService.GetPageContentAsync(slug);
            if (data is null)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "页面不存在"), aeds);
            }

            var dto = SystemProjection.ToPublicDto(data);
            return BinaryResults.Frame(aeds, AedsFrameType.PageContent, writer => PodBinaryCodec.WritePageContent(dto, writer));
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig);

        group.MapPut("/system/page", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            ISystemService systemService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.PageContentUpdateRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodePageContent(payload.Payload, out var dto))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "页面内容请求体非法"), aeds);
            }

            var slugSpan = (dto.Slug ?? string.Empty).AsSpan();
            if (slugSpan.IsEmpty ||
                !FastCharValidator.IsAlphaNumericHyphen(slugSpan) ||
                !AllowedPageSlugs.Contains(dto.Slug ?? string.Empty))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "页面标识 (Slug) 不在可管理静态页范围内"), aeds);
            }

            bool success = await systemService.UpdatePageContentAsync(new UpdatePageContentRequest
            {
                Slug = dto.Slug,
                Content = dto.Content
            });
            if (!success)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "页面更新失败：数据库操作异常"), aeds);
            }

            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapPost("/system/page/refresh/{slug}", static async Task<BinaryFrameResult> (
            string slug,
            ISystemService systemService,
            IAedsEncoder aeds) =>
        {
            var slugSpan = slug.AsSpan();
            if (slugSpan.IsEmpty ||
                !FastCharValidator.IsAlphaNumericHyphen(slugSpan) ||
                !AllowedPageSlugs.Contains(slug))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "页面标识 (Slug) 不在可管理静态页范围内"), aeds);
            }

            bool success = await systemService.RefreshPageCacheAsync(slug);
            if (!success)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "页面缓存刷新失败"), aeds);
            }

            return BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .AddEndpointFilter<RequiresPowFilter>();
    }
}
