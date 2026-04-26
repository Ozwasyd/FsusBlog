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

    public static PageContentPublicDto ToPublicDto(PageContentReadModel model)
        => new() { Slug = model.Slug, Content = model.Content };

    public static PageContentAdminDto ToAdminDto(PageContentReadModel model)
        => new() { Slug = model.Slug, Content = model.Content };

    public static PageContentContract ToContract(PageContentReadModel model)
        => new(model.Slug, model.Content);
}
