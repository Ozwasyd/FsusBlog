using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Interfaces;

public interface ISystemService
{
    /// <summary>
    /// 获取 SEO 配置（包含默认值填充逻辑）
    /// </summary>
    Task<SeoConfigDto> GetSeoConfigAsync();

    /// <summary>
    /// 更新 SEO 配置
    /// </summary>
    Task UpdateSeoConfigAsync(SeoConfigDto dto);

    /// <summary>
    /// 获取页面
    /// </summary>
    Task<PageContentDto> GetPageContentAsync(string slug);
    /// <summary>
    /// 更新页面
    /// </summary>
    Task<bool> UpdatePageContentAsync(PageContentDto dto);

    /// <summary>
    /// 强制刷新页面缓存
    /// </summary>
    Task<bool> RefreshPageCacheAsync(string slug);
}
