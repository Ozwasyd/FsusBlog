using System.Runtime.Intrinsics;
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Configs;
using BenchmarkDotNet.Jobs;
using BenchmarkDotNet.Running;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;

BenchmarkRunner.Run<PodMappingBenchmarks>(
    ManualConfig.Create(DefaultConfig.Instance)
        .AddJob(Job.ShortRun));

[MemoryDiagnoser]
public class PodMappingBenchmarks
{
    private readonly string _title = "FsusBlog-Article-Title";
    private readonly string _summary = "High frequency mapping benchmark summary";
    private readonly string _snippet = "This snippet emulates a hot-path list projection.";
    private readonly string _content = new('x', 256);
    private readonly string _userName = "benchmark-user";

    private readonly ICacheManager _cacheManager;
    private readonly CorePageResult<ArticleListCoreModel> _pageResult;
    private readonly IAedsEncoder _aedsEncoder;
    private readonly AedsDecoderValidator _aedsValidator;

    public PodMappingBenchmarks()
    {
        var l1 = new FakeLevel1CacheStore();
        var l2 = new FakeLevel2CacheStore();
        _cacheManager = new CacheManager(l1, l2);
        _aedsEncoder = new AedsEncoder();
        _aedsValidator = new AedsDecoderValidator(_aedsEncoder);

        var pod = PodProjector.ProjectArticleList(1, 99, DateTime.UtcNow, 2, "分类", _title, _summary, _snippet, false, out _);
        _pageResult = new CorePageResult<ArticleListCoreModel>(
            [new ArticleListCoreModel(
                pod,
                1,
                _title,
                _summary,
                _snippet,
                99,
                DateTime.UtcNow,
                new ArticleCategoryCoreModel(2, "分类"),
                [new TagCoreModel(10, "tag-a")],
                false)],
            1);
    }

    [Benchmark(Baseline = true)]
    public int LegacyLike_StringOnly()
    {
        string t = _title;
        string s = _summary;
        string n = _snippet;
        return t.Length + s.Length + n.Length;
    }

    [Benchmark]
    public int ArticleList_PodProjection()
    {
        var pod = PodProjector.ProjectArticleList(1, 99, DateTime.UtcNow, 2, "分类", _title, _summary, _snippet, false, out var payload);
        return payload.Length + pod.GetHashCode();
    }

    [Benchmark]
    public int CommentItem_PodProjection()
    {
        var pod = PodProjector.ProjectCommentItem(1001, DateTime.UtcNow, _userName, _content, out var payload);
        return payload.Length + pod.GetHashCode();
    }

    [Benchmark]
    public int Stats_PodProjection()
    {
        var pod = PodProjector.ProjectSiteStats(100, 200, 10, 10000, 6000, 4000, 5, 5, 8);
        return pod.GetHashCode() + (Vector256.IsHardwareAccelerated ? 1 : 0);
    }

    [Benchmark]
    public async Task<int> CacheMiss_ArticlePage_PodBinary()
    {
        string key = "bench:miss:article:list";
        _ = await _cacheManager.RemoveAsync(key);
        var result = await _cacheManager.GetOrLoadAsync(
            key,
            PodBinaryCodec.TryDecodeArticlePage,
            PodBinaryCodec.EncodeArticlePage,
            _ => Task.FromResult(_pageResult),
            TimeSpan.FromMinutes(1));

        return result.Value.Items.Count;
    }

    [Benchmark]
    public async Task<int> CacheHit_ArticlePage_PodBinary()
    {
        string key = "bench:hit:article:list";
        _ = await _cacheManager.SetAsync(key, _pageResult, PodBinaryCodec.EncodeArticlePage, TimeSpan.FromMinutes(1));

        var result = await _cacheManager.TryGetAsync<CorePageResult<ArticleListCoreModel>>(key, PodBinaryCodec.TryDecodeArticlePage);
        return result.IsSuccess ? result.Value.Items.Count : 0;
    }

    [Benchmark]
    public int Aeds_Encode_ArticleList()
    {
        byte[] payload = PodBinaryCodec.EncodeArticlePage(_pageResult);
        byte[] frame = _aedsEncoder.Encode(AedsFrameType.ArticleList, payload);
        return frame.Length;
    }

    [Benchmark]
    public int Aeds_Decode_ArticleList()
    {
        byte[] payload = PodBinaryCodec.EncodeArticlePage(_pageResult);
        byte[] frame = _aedsEncoder.Encode(AedsFrameType.ArticleList, payload);
        var decoded = _aedsEncoder.TryDecode(frame);
        return decoded.IsSuccess ? decoded.Value.Payload.Length : 0;
    }

    [Benchmark]
    public int Aeds_RoundTrip_Validate()
    {
        byte[] payload = PodBinaryCodec.EncodeArticlePage(_pageResult);
        var result = _aedsValidator.ValidateRoundTrip(AedsFrameType.ArticleList, payload);
        return result.IsSuccess ? payload.Length : 0;
    }

    private sealed class FakeLevel1CacheStore : ILevel1CacheStore
    {
        private readonly Dictionary<string, byte[]> _cache = [];

        public bool TryGet(string key, out byte[] value) => _cache.TryGetValue(key, out value!);

        public void Set(string key, byte[] value, TimeSpan ttl)
        {
            _ = ttl;
            _cache[key] = value;
        }

        public void Remove(string key)
        {
            _cache.Remove(key);
        }
    }

    private sealed class FakeLevel2CacheStore : ILevel2CacheStore
    {
        private readonly Dictionary<string, byte[]> _cache = [];

        public Task<byte[]?> GetAsync(string key, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _cache.TryGetValue(key, out byte[]? value);
            return Task.FromResult(value);
        }

        public Task SetAsync(string key, byte[] value, TimeSpan ttl, CancellationToken cancellationToken = default)
        {
            _ = ttl;
            cancellationToken.ThrowIfCancellationRequested();
            _cache[key] = value;
            return Task.CompletedTask;
        }

        public Task RemoveAsync(string key, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _cache.Remove(key);
            return Task.CompletedTask;
        }
    }
}
