using FsusBlog.Core.Services.Articles;

Task ExecuteAsync(IArticleCoreService service, CancellationToken cancellationToken)
    => service.GetPageListAsync(
        new ArticlePageQuery(1, 10, null, null, false),
        cancellationToken);
