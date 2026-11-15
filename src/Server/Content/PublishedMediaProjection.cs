using System.Collections.Frozen;
using System.Globalization;
using FsusBlog.V2.Contracts;
using Npgsql;

namespace FsusBlog.V2.Server.Content;

internal sealed class PublishedMediaProjection(FrozenDictionary<int, PublicArticleMedia> articles)
{
    internal IReadOnlyList<PublishedArticleImage> Images(int article, long publication) =>
        articles.TryGetValue(article, out var manifest) && manifest.Publication == publication ? manifest.Images : [];

    internal bool HasImages(int article) => articles.ContainsKey(article);

    internal static async Task<PublishedMediaProjection> Read(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var query = Store.Sql(db, tx, """
            SELECT m.article_id,m.publication_id,m.ordinal,m.content_hash,m.format,m.length,m.width,m.height
            FROM public.article_publication_media m
            JOIN public.article_publication p USING (article_id,publication_id,revision)
            JOIN public.article a ON a.id=p.article_id AND a.published_revision=p.revision AND NOT a.deleted
            ORDER BY m.article_id,m.ordinal
            """);
        await using var rows = await query.ExecuteReaderAsync(ct);
        var manifests = new Dictionary<int, PublicArticleMedia>();
        List<PublishedArticleImage> images = [];
        var article = 0;
        var publication = 0L;
        var total = 0L;
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
            }
            var image = new PublishedArticleImage(Convert.ToHexStringLower(rows.GetFieldValue<byte[]>(3)), rows.GetInt16(4),
                rows.GetInt32(5), rows.GetInt32(6), rows.GetInt32(7));
            if (nextPublication != publication || rows.GetInt32(2) != images.Count + 1 ||
                images.Count == ArticlePublishImages.Maximum || !image.Valid() || (total += image.Length) > 40 * 1024 * 1024)
                throw new InvalidOperationException("The current publication media metadata is inconsistent.");
            images.Add(image);
        }
        AddArticle();
        return new PublishedMediaProjection(manifests.ToFrozenDictionary());

        void AddArticle()
        {
            if (images.Count != 0) manifests.Add(article, new PublicArticleMedia(article, publication, images.ToArray()));
        }
    }

    internal static string ImagePath(int article, long publication, string digest) => string.Create(CultureInfo.InvariantCulture,
        $"/public-media/{article}/{publication}/{digest}");
}
