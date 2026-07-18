using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Interfaces;

public interface ISearchIndexService
{
    Task BuildIndexAsync(List<Article> articles);
    Task<List<Article>> SearchAsync(string keyword);
    Task AddOrUpdateIndexAsync(Article article);
    Task DeleteIndexAsync(int id);
}
