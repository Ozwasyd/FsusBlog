namespace FsusBlog.V2.Server.Content;

internal sealed record PublishedArticleImages(long Publication, IReadOnlyList<PublishedArticleImage> Images, string? CoverDigest);

internal sealed class PublishedMediaProjection(FrozenDictionary<int, PublishedArticleImages> articles)
{
    internal IReadOnlyList<PublishedArticleImage> Images(int article, long publication) =>
        articles.TryGetValue(article, out var manifest) && manifest.Publication == publication ? manifest.Images : [];

    internal string? CoverDigest(int article, long publication) =>
        articles.TryGetValue(article, out var manifest) && manifest.Publication == publication ? manifest.CoverDigest : null;

    internal bool HasImages(int article) => articles.ContainsKey(article);

    internal static async Task<PublishedMediaProjection> Read(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        var hasCover = await CurrentSchema.HasPublicationCoverAsync(db, tx, ct);
        var cover = hasCover ? "c.asset_id is not null" : "false";
        await using var query = Store.Sql(db, tx, $"""
            SELECT m.article_id,m.publication_id,m.ordinal,m.content_hash,m.format,m.length,m.width,m.height,{cover}
            FROM public.article_publication_media m
            {PublishedMediaStore.CoverJoin(hasCover)}
            JOIN public.article_publication p ON (p.article_id,p.publication_id,p.revision)=(m.article_id,m.publication_id,m.revision)
            JOIN public.article a ON a.id=p.article_id AND a.published_revision=p.revision AND NOT a.deleted
            ORDER BY m.article_id,m.ordinal
            """);
        await using var rows = await query.ExecuteReaderAsync(ct);
        var manifests = new Dictionary<int, PublishedArticleImages>();
        List<PublishedArticleImage> images = [];
        var article = 0;
        var publication = 0L;
        var total = 0L;
        string? coverDigest = null;
        while (await rows.ReadAsync(ct))
        {
            var nextArticle = rows.GetInt32(0);
            var nextPublication = rows.GetInt64(1);
            if (nextArticle != article)
            {
                AddArticle();
                article = nextArticle;
                publication = nextPublication;
                images = [];
                total = 0;
                coverDigest = null;
            }
            var image = new PublishedArticleImage(Convert.ToHexStringLower(rows.GetFieldValue<byte[]>(3)), rows.GetInt16(4),
                rows.GetInt32(5), rows.GetInt32(6), rows.GetInt32(7));
            if (nextPublication != publication || rows.GetInt32(2) != images.Count + 1 ||
                images.Count == ArticlePublishImages.Maximum || !image.Valid() || (total += image.Length) > 40 * 1024 * 1024)
                throw new InvalidOperationException("The current publication media metadata is inconsistent.");
            if (rows.GetBoolean(8))
            {
                if (coverDigest is not null) throw new InvalidOperationException("A publication has multiple covers.");
                coverDigest = image.Digest;
            }
            images.Add(image);
        }
        AddArticle();
        return new PublishedMediaProjection(manifests.ToFrozenDictionary());

        void AddArticle()
        {
            if (images.Count != 0) manifests.Add(article, new PublishedArticleImages(publication, images.ToArray(), coverDigest));
        }
    }

    internal static string ImagePath(int article, long publication, string digest) => PublishedArticleImage.FilePath(article, publication, digest);
}
