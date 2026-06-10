using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Models.Requests;

namespace FsusBlog.Server.Interfaces;

public interface ISystemService
{
    /// <summary>
    /// 获取 SEO 配置（包含默认值填充逻辑）
    /// </summary>
    Task<SeoConfigReadModel> GetSeoConfigAsync();

    /// <summary>
    /// 更新 SEO 配置
    /// </summary>
    Task UpdateSeoConfigAsync(UpdateSeoConfigRequest request);

    /// <summary>
    /// 获取公开合规配置
    /// </summary>
    Task<SiteComplianceConfigReadModel> GetSiteComplianceConfigAsync();

    /// <summary>
    /// 更新公开合规配置
    /// </summary>
    Task UpdateSiteComplianceConfigAsync(UpdateSiteComplianceConfigRequest request);

    /// <summary>
    /// 获取页面
    /// </summary>
    Task<PageContentReadModel> GetPageContentAsync(string slug);
    /// <summary>
    /// 更新页面
    /// </summary>
    Task<bool> UpdatePageContentAsync(UpdatePageContentRequest request);

    /// <summary>
    /// 强制刷新页面缓存
    /// </summary>
    Task<bool> RefreshPageCacheAsync(string slug);
}
