namespace FsusBlog.V2.Contracts;

public enum AuthorArticleState { Draft = 1, Scheduled, Published, Retracted, Deleted }

public sealed record AuthorArticleRow(int Id, long Revision, string Title, AuthorArticleState State, long ModifiedUnixMs,
    long ScheduledUnixMs, TaxonomyName? Category, IReadOnlyList<TaxonomyName> Tags);

public sealed record AuthorArticlePage(int Total, int NextId, IReadOnlyList<AuthorArticleRow> Items);

public static partial class Wire
{
    public static byte[] EncodeAuthorArticlePage(AuthorArticlePage page)
    {
        var writer = new Writer();
        writer.I32(page.Total);
        writer.I32(page.NextId);
        writer.I32(page.Items.Count);
        foreach (var row in page.Items)
        {
            writer.I32(row.Id);
            writer.I64(row.Revision);
            writer.Text(row.Title, WireLimits.TitleBytes);
            writer.I32((int)row.State);
            writer.I64(row.ModifiedUnixMs);
            writer.I64(row.ScheduledUnixMs);
            writer.I32(row.Category?.Id ?? 0);
            if (row.Category is { } category) writer.Text(category.Name, WireLimits.TaxonomyNameBytes);
            writer.I32(row.Tags.Count);
            foreach (var tag in row.Tags)
            {
                writer.I32(tag.Id);
                writer.Text(tag.Name, WireLimits.TaxonomyNameBytes);
            }
        }
        return Aeds.Encode(FrameType.AuthorArticlePage, writer.Written);
    }
}
