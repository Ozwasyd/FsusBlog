namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    internal static void Validate(PublicSearchResult value)
    {
        Check(value.Generation >= 0, "Invalid public search generation.");
        Check(value.ProfileVersion > 0, "Invalid public search profile version.");
        Check(value.AnalyzerVersion > 0, "Invalid public search analyzer version.");
        Check(value.TotalCount >= 0, "Invalid public search total count.");
        Check(value.PrimaryCount >= 0 && value.RelaxedCount >= 0, "Invalid public search tier counts.");
        Check(value.HasMore == (value.NextCursor.Length > 0), "Public search continuation cursor disagrees with hasMore.");
        if (value.NextCursor.Length > 0)
            Check(IsBase64Url(value.NextCursor), "Invalid public search cursor encoding.");
        Check(value.TotalCount >= value.Items.Count, "Public search total count is smaller than returned page.");
        if (value.TotalRelation == PublicSearchTotalRelation.Exact)
        {
            Check(checked(value.PrimaryCount + value.RelaxedCount) == value.TotalCount,
                "Exact public search total count must equal primaryCount + relaxedCount.");
        }
        else
        {
            Check(checked(value.PrimaryCount + value.RelaxedCount) <= value.TotalCount,
                "Public search tier counts exceed lower-bound total.");
        }

        foreach (var item in value.Items)
            ValidatePublicSearchHit(item);
    }

    private static void ValidatePublicSearchHit(PublicSearchHit item)
    {
        Check(item.Id > 0 && item.Revision > 0 && item.RevisionNo > 0 &&
              item.Publication > 0 && item.PublicationNo > 0, "Invalid public search hit coordinates.");
        Check(item.Views >= 0, "Invalid public search hit view count.");
        Check(IsValidUnixMs(item.PublishedAtUnixMs) && IsValidUnixMs(item.CreatedAtUnixMs),
            "Invalid public search hit timestamps.");
        Check(item.CategoryId >= 0 && (item.CategoryId == 0) == (item.CategoryName.Length == 0),
            "Invalid public search hit category.");
        var seenTags = item.Tags.Count > 1 ? new HashSet<int>(item.Tags.Count) : null;
        foreach (var tag in item.Tags)
        {
            Check(tag.Id > 0 && tag.Name.Length > 0, "Invalid public search hit tag.");
            if (seenTags is not null) Check(seenTags.Add(tag.Id), "Duplicate public search hit tag.");
        }
        Check(item.Title.Length > 0, "Invalid public search hit title.");
        if (item.SnippetField == PublicSearchSnippetField.None)
        {
            Check(item.Snippet.Length == 0 && item.Highlights.Count == 0,
                "Public search hit with SnippetField.None must not carry snippet or highlights.");
        }
        else
        {
            ValidateSnippetHighlights(item.Snippet, item.Highlights);
        }
    }

    public static void ValidateSnippetHighlights(string snippet, IReadOnlyList<PublicSearchHighlight> highlights)
    {
        var previousEnd = 0;
        for (var i = 0; i < highlights.Count; i++)
        {
            var h = highlights[i];
            Check(h.Start >= previousEnd && h.End > h.Start && h.End <= snippet.Length,
                "Invalid or overlapping public search highlight range.");
            Check(!char.IsLowSurrogate(snippet[h.Start]) && !char.IsHighSurrogate(snippet[h.End - 1]),
                "Public search highlight range splits a UTF-16 surrogate pair.");
            previousEnd = h.End;
        }
    }
}
