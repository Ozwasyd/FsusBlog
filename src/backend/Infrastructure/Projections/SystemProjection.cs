using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Shared.Contracts.AuthSystem;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.Projections;

public static class SystemProjection
{
    public static SeoConfigPublicDto ToPublicDto(SeoConfigReadModel model)
        => new()
        {
            Title = model.Title,
            Description = model.Description,
            Keywords = model.Keywords,
            Author = model.Author,
            OgImage = model.OgImage,
            BaseUrl = model.BaseUrl
        };

    public static SeoConfigAdminDto ToAdminDto(SeoConfigReadModel model)
        => new()
        {
            Title = model.Title,
            Description = model.Description,
            Keywords = model.Keywords,
            Author = model.Author,
            OgImage = model.OgImage,
            BaseUrl = model.BaseUrl
        };

    public static SeoConfigContract ToContract(SeoConfigReadModel model)
        => new(model.Title, model.Description, model.Keywords, model.Author, model.OgImage, model.BaseUrl);

    public static SiteComplianceConfigPublicDto ToPublicDto(SiteComplianceConfigReadModel model)
        => new()
        {
            Enabled = model.Enabled,
            RegionMode = model.RegionMode,
            CopyrightOwner = model.CopyrightOwner,
            CopyrightStartYear = model.CopyrightStartYear,
            CopyrightText = model.CopyrightText,
            ContentLicenseName = model.ContentLicenseName,
            ContentLicenseUrl = model.ContentLicenseUrl,
            IcpRecordNumber = model.IcpRecordNumber,
            IcpRecordUrl = model.IcpRecordUrl,
            PoliceRecordNumber = model.PoliceRecordNumber,
            PoliceRecordUrl = model.PoliceRecordUrl,
            PoliceBadgeIconUrl = model.PoliceBadgeIconUrl,
            OperatorName = model.OperatorName,
            ContactEmail = model.ContactEmail
        };

    public static SiteComplianceConfigAdminDto ToAdminDto(SiteComplianceConfigReadModel model)
        => new()
        {
            Enabled = model.Enabled,
            RegionMode = model.RegionMode,
            CopyrightOwner = model.CopyrightOwner,
            CopyrightStartYear = model.CopyrightStartYear,
            CopyrightText = model.CopyrightText,
            ContentLicenseName = model.ContentLicenseName,
            ContentLicenseUrl = model.ContentLicenseUrl,
            IcpRecordNumber = model.IcpRecordNumber,
            IcpRecordUrl = model.IcpRecordUrl,
            PoliceRecordNumber = model.PoliceRecordNumber,
            PoliceRecordUrl = model.PoliceRecordUrl,
            PoliceBadgeIconUrl = model.PoliceBadgeIconUrl,
            OperatorName = model.OperatorName,
            ContactEmail = model.ContactEmail
        };

    public static SiteComplianceConfigContract ToContract(SiteComplianceConfigReadModel model)
        => new(
            model.Enabled,
            model.RegionMode,
            model.CopyrightOwner,
            model.CopyrightStartYear,
            model.CopyrightText,
            model.ContentLicenseName,
            model.ContentLicenseUrl,
            model.IcpRecordNumber,
            model.IcpRecordUrl,
            model.PoliceRecordNumber,
            model.PoliceRecordUrl,
            model.PoliceBadgeIconUrl,
            model.OperatorName,
            model.ContactEmail);

    public static PageContentPublicDto ToPublicDto(PageContentReadModel model)
        => new() { Slug = model.Slug, Content = model.Content };

    public static PageContentAdminDto ToAdminDto(PageContentReadModel model)
        => new() { Slug = model.Slug, Content = model.Content };

    public static PageContentContract ToContract(PageContentReadModel model)
        => new(model.Slug, model.Content);
}
