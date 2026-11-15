namespace FsusBlog.V2.Contracts;

public sealed record AdminTaxonomyItem(int Id, string Name, int Published, int Drafts, int Scheduled, int Retracted, int Deleted,
    int RetainedArticles);
public sealed record AdminTaxonomyPage(int NextId, IReadOnlyList<AdminTaxonomyItem> Items);
public sealed record AdminTaxonomyDependencies(int Id, int ActiveArticles, int RetainedOnlyArticles, int ReservedAliases);

public static partial class Wire
{
    public static byte[] EncodeAdminTaxonomyDependencies(AdminTaxonomyDependencies value)
    {
        if (value.Id <= 0 || value.ActiveArticles < 0 || value.RetainedOnlyArticles < 0 || value.ReservedAliases < 0)
            throw new ProtocolException("Invalid administrator taxonomy dependencies.");
        var writer = new Writer();
        writer.I32(value.Id);
        writer.I32(value.ActiveArticles);
        writer.I32(value.RetainedOnlyArticles);
        writer.I32(value.ReservedAliases);
        return Aeds.Encode(FrameType.AdminTaxonomyDependencies, writer.Written);
    }

    public static byte[] EncodeAdminTaxonomyPage(AdminTaxonomyPage page)
    {
        if (page.Items.Count > WireLimits.AdminTaxonomyPageSize || page.NextId < 0 ||
            page.NextId > 0 && (page.Items.Count != WireLimits.AdminTaxonomyPageSize || page.Items[^1].Id != page.NextId))
            throw new ProtocolException("Invalid administrator taxonomy page.");

        var writer = new Writer();
        writer.I32(page.NextId);
        writer.I32(page.Items.Count);
        var previous = 0;
        foreach (var item in page.Items)
        {
            if (item.Id <= previous || string.IsNullOrEmpty(item.Name) || item.Published < 0 || item.Drafts < 0 || item.Scheduled < 0 ||
                item.Retracted < 0 || item.Deleted < 0 || item.RetainedArticles < item.Published ||
                item.RetainedArticles < (long)item.Drafts + item.Scheduled + item.Retracted + item.Deleted)
                throw new ProtocolException("Invalid administrator taxonomy item.");
            writer.I32(item.Id);
            writer.Text(item.Name, WireLimits.TaxonomyNameBytes);
            writer.I32(item.Published);
            writer.I32(item.Drafts);
            writer.I32(item.Scheduled);
            writer.I32(item.Retracted);
            writer.I32(item.Deleted);
            writer.I32(item.RetainedArticles);
            previous = item.Id;
        }
        return Aeds.Encode(FrameType.AdminTaxonomyPage, writer.Written);
    }
}
