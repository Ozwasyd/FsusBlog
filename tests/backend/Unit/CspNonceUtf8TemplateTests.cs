using System.Buffers;
using System.Collections.Frozen;
using System.IO.Pipelines;
using System.Runtime.CompilerServices;
using System.Text;

using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Options;
namespace FsusBlog.Server.Tests.Unit;

public sealed class CspNonceUtf8TemplateTests
{
    [Fact]
    public void Compile_MultiSlotUtf8Boundary_PreservesCjkEmojiAndUsesOneNonce()
    {
        const string Html = "<!doctype html><html><head><title>中文🙂</title><style>.示例{color:red}</style></head><body>边界🚀<script>globalThis.ok='好';</script></body></html>";
        CspNonceUtf8Template template = Assert.IsType<CspNonceUtf8Template>(
            CspNonceUtf8Template.Compile(Html, "release:v1:digest-a"));

        const string Nonce = "Abc_123-safe";
        byte[] renderedBytes = Render(template, Encoding.UTF8.GetBytes(Nonce));
        string rendered = new UTF8Encoding(false, true).GetString(renderedBytes);

        Assert.Equal(3, template.SlotCount);
        Assert.Equal(template.GetRenderedLength(Nonce.Length), renderedBytes.Length);
        Assert.Equal(3, Count(rendered, $"nonce=\"{Nonce}\""));
        Assert.Contains("中文🙂", rendered, StringComparison.Ordinal);
        Assert.Contains("边界🚀", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(CspNonceUtf8Template.Placeholder, rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void Compile_PerRenderNonceIsUniqueWhileEverySlotMatches()
    {
        const string Html = "<html><head></head><body><script></script><style></style></body></html>";
        CspNonceUtf8Template template = Assert.IsType<CspNonceUtf8Template>(
            CspNonceUtf8Template.Compile(Html, "release:v1:digest-b"));

        string first = Encoding.UTF8.GetString(Render(template, "request_one"u8));
        string second = Encoding.UTF8.GetString(Render(template, "request_two"u8));

        Assert.Equal(template.SlotCount, Count(first, "nonce=\"request_one\""));
        Assert.Equal(template.SlotCount, Count(second, "nonce=\"request_two\""));
        Assert.DoesNotContain("request_one", second, StringComparison.Ordinal);
        Assert.NotEqual(first, second);
    }

    [Theory]
    [InlineData("<html><head><head></head></head></html>")]
    [InlineData("<html><head></head><script nonce=\"a\" nonce=\"b\"></script></html>")]
    [InlineData("<html><head></head><script data-x=\"a\" data-X=\"b\"></script></html>")]
    [InlineData("<html><head></head><script nonce=bad></script></html>")]
    [InlineData("<html><head><meta property=\"csp-nonce\" nonce=\"fixed\" /></head></html>")]
    [InlineData("<html><head></head><script /> </html>")]
    [InlineData("<html><head></head><script>unterminated</html>")]
    [InlineData("<html><head></head><script>%%FSUSBLOG_CSP_NONCE%%</script></html>")]
    public void Compile_MalformedOrAttackerControlledTemplate_FailsClosed(string html)
        => Assert.Throws<InvalidOperationException>(() => CspNonceUtf8Template.Compile(html, "malicious"));

    [Fact]
    public void Compile_QuotedTagBoundaryAndCommentedExecutableText_AreParsedWithoutFalseSlots()
    {
        const string Html = "<!-- > <script>ignored()</script> --><html><head data-probe=\">\"></head><body><script data-json=\"{&quot;x&quot;:&quot;>&quot;}\">real()</script></body></html>";
        CspNonceUtf8Template template = Assert.IsType<CspNonceUtf8Template>(
            CspNonceUtf8Template.Compile(Html, "boundary"));
        string rendered = Encoding.UTF8.GetString(Render(template, "boundary_nonce"u8));

        Assert.Equal(2, template.SlotCount);
        Assert.Contains("<!-- > <script>ignored()</script> -->", rendered, StringComparison.Ordinal);
        Assert.Equal(2, Count(rendered, "nonce=\"boundary_nonce\""));
    }

    [Fact]
    public void Compile_StaticInlineHashesAreGeneratedAndBoundToArtifactDigest()
    {
        const string Html = "<html><head><style>.a{color:red}</style></head><body><script>globalThis.a=1</script><script src=\"/app.js\"></script></body></html>";
        CspNonceUtf8Template template = Assert.IsType<CspNonceUtf8Template>(
            CspNonceUtf8Template.Compile(Html, "renderer:v2:frontend:v3:artifact-digest"));

        Assert.Equal("renderer:v2:frontend:v3:artifact-digest", template.ArtifactIdentity);
        Assert.Equal(64, template.TemplateDigest.Length);
        Assert.Equal(2, template.StaticInlineSha256Sources.Count);
        Assert.All(template.StaticInlineSha256Sources, value => Assert.Matches("^'sha256-[A-Za-z0-9+/=]+'$", value));
    }

    [Fact]
    public void ArtifactFactory_BindsTemplateToRendererFrontendAndFullContentDigest()
    {
        PublicAotHtmlArtifact first = PublicAotHtmlArtifactFactory.FromHtml(
            "<html><head></head><body><script>one()</script></body></html>",
            "renderer-v7",
            "frontend-v9");
        PublicAotHtmlArtifact second = PublicAotHtmlArtifactFactory.FromHtml(
            "<html><head></head><body><script>two()</script></body></html>",
            "renderer-v7",
            "frontend-v9");

        CspNonceUtf8Template firstTemplate = Assert.IsType<CspNonceUtf8Template>(first.CspNonceTemplate);
        CspNonceUtf8Template secondTemplate = Assert.IsType<CspNonceUtf8Template>(second.CspNonceTemplate);
        Assert.StartsWith("renderer-v7:frontend-v9:sha256:", firstTemplate.ArtifactIdentity, StringComparison.Ordinal);
        Assert.Equal(64, firstTemplate.ArtifactIdentity.Split(':')[^1].Length);
        Assert.NotEqual(firstTemplate.ArtifactIdentity, secondTemplate.ArtifactIdentity);
        Assert.NotEqual(firstTemplate.TemplateDigest, secondTemplate.TemplateDigest);
    }

    [Fact]
    public async Task ResponseWriter_PropagatesCancellationBeforeCommit()
    {
        CspNonceUtf8Template template = CreateLargeTemplate();
        var pipe = new Pipe();
        var writer = new CountingPipeWriter(pipe.Writer);
        DefaultHttpContext context = CreateContext(writer);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            CspNonceHtmlResponseWriter.WriteBodyAsync(context.Response, template, "cancel_nonce", cancellation.Token));

        Assert.Equal(0, writer.FlushCalls);
        await writer.CompleteAsync();
        await pipe.Reader.CompleteAsync();
    }

    [Fact]
    public async Task ResponseWriter_AwaitsRealPipeBackpressureAndCommitsOnce()
    {
        CspNonceUtf8Template template = CreateLargeTemplate();
        var pipe = new Pipe(new PipeOptions(pauseWriterThreshold: 1, resumeWriterThreshold: 1));
        var writer = new CountingPipeWriter(pipe.Writer);
        DefaultHttpContext context = CreateContext(writer);

        Task execution = CspNonceHtmlResponseWriter.WriteBodyAsync(
            context.Response,
            template,
            "backpressure_nonce",
            CancellationToken.None);
        await Task.Yield();
        Assert.False(execution.IsCompleted);

        ReadResult read = await pipe.Reader.ReadAsync();
        Assert.False(read.Buffer.IsEmpty);
        pipe.Reader.AdvanceTo(read.Buffer.End);
        await execution.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(1, writer.FlushCalls);
        Assert.True(writer.AdvanceCalls >= template.SlotCount + 1);
        await writer.CompleteAsync();
        await pipe.Reader.CompleteAsync();
    }

    [Fact]
    public async Task ResponseWriter_PropagatesCompletedReaderAsAbortedResponse()
    {
        CspNonceUtf8Template template = CreateLargeTemplate();
        var pipe = new Pipe();
        await pipe.Reader.CompleteAsync();
        var writer = new CountingPipeWriter(pipe.Writer);
        DefaultHttpContext context = CreateContext(writer);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            CspNonceHtmlResponseWriter.WriteBodyAsync(
                context.Response,
                template,
                "aborted_nonce",
                CancellationToken.None));

        Assert.Equal(1, writer.FlushCalls);
        await writer.CompleteAsync();
    }

    [Fact]
    public void SnapshotReplacement_ReleasesOldTemplateOwnershipAndAccountsResidentBudget()
    {
        WeakReference oldTemplate = CreateReplaceAndRelease();
        for (int i = 0; i < 3 && oldTemplate.IsAlive; i++)
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
        }

        Assert.False(oldTemplate.IsAlive);
    }

