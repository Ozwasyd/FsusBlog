internal static class RenamedArticleTestCalls
{
    public static Task<Result> RestoreAsync(
        IArticleCoreGateway gateway,
        int id,
        CancellationToken cancellationToken = default)
        => gateway.RestoreAsync(new ArticleIdCommand(id), cancellationToken);
}
