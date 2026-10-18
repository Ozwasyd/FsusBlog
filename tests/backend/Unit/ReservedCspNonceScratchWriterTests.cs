using System.Buffers;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.PublicAot;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ReservedCspNonceScratchWriterTests
{
    private const string Html = "<!doctype html><html><head><title>中文🙂</title><style>.示例{color:red}</style></head><body>边界🚀<script>globalThis.ok='好';</script></body></html>";

    [Theory]
    [InlineData("A", 0)]
    [InlineData("Abc_123-safe", 0)]
    [InlineData("request_two-0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 0)]
    [InlineData("request_two", 7)]
    public void Write_CallerScratch_MatchesCanonicalUtf8AndPreservesTemplate(string nonce, int extraCapacity)
    {
        CspNonceUtf8Template template = CreateTemplate();
        string digest = template.TemplateDigest;
        ReadOnlyMemory<byte> integrity = template.IntegrityBytes;
        byte[] originalBytes = integrity.ToArray();
        string[] staticHashes = template.StaticInlineSha256Sources.ToArray();
        byte[] encodedNonce = Encoding.UTF8.GetBytes(nonce);
        var canonical = new ArrayBufferWriter<byte>();
        template.Write(canonical, encodedNonce, CancellationToken.None);
        var destination = new TrackingWriter();
        byte[] scratch = Enumerable.Repeat((byte)0xA5, encodedNonce.Length + extraCapacity).ToArray();

        ReservedCspNonceScratchWriter.Write(template, nonce, destination, scratch, CancellationToken.None);

        Assert.Equal(canonical.WrittenSpan.ToArray(), destination.WrittenBytes);
        Assert.Equal(template.GetRenderedLength(encodedNonce.Length), destination.WrittenBytes.Length);
        Assert.Contains("中文🙂", Encoding.UTF8.GetString(destination.WrittenBytes), StringComparison.Ordinal);
        Assert.Contains("边界🚀", Encoding.UTF8.GetString(destination.WrittenBytes), StringComparison.Ordinal);
        Assert.Equal(encodedNonce, scratch.AsSpan(0, encodedNonce.Length).ToArray());
        Assert.All(scratch.Skip(encodedNonce.Length), value => Assert.Equal((byte)0xA5, value));
        Assert.Equal(digest, template.TemplateDigest);
        Assert.Equal(integrity, template.IntegrityBytes);
        Assert.Equal(originalBytes, template.IntegrityBytes.ToArray());
        Assert.Equal(digest, Convert.ToHexStringLower(SHA256.HashData(template.IntegrityBytes.Span)));
        Assert.Equal(staticHashes, template.StaticInlineSha256Sources);
    }

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("bad+nonce")]
    [InlineData("bad/nonce")]
    [InlineData("bad=nonce")]
    [InlineData("bad nonce")]
    [InlineData("bad\"nonce")]
    [InlineData("bad\nnonce")]
    [InlineData("中文")]
    [InlineData("🙂")]
    public void Write_InvalidNonce_PreservesCanonicalFailureWithoutDestinationAccess(string? nonce)
        => AssertInvalidNonce(nonce);

    [Theory]
    [InlineData(0xD800)]
    [InlineData(0xDC00)]
    public void Write_InvalidUtf16_PreservesOriginalUtf8FallbackAndNonceRejection(int codeUnit)
        => AssertInvalidNonce(new string((char)codeUnit, 1));

    [Theory]
    [InlineData("valid_nonce", 10)]
    [InlineData("中", 1)]
    [InlineData("🙂", 2)]
    public void Write_UndersizedScratch_RejectsActualByteCountBeforeEncodingOrDestinationAccess(
        string nonce,
        int capacity)
    {
        CspNonceUtf8Template template = CreateTemplate();
        var destination = new TrackingWriter();
        byte[] scratch = Enumerable.Repeat((byte)0xA5, capacity).ToArray();
        Assert.True(Encoding.UTF8.GetByteCount(nonce) > capacity);

        ArgumentException exception = Assert.Throws<ArgumentException>(() =>
            ReservedCspNonceScratchWriter.Write(template, nonce, destination, scratch, CancellationToken.None));

        Assert.Equal("callerAdmittedNonceScratch", exception.ParamName);
        Assert.All(scratch, value => Assert.Equal((byte)0xA5, value));
        AssertNoDestinationAccess(destination);
    }

    [Fact]
    public void Write_PreCanceledToken_PreservesCanonicalTokenAndRejectsBeforeDestinationAccess()
    {
        CspNonceUtf8Template template = CreateTemplate();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var canonical = new TrackingWriter();
        var destination = new TrackingWriter();
        byte[] scratch = new byte[Encoding.UTF8.GetByteCount("valid_nonce")];
        OperationCanceledException expected = Assert.Throws<OperationCanceledException>(() =>
            template.Write(canonical, "valid_nonce"u8, cancellation.Token));

        OperationCanceledException actual = Assert.Throws<OperationCanceledException>(() =>
            ReservedCspNonceScratchWriter.Write(template, "valid_nonce", destination, scratch, cancellation.Token));

        Assert.Equal(expected.CancellationToken, actual.CancellationToken);
        AssertNoDestinationAccess(canonical);
        AssertNoDestinationAccess(destination);
    }

    [Fact]
    public void Write_InvalidNonceWithCanceledToken_PreservesValidationBeforeCancellation()
    {
        CspNonceUtf8Template template = CreateTemplate();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var destination = new TrackingWriter();
        byte[] scratch = new byte[Encoding.UTF8.GetByteCount("bad+nonce")];
        InvalidOperationException expected = Assert.Throws<InvalidOperationException>(() =>
            template.Write(new TrackingWriter(), "bad+nonce"u8, cancellation.Token));

        InvalidOperationException actual = Assert.Throws<InvalidOperationException>(() =>
            ReservedCspNonceScratchWriter.Write(template, "bad+nonce", destination, scratch, cancellation.Token));

        Assert.Equal(expected.Message, actual.Message);
        AssertNoDestinationAccess(destination);
    }

    [Fact]
    public void Write_CancellationAfterFirstSegment_PreservesCanonicalPartialBytesAndToken()
    {
        CspNonceUtf8Template template = CreateTemplate();
        using var canonicalCancellation = new CancellationTokenSource();
        using var cancellation = new CancellationTokenSource();
        var canonical = new TrackingWriter(canonicalCancellation.Cancel);
        var destination = new TrackingWriter(cancellation.Cancel);
        byte[] scratch = new byte[Encoding.UTF8.GetByteCount("valid_nonce")];
        Assert.Throws<OperationCanceledException>(() =>
            template.Write(canonical, "valid_nonce"u8, canonicalCancellation.Token));

        OperationCanceledException actual = Assert.Throws<OperationCanceledException>(() =>
            ReservedCspNonceScratchWriter.Write(template, "valid_nonce", destination, scratch, cancellation.Token));

        Assert.Equal(cancellation.Token, actual.CancellationToken);
        Assert.Equal(1, canonical.AdvanceCalls);
        Assert.Equal(canonical.AdvanceCalls, destination.AdvanceCalls);
        Assert.Equal(canonical.GetSpanCalls, destination.GetSpanCalls);
        Assert.NotEmpty(destination.WrittenBytes);
        Assert.Equal(canonical.WrittenBytes, destination.WrittenBytes);
    }

    private static void AssertInvalidNonce(string? nonce)
    {
        CspNonceUtf8Template template = CreateTemplate();
        var canonical = new TrackingWriter();
        var destination = new TrackingWriter();
        byte[] scratch = new byte[Encoding.UTF8.GetByteCount(nonce.AsSpan())];
        byte[] encodedNonce = Encoding.UTF8.GetBytes(nonce ?? string.Empty);
        InvalidOperationException expected = Assert.Throws<InvalidOperationException>(() =>
            template.Write(canonical, encodedNonce, CancellationToken.None));

        InvalidOperationException actual = Assert.Throws<InvalidOperationException>(() =>
            ReservedCspNonceScratchWriter.Write(template, nonce!, destination, scratch, CancellationToken.None));

        Assert.Equal(expected.Message, actual.Message);
        AssertNoDestinationAccess(canonical);
        AssertNoDestinationAccess(destination);
    }

    private static CspNonceUtf8Template CreateTemplate()
        => Assert.IsType<CspNonceUtf8Template>(CspNonceUtf8Template.Compile(Html, "nonce-scratch-fixture"));

    private static void AssertNoDestinationAccess(TrackingWriter destination)
    {
        Assert.Equal(0, destination.GetSpanCalls);
        Assert.Equal(0, destination.GetMemoryCalls);
        Assert.Equal(0, destination.AdvanceCalls);
        Assert.Empty(destination.WrittenBytes);
    }

    private sealed class TrackingWriter(Action? advanced = null) : IBufferWriter<byte>
    {
        private readonly ArrayBufferWriter<byte> _buffer = new();

        public int AdvanceCalls
        {
            get; private set;
        }
        public int GetSpanCalls
        {
            get; private set;
        }
        public int GetMemoryCalls
        {
            get; private set;
        }
        public byte[] WrittenBytes => _buffer.WrittenSpan.ToArray();

        public void Advance(int count)
        {
            _buffer.Advance(count);
            AdvanceCalls++;
            advanced?.Invoke();
        }

        public Memory<byte> GetMemory(int sizeHint = 0)
        {
            GetMemoryCalls++;
            return _buffer.GetMemory(sizeHint);
        }

        public Span<byte> GetSpan(int sizeHint = 0)
        {
            GetSpanCalls++;
            return _buffer.GetSpan(sizeHint);
        }
    }
}
