using System.Buffers;
using System.Buffers.Binary;
using System.Text;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Worst-case structural fixtures prove transport budgets without allocating real jobs or receipts.</summary>
public sealed class DocumentExportPayloadBoundsTests
{
    private static readonly string s_identifier = new('界', 192);
    private static readonly string s_reason = new('界', 2048);

    [Theory]
    [InlineData("request", 3530, 16368, 16384)]
    [InlineData("task", 584, 1008, 1024)]
    [InlineData("job", 31466, 32768, 32784)]
    [InlineData("page", 1573117, 2097152, 2097168)]
    public void MaximumValidGrammar_FitsExactPayloadAndCompleteFrameBudget(string root, int expectedLength,
        int payloadBudget, int frameBudget)
    {
        byte[] payload = root switch
        {
            "request" => PodBinaryCodec.EncodeDocumentExportRequest(LongestRequest()),
            "task" => PodBinaryCodec.EncodeDocumentExportTaskRequest(new(s_identifier)),
            "job" => PodBinaryCodec.EncodeDocumentExportJobResponse(LongestJob()),
            _ => PodBinaryCodec.EncodeDocumentExportPageResponse(new(0, 50, true,
                Enumerable.Range(0, 50).Select(index => LongestJob() with
                {
                    TaskId = s_identifier[..191] + (char)(0x4e00 + index)
                }).ToArray()))
        };
        Assert.Equal(expectedLength, payload.Length);
        Assert.True(payload.Length <= payloadBudget);
        Assert.Equal(16, AedsFrameHeader.Size);
        Assert.Equal(payloadBudget + AedsFrameHeader.Size, frameBudget);
        Assert.True(Decode(root, payload));
        Assert.Equal(payloadBudget, PayloadBudget(root));
        Assert.Equal(frameBudget, FrameBudget(root));
    }

    [Theory]
    [InlineData("request")]
    [InlineData("task")]
    [InlineData("job")]
    [InlineData("page")]
    public void EveryRoot_RefusesItsOwnOversizeBudget(string root)
    {
        byte[] payload = new byte[PayloadBudget(root) + 1];
        BinaryPrimitives.WriteInt32LittleEndian(payload, 1);
        Assert.False(Decode(root, payload));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void TextLimit_CountsUtf16UnitsRatherThanUtf8BytesOrCodePoints(bool supplementary)
    {
        string valid = supplementary ? string.Concat(Enumerable.Repeat("🌍", 96)) : s_identifier;
        string invalid = supplementary ? valid + "🌍" : valid + "界";
        Assert.Equal(192, valid.Length);
        Assert.True(Encoding.UTF8.GetByteCount(invalid) <= 768);
        Assert.True(PodBinaryCodec.TryDecodeDocumentExportTaskRequest(
            PodBinaryCodec.EncodeDocumentExportTaskRequest(new(valid)), out var decoded));
        Assert.Equal(valid, decoded.TaskId);
        var destination = new ArrayBufferWriter<byte>();
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.WriteDocumentExportTaskRequest(new(invalid), destination));
        Assert.Equal(0, destination.WrittenCount);
        Assert.False(PodBinaryCodec.TryDecodeDocumentExportTaskRequest(RawTask(invalid), out _));
    }

    [Theory]
    [InlineData("\u3000")]
    [InlineData("x\u0085x")]
    public void Text_RefusesUnicodeWhitespaceOnlyAndControlsWithoutNormalizing(string invalid)
    {
        Assert.False(PodBinaryCodec.TryDecodeDocumentExportTaskRequest(RawTask(invalid), out _));
        var destination = new ArrayBufferWriter<byte>();
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.WriteDocumentExportTaskRequest(new(invalid), destination));
        Assert.Equal(0, destination.WrittenCount);
    }

    [Fact]
    public void JobReader_RefusesAnAlteredDigestPrefixWithoutRepairingIt()
    {
        byte[] payload = PodBinaryCodec.EncodeDocumentExportJobResponse(DocumentExportBinaryCodecTests.Job());
        int digestOffset = payload.AsSpan().IndexOf("sha256:"u8);
        Assert.True(digestOffset > 0);
        "SHA256:"u8.CopyTo(payload.AsSpan(digestOffset));
        Assert.False(PodBinaryCodec.TryDecodeDocumentExportJobResponse(payload, out _));
    }

    private static DocumentExportRequestCoreModel LongestRequest()
        => new(s_identifier, s_identifier, new(1, long.MaxValue, s_identifier, null, null, long.MaxValue),
            "self-contained-html", s_identifier, s_identifier, s_identifier);

    private static DocumentExportJobResponseCoreModel LongestJob()
        => DocumentExportBinaryCodecTests.Job() with
        {
            TaskId = s_identifier,
            RequestId = s_identifier,
            Source = LongestRequest().Source,
            ProviderId = s_identifier,
            ProviderVersion = s_identifier,
            LayoutProfile = s_identifier,
            ThemeProfile = s_identifier,
            Locale = s_identifier,
            Status = 10,
            Reason = s_reason,
            Attempts = Enumerable.Range(1, 3).Select(number =>
                new DocumentExportAttemptCoreModel(number, true, 0, 1, 10, s_reason)).ToArray(),
            Output = new(s_identifier, s_identifier, s_identifier, "sha256:" + new string('c', 64),
                "sha256:" + new string('d', 64), 0, 0, 1000, 1)
        };

    private static byte[] RawTask(string value)
    {
        byte[] text = Encoding.UTF8.GetBytes(value);
        byte[] payload = new byte[8 + text.Length];
        BinaryPrimitives.WriteInt32LittleEndian(payload, 1);
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(4), text.Length);
        text.CopyTo(payload, 8);
        return payload;
    }

    private static bool Decode(string root, byte[] payload) => root switch
    {
        "request" => PodBinaryCodec.TryDecodeDocumentExportRequest(payload, out _),
        "task" => PodBinaryCodec.TryDecodeDocumentExportTaskRequest(payload, out _),
        "job" => PodBinaryCodec.TryDecodeDocumentExportJobResponse(payload, out _),
        _ => PodBinaryCodec.TryDecodeDocumentExportPageResponse(payload, out _)
    };

    private static int PayloadBudget(string root) => root switch
    {
        "request" => PodBinaryCodec.MaximumDocumentExportRequestPayloadBytes,
        "task" => PodBinaryCodec.MaximumDocumentExportTaskRequestPayloadBytes,
        "job" => PodBinaryCodec.MaximumDocumentExportJobResponsePayloadBytes,
        _ => PodBinaryCodec.MaximumDocumentExportPageResponsePayloadBytes
    };

    private static int FrameBudget(string root) => root switch
    {
        "request" => PodBinaryCodec.MaximumDocumentExportRequestFrameBytes,
        "task" => PodBinaryCodec.MaximumDocumentExportTaskRequestFrameBytes,
        "job" => PodBinaryCodec.MaximumDocumentExportJobResponseFrameBytes,
        _ => PodBinaryCodec.MaximumDocumentExportPageResponseFrameBytes
    };
}
