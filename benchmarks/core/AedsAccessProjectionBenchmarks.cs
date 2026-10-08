using BenchmarkDotNet.Attributes;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;

namespace FsusBlog.Core.Benchmarks;

[MemoryDiagnoser]
public class AedsAccessProjectionBenchmarks
{
    private byte[] _payload = [];

    [Params(5, 20, 100)]
    public int PageSize
    {
        get; set;
    }

    [Params(1, 8)]
    public int TagsPerArticle
    {
        get; set;
    }

    [GlobalSetup]
    public void Setup()
    {
        DateTime created = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var items = Enumerable.Range(1, PageSize).Select(index =>
        {
            string title = $"AEDS projection benchmark title {index}";
            string summary = $"AEDS projection benchmark summary {index} with fixed UTF-8 中文";
            var pod = PodProjector.ProjectArticleList(
                index, index * 17, created.AddMinutes(index), 7, "Protocol", title, summary, false, out _);
            return new ArticleListCoreModel(
                pod,
                index,
                title,
                summary,
                null,
                null,
                index * 17,
                created.AddMinutes(index),
                new ArticleCategoryCoreModel(7, "Protocol"),
                Enumerable.Range(1, TagsPerArticle)
                    .Select(tag => new TagCoreModel(tag, $"tag-{tag}"))
                    .ToArray(),
                false,
                2,
                null,
                created,
                index * 10L,
                3,
                index * 20L,
                2);
        }).ToArray();
        byte[] current = PodBinaryCodec.EncodeArticlePage(
            new CorePageResult<ArticleListCoreModel>(items, items.Length));
        _payload = current;

        if (!PodBinaryCodec.TryDecodeArticlePage(_payload, out var canonical)
            || !PodBinaryCodec.TryDecodePublicArticleListCardProjection(_payload, out var projection)
            || CorrectnessDigest(canonical.Items.Select(static item =>
                (item.Id, item.Title, item.Summary ?? string.Empty, item.Category.Name)))
                != CorrectnessDigest(projection.Items.Select(static item =>
                    (item.Id, item.Title, item.Summary, item.CategoryName))))
        {
            throw new InvalidOperationException("AEDS access projection benchmark fixture parity failed.");
        }
    }

    [Benchmark(Baseline = true)]
    public object CanonicalFullDecode()
    {
        _ = PodBinaryCodec.TryDecodeArticlePage(_payload, out var page);
        return page;
    }

    [Benchmark]
    public object ProjectionDecode()
    {
        _ = PodBinaryCodec.TryDecodePublicArticleListCardProjection(_payload, out var page);
        return page;
    }

    [Benchmark]
    public int CanonicalDecodeAndViewDigest()
    {
        _ = PodBinaryCodec.TryDecodeArticlePage(_payload, out var page);
        return CorrectnessDigest(page.Items.Select(static item =>
            (item.Id, item.Title, item.Summary ?? string.Empty, item.Category.Name)));
    }

    private static int CorrectnessDigest(IEnumerable<(int Id, string Title, string Summary, string Category)> items)
    {
        var hash = new HashCode();
        foreach (var item in items)
        {
            hash.Add(item.Id);
            hash.Add(item.Title, StringComparer.Ordinal);
            hash.Add(item.Summary, StringComparer.Ordinal);
            hash.Add(item.Category, StringComparer.Ordinal);
        }
        return hash.ToHashCode();
    }

}