    [Fact]
    public void Store_RejectsSnapshotWhoseTemplateBytesExceedConfiguredBudget()
    {
        PublicHtmlArtifact artifact = PublicHotReadHtmlArtifactFactory.FromHtml(
            "<html><head></head><body><script>budget()</script></body></html>",
            "public,max-age=60");
        var html = new Dictionary<string, PublicHtmlArtifact>(StringComparer.Ordinal)
        {
            ["html:home"] = artifact
        }.ToFrozenDictionary(StringComparer.Ordinal);
        var snapshot = new PublicHotReadSnapshot(
            1,
            FrozenDictionary<int, PublicBinaryArtifact>.Empty,
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            default,
            default,
            html,
            PublicHotReadPublicationEvidence.CreateVerified(1, DateTimeOffset.UtcNow));
        var store = new PublicHotReadStore(options: Options.Create(new PublicHotReadOptions
        {
            MaxResidentBytes = snapshot.ResidentBytes - 1
        }));

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(() => store.Publish(snapshot));
        Assert.Contains("candidate budget exceeded", exception.Message, StringComparison.Ordinal);
        Assert.False(store.IsReady);
    }

    [Fact]
    public void ResidentBudget_UsesConfiguredValueOrDynamicMachineLimitAndRejectsNegativeInput()
    {
        Assert.Equal(123_456, PublicHotReadStore.ResolveResidentByteBudget(123_456));
        Assert.True(PublicHotReadStore.ResolveResidentByteBudget(0) >= 64L * 1024 * 1024);
        Assert.Throws<ArgumentOutOfRangeException>(() => PublicHotReadStore.ResolveResidentByteBudget(-1));
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static WeakReference CreateReplaceAndRelease()
    {
        PublicHtmlArtifact first = PublicHotReadHtmlArtifactFactory.FromHtml(
            "<html><head></head><body><script>first()</script></body></html>",
            "public,max-age=60");
        PublicHotReadSnapshot initial = PublicHotReadSnapshot.Empty.WithHtml("html:home", first);
        Assert.True(initial.HtmlTemplateResidentBytes > 0);
        Assert.True(initial.ResidentBytes >= first.ResidentBytes);
        CspNonceUtf8Template old = Assert.IsType<CspNonceUtf8Template>(
            initial.HtmlArtifacts.Single().Value.CspNonceTemplate);
        var weak = new WeakReference(old);
        PublicHtmlArtifact replacement = PublicHotReadHtmlArtifactFactory.FromHtml(
            "<html><head></head><body><script>replacement()</script></body></html>",
            "public,max-age=60");
        PublicHotReadSnapshot updated = initial.WithHtml("html:home", replacement);
        Assert.Single(updated.HtmlArtifacts);
        Assert.NotSame(old, updated.HtmlArtifacts.Single().Value.CspNonceTemplate);
        return weak;
    }

    private static CspNonceUtf8Template CreateLargeTemplate()
        => Assert.IsType<CspNonceUtf8Template>(CspNonceUtf8Template.Compile(
            string.Concat("<html><head></head><body><script>", new string('x', 4096), "</script></body></html>"),
            "large"));

    private static int Count(string source, string value)
    {
        int count = 0;
        int position = 0;
        while ((position = source.IndexOf(value, position, StringComparison.Ordinal)) >= 0)
        {
            count++;
            position += value.Length;
        }

        return count;
    }

    private static byte[] Render(CspNonceUtf8Template template, ReadOnlySpan<byte> nonce)
    {
        var writer = new ArrayBufferWriter<byte>(template.GetRenderedLength(nonce.Length));
        template.Write(writer, nonce);
        return writer.WrittenSpan.ToArray();
    }

    private static DefaultHttpContext CreateContext(PipeWriter writer)
    {
        var context = new DefaultHttpContext();
        context.Features.Set<IHttpResponseBodyFeature>(new PipeResponseBodyFeature(writer));
        return context;
    }

    private sealed class PipeResponseBodyFeature(PipeWriter writer) : IHttpResponseBodyFeature
    {
        public Stream Stream => Stream.Null;
        public PipeWriter Writer => writer;
        public void DisableBuffering()
        {
        }
        public Task StartAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task SendFileAsync(string path, long offset, long? count, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
        public Task CompleteAsync() => writer.CompleteAsync().AsTask();
    }

    private sealed class CountingPipeWriter(PipeWriter inner) : PipeWriter
    {
        public int AdvanceCalls
        {
            get; private set;
        }
        public int FlushCalls
        {
            get; private set;
        }

        public override void Advance(int bytes)
        {
            inner.Advance(bytes);
            AdvanceCalls++;
        }

        public override void CancelPendingFlush() => inner.CancelPendingFlush();
        public override void Complete(Exception? exception = null) => inner.Complete(exception);
        public override ValueTask CompleteAsync(Exception? exception = null) => inner.CompleteAsync(exception);
        public override Memory<byte> GetMemory(int sizeHint = 0) => inner.GetMemory(sizeHint);
        public override Span<byte> GetSpan(int sizeHint = 0) => inner.GetSpan(sizeHint);

        public override ValueTask<FlushResult> FlushAsync(CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            FlushCalls++;
            return inner.FlushAsync(cancellationToken);
        }
    }
}
