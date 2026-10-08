namespace FsusBlog.Shared.Contracts.BlockLinks;

/// <summary>Uses the existing canonical length-prefixed digest owner; seals are not authorization.</summary>
public static class BlockTargetQueryDigest
{
    public static string ComputeRequest(BlockTargetQueryRequest request)
        => BlockAnchorContractDigest.Compute(writer =>
        {
            writer.Add(request.Schema);
            writer.Add(request.SchemaVersion);
            BlockTargetQueryCoordinate coordinate = request.Coordinate;
            writer.Add(coordinate.ActorIdentity);
            writer.Add(coordinate.SiteIdentity);
            writer.Add(coordinate.PermissionContextDigest);
            AddLong(writer, coordinate.PermissionRevision);
            AddLong(writer, coordinate.QueryRevision);
            AddLong(writer, coordinate.IndexRevision);
            AddLong(writer, coordinate.RouteRevision);
            writer.Add(coordinate.AnchorContractVersion);
            writer.Add(coordinate.AnchorContractDigest);
            writer.Add((int)request.Layer);
            writer.Add((int)request.Scope);
            AddArticle(writer, request.Article);
            writer.Add(request.Search);
            writer.Add(request.Limit);
            AddLong(writer, request.RequestSequence);
        });

    public static string ComputeCursor(BlockTargetQueryCursor cursor)
        => BlockAnchorContractDigest.Compute(writer =>
        {
            writer.Add(cursor.Schema);
            writer.Add(cursor.SchemaVersion);
            writer.Add(cursor.RequestDigest);
            writer.Add(cursor.Continuation);
        });

    public static string ComputeToken(BlockTargetQueryToken token)
        => BlockAnchorContractDigest.Compute(writer =>
        {
            writer.Add(token.Schema);
            writer.Add(token.SchemaVersion);
            writer.Add(token.RequestDigest);
            writer.Add(BlockAnchorContractDigest.ComputeTarget(token.Target));
            AddArticle(writer, token.Article);
            writer.Add(token.SourceNodeIdentity);
            writer.Add(token.SourceStart);
            writer.Add(token.SourceEnd);
            writer.Add(token.BlockKind);
            writer.Add(token.ContextSnippet);
            writer.Add(token.CanonicalSlug);
        });

    public static string ComputePage(BlockTargetQueryPage page)
        => BlockAnchorContractDigest.Compute(writer =>
        {
            writer.Add(page.Schema);
            writer.Add(page.SchemaVersion);
            writer.Add(page.RequestDigest);
            writer.Add((int)page.Status);
            writer.Add((int)page.Diagnostic);
            writer.Add(page.Items.Count);
            foreach (BlockTargetQueryToken token in page.Items)
            {
                writer.Add(ComputeToken(token));
            }

            writer.Add(page.Next is null ? null : ComputeCursor(page.Next));
        });

    public static string ComputePage(BlockTargetArticleQueryPage page)
        => BlockAnchorContractDigest.Compute(writer =>
        {
            writer.Add(page.Schema);
            writer.Add(page.SchemaVersion);
            writer.Add(page.RequestDigest);
            writer.Add((int)page.Status);
            writer.Add(page.Items.Count);
            foreach (BlockTargetArticleQueryItem item in page.Items)
            {
                AddArticle(writer, item.Article);
                writer.Add(item.Title);
                AddLong(writer, item.UpdatedAtUnixMilliseconds);
            }

            writer.Add(page.Next is null ? null : ComputeCursor(page.Next));
        });

    public static string ComputePage(BlockTargetHeadingQueryPage page)
        => BlockAnchorContractDigest.Compute(writer =>
        {
            writer.Add(page.Schema);
            writer.Add(page.SchemaVersion);
            writer.Add(page.RequestDigest);
            writer.Add((int)page.Status);
            writer.Add((int)page.Diagnostic);
            writer.Add(page.Items.Count);
            foreach (BlockTargetHeadingQueryItem item in page.Items)
            {
                AddArticle(writer, item.Article);
                writer.Add(item.HeadingIdentity);
                writer.Add(item.SourceNodeIdentity);
                writer.Add(item.SourceStart);
                writer.Add(item.SourceEnd);
                writer.Add(item.DisplayText);
            }

            writer.Add(page.Next is null ? null : ComputeCursor(page.Next));
        });

    private static void AddArticle(
        BlockAnchorContractDigest.CanonicalWriter writer,
        BlockTargetArticleCoordinate? article)
    {
        writer.Add(article is null ? 0 : 1);
        if (article is null)
        {
            return;
        }

        writer.Add(article.ArticleIdentity);
        writer.Add(article.RevisionIdentity);
        AddLong(writer, article.RevisionNumber);
        writer.Add((int)article.RevisionKind);
        writer.Add((int)article.Lifecycle);
        writer.Add((int)article.Permission);
        writer.Add((int)article.EditPermission);
        writer.Add(article.ContentDigest);
        writer.Add(article.CanonicalSlug);
    }

    private static void AddLong(BlockAnchorContractDigest.CanonicalWriter writer, long value)
    {
        writer.Add(unchecked((int)(value >> 32)));
        writer.Add(unchecked((int)value));
    }
}
