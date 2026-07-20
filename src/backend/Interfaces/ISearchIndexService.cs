using FsusBlog.Server.Entities;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Interfaces;

public interface ISearchIndexService
{
    Task BuildIndexAsync(List<Article> articles);
    Task<List<Article>> SearchAsync(string keyword);
    Task AddOrUpdateIndexAsync(Article article);
    Task AddOrUpdateVersionedIndexAsync(
        Article article,
        ArticleMutationVersionReference version,
        CancellationToken cancellationToken = default);
    Task DeleteIndexAsync(int id);
}
