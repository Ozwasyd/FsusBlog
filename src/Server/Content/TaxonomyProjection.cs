using System.Collections.Frozen;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core.Content;

namespace FsusBlog.V2.Server.Content;

internal readonly record struct TaxonomyPage(byte[] Wire, byte[] Html, int ArticleCount);

internal sealed class TaxonomyProjection
{
    private readonly FrozenDictionary<int, TaxonomyPage> _categories;
    private readonly FrozenDictionary<int, TaxonomyPage> _tags;
    private readonly FrozenDictionary<string, int> _tagIds;

    internal byte[] Categories { get; }
    internal byte[] Tags { get; }

    internal TaxonomyProjection(TaxonomyRows rows, IReadOnlyList<Article> articles, WebPages pages)
    {
        var categoryMembers = articles.Where(item => item.Category is not null).ToLookup(item => item.Category!.Id);
        var tagMembers = articles.SelectMany(article => (article.Tags ?? []).Select(tag => (tag.Id, Article: article)))
            .ToLookup(item => item.Id, item => item.Article);
        _categories = Project(rows.Categories, categoryMembers, pages, "category");
        _tags = Project(rows.Tags, tagMembers, pages, "tag");
        _tagIds = rows.Tags.Select(tag => (NameKey: TaxonomyNames.TagLookupKey(tag.Name), TagId: tag.Id))
            .Concat(rows.Aliases.Select(alias => (NameKey: (string?)alias.NameKey, alias.TagId)))
            .Where(item => item.NameKey is not null)
            .GroupBy(item => item.NameKey!, StringComparer.Ordinal)
            .Where(group => group.Select(item => item.TagId).Distinct().Take(2).Count() == 1)
            .ToFrozenDictionary(group => group.Key, group => group.First().TagId, StringComparer.Ordinal);
        Categories = TaxonomyWire.EncodeList(FrameType.CategoryList, Summarize(rows.Categories, categoryMembers));
        Tags = TaxonomyWire.EncodeList(FrameType.TagList, Summarize(rows.Tags, tagMembers));
    }

    internal TaxonomyPage? ById(bool tag, int id) =>
        (tag ? _tags : _categories).TryGetValue(id, out var value) ? value : null;

    internal int? TagByName(string? name) => TaxonomyNames.TagLookupKey(name) is { } key &&
        _tagIds.TryGetValue(key, out var id) ? id : null;

    internal static void AppendGeneration(IncrementalHash hash, Article article)
    {
        if (article.Category is { } category)
            AppendName(hash, 'C', category);
        foreach (var tag in article.Tags ?? [])
            AppendName(hash, 'T', tag);
    }

    private static void AppendName(IncrementalHash hash, char kind, TaxonomyName item)
    {
        var identity = string.Create(CultureInfo.InvariantCulture, $"{kind}{item.Id}:{item.Name.Length}:{item.Name}");
        hash.AppendData(Encoding.UTF8.GetBytes(identity));
    }

    private static TaxonomyListItem[] Summarize(IReadOnlyList<TaxonomyMetadata> items, ILookup<int, Article> members) =>
        items.Select(item => new TaxonomyListItem(item.Id, item.Name, members[item.Id].Count())).ToArray();

    private static FrozenDictionary<int, TaxonomyPage> Project(IReadOnlyList<TaxonomyMetadata> items,
        ILookup<int, Article> members, WebPages pages, string prefix) => items.ToFrozenDictionary(item => item.Id, item =>
        {
            var name = HtmlEncoder.Default.Encode(item.Name);
            var description = item.Description is null ? "" : $"<p>{HtmlEncoder.Default.Encode(item.Description)}</p>";
            var links = string.Concat(members[item.Id].OrderByDescending(article => article.CreatedAt)
                .ThenByDescending(article => article.Id).Take(10).Select(article =>
                    $"<li><article><h2><a href=\"/article/{article.Id.ToString(CultureInfo.InvariantCulture)}\">{HtmlEncoder.Default.Encode(article.Title)}</a></h2></article></li>"));
            var html = $"<section class=\"reading-column editorial-page\"><h1 class=\"editorial-rule\">{name}</h1>{description}{(links.Length == 0 ? "<p>暂无文章</p>" : $"<ol class=\"article-list\">{links}</ol>")}</section>";
            var path = $"/{prefix}/{DistributionSettings.Number(item.Id)}";
            return new TaxonomyPage(TaxonomyWire.EncodeMetadata(item),
                pages.PublicPage(html, item.Name, description: item.Description, publicPath: path), members[item.Id].Count());
        });
}
