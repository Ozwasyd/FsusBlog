internal static class RenamedArticleTestAdapter
{
    public static Task<Result> DeleteAsync(
        this IArticleCoreService service,
        int id,
        CancellationToken cancellationToken = default)
        => service.DeleteAsync(new ArticleIdCommand(id), cancellationToken);
}
