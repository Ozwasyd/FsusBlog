using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Content;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.V2.Integration.Tests;

public sealed class WideSearchCorpusEndpointTests
{
    private const string RawPageSha = "daa50289bca4130b4148236c0019bd62066846893a79606e2455a5cc867caa28";
    private const string ManifestSha = "78770fa36b448cbe37a48372457db1cd785f3cf47198eadd37b245746dc90a27";

    [Fact]
    public void WideManifestMatchesIndependentCanonicalVectorAndRejectsBrokenBinding()
    {
        var page = new WideSearchCorpusPage(1, 1, 42, 42, 0, 402, RawPageSha);
        var manifest = WideSearchCorpusWire.Seal(1, 402, [page]);
        Assert.Equal(ManifestSha, manifest.ContentDigest);
        var expected = Convert.FromHexString(
            "01000000110000000000000001000000010000009201000000000000" + ManifestSha +
            "01000000010000002a0000002a000000000000000000000092010000" + RawPageSha);
        var response = WideSearchCorpusWire.Encode(17, manifest);
        Assert.Equal(expected, Aeds.Decode(response, FrameType.PublicSearchWideManifest).ToArray());
        Assert.Throws<ProtocolException>(() => WideSearchCorpusWire.Encode(-1, manifest));
        Assert.Throws<ProtocolException>(() => WideSearchCorpusWire.Encode(17, manifest with { ContentDigest = RawPageSha }));
        Assert.Throws<ProtocolException>(() => WideSearchCorpusWire.Seal(1, 402, [page with { Offset = 1 }]));
        Assert.Throws<ProtocolException>(() => WideSearchCorpusWire.Seal(2, 804, [page, page with { Number = 2, Offset = 402 }]));
        Assert.Throws<ProtocolException>(() => WideSearchCorpusWire.Seal(1, 402, [page with { Sha256 = RawPageSha.ToUpperInvariant() }]));
    }

    [Fact]
    public async Task APageReadBeforeWithdrawalCannotEmitBytesOrValidatorsAfterInvalidation()
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) return;
        var when = DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_002_345);
        var articles = new Article[]
        {
            new(42, 1, 100, 1, 1, "Withdrawn old title", "private after withdrawal", when, when, when)
        };
        using var stage = Assert.IsType<WideSearchCorpusStage>(WideSearchCorpusStage.Build(articles, 1, 65_536));
        var old = Snapshot(1, articles);
        var projection = new PublicProjection();
        projection.Replace(old);
        var pending = Assert.IsType<PublicProjectionState>(projection.Current);
        Assert.True(projection.TryAttach(pending, new(stage, WideSearchCorpusWire.Encode(old.Generation, stage.Manifest))));
        Assert.Same(old, projection.Current?.Source);

        var request = new DefaultHttpContext();
        using var body = new MemoryStream();
        request.Response.Body = body;
        request.Request.QueryString = QueryString.Create(new Dictionary<string, string?>
        {
            ["generation"] = old.GenerationHeader,
            ["digest"] = stage.Manifest.ContentDigest
        });
        request.Request.Headers.IfNoneMatch = $"\"{stage.Manifest.Pages[0].Sha256}\"";
        var buffered = await WideSearchCorpusEndpoints.ReadPage(request, "1", projection, null, NullLogger.Instance, CancellationToken.None);
        projection.Replace(null);
        projection.Replace(Snapshot(2, []));
        stage.Dispose();
        await stage.Closed.WaitAsync(TimeSpan.FromSeconds(5));

        await Assert.ThrowsAsync<PublicUnavailableException>(() => buffered.ExecuteAsync(request));
        Assert.False(request.Response.Headers.ContainsKey("ETag"));
        Assert.False(request.Response.Headers.ContainsKey(WireHeaders.SearchCorpusDigest));
        Assert.False(request.Response.Headers.ContainsKey(WireHeaders.SearchIndexGeneration));
        Assert.Equal("no-store", request.Response.Headers.CacheControl.ToString());
        Assert.Equal(0L, body.Length);
    }

    private static PublicSnapshot Snapshot(long watermark, IReadOnlyList<Article> articles) =>
        new(watermark, articles, new([], [], []), new WebPages(""), new PublicListCursor(TimeProvider.System), null,
            NullLogger.Instance, null, null, CancellationToken.None);
}
