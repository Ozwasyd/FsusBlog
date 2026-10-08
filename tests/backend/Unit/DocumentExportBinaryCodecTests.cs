using System.Buffers;
using System.Buffers.Binary;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DocumentExportBinaryCodecTests
{
    internal static DocumentExportSourceCoreModel Source() => new(2, 42, null, 17, null, 3);
    internal static DocumentExportRequestCoreModel Request() => new("request-1", "key-1", Source(),
        "self-contained-html", "document-reading-v1", "light-v1", "en");
    internal static DocumentExportJobResponseCoreModel Job() => new("task-1", "request-1", Source(),
        "sha256:" + new string('a', 64), "sha256:" + new string('b', 64), "self-contained-html", "fsus-html", "1",
        "document-reading-v1", "light-v1", "en", 1, 1, 0, 1000, "", [], null);

    [Theory]
    [InlineData("request-revision")]
    [InlineData("task-request")]
    [InlineData("queued-job-response")]
    [InlineData("empty-page-response")]
    [InlineData("single-page-response")]
    public void PayloadGoldens_BindAllFourRootsWithoutAllocatingFrames(string name)
    {
        byte[] expected = Golden(name);
        Assert.Equal(expected, Encode(name));
        Assert.True(Decode(name, expected));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public void Request_PreservesExactCoordinateAndUnicode(int kind)
    {
        DocumentExportSourceCoreModel source = kind switch
        {
            1 => new(1, 42, "精确草稿-🌍", null, null, 3),
            2 => Source(),
            _ => Source() with { Kind = 3, PublicationId = 9 }
        };
        DocumentExportRequestCoreModel expected = Request() with
        {
            Source = source,
            RequestId = "原始-request-🌍"
        };
        byte[] payload = PodBinaryCodec.EncodeDocumentExportRequest(expected);
        Assert.True(PodBinaryCodec.TryDecodeDocumentExportRequest(payload, out var actual));
        Assert.Equal(expected, actual);
    }

    [Theory]
    [InlineData("self-contained-html")]
    [InlineData("pdf")]
    [InlineData("docx")]
    [InlineData("epub")]
    public void Request_PreservesClosedFormatWithoutChoosingAProvider(string format)
    {
        var expected = Request() with
        {
            FormatId = format
        };
        Assert.True(PodBinaryCodec.TryDecodeDocumentExportRequest(PodBinaryCodec.EncodeDocumentExportRequest(expected), out var actual));
        Assert.Equal(expected, actual);
    }

    [Theory]
    [InlineData("request-revision")]
    [InlineData("task-request")]
    [InlineData("queued-job-response")]
    [InlineData("empty-page-response")]
    [InlineData("single-page-response")]
    public void AllRoots_RejectEveryTruncationTrailingFieldsAndFutureVersion(string name)
    {
        byte[] valid = Golden(name);
        for (int length = 0; length < valid.Length; length++)
        {
            Assert.False(Decode(name, valid[..length]));
        }
        Assert.False(Decode(name, [.. valid, 0]));
        byte[] future = (byte[])valid.Clone();
        BinaryPrimitives.WriteInt32LittleEndian(future, 2);
        Assert.False(Decode(name, future));
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(int.MaxValue)]
    [InlineData(int.MinValue)]
    [InlineData(769)]
    public void Request_RejectsHostileStringLengthsBeforeReadingOrAllocating(int length)
    {
        byte[] payload = Golden("request-revision");
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(4), length);
        Assert.False(PodBinaryCodec.TryDecodeDocumentExportRequest(payload, out _));
    }

    [Fact]
    public void Request_RejectsInvalidUtf8UnknownCoordinateAndExtraOwnerFields()
    {
        byte[] payload = Golden("request-revision");
        payload[8] = 0xff;
        Assert.False(PodBinaryCodec.TryDecodeDocumentExportRequest(payload, out _));
        payload = Golden("request-revision");
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(26), 4);
        Assert.False(PodBinaryCodec.TryDecodeDocumentExportRequest(payload, out _));
        payload = [.. Golden("request-revision"), .. Encoding.UTF8.GetBytes("siteId=1;session=forged;owner=42")];
        Assert.False(PodBinaryCodec.TryDecodeDocumentExportRequest(payload, out _));
        Assert.False(PodBinaryCodec.TryDecodeDocumentExportRequest("{\"siteId\":1}"u8.ToArray(), out _));
    }

    [Fact]
    public void RequestWriter_RejectsMalformedIntentBeforeWritingAnyByte()
    {
        DocumentExportRequestCoreModel[] invalid =
        [
            Request() with { FormatId = "fallback-html" },
            Request() with { RequestId = "" },
            Request() with { RequestId = "a\nsecret" },
            Request() with { RequestId = "\ud800" },
            Request() with { Source = Source() with { DraftKey = "mixed-kind" } },
            Request() with { Source = Source() with { Kind = 3, RevisionId = null, PublicationId = 2 } },
            Request() with { Source = Source() with { SourceVersion = 0 } }
        ];
        foreach (var request in invalid)
        {
            var writer = new ArrayBufferWriter<byte>();
            Assert.Throws<ArgumentException>(() => PodBinaryCodec.WriteDocumentExportRequest(request, writer));
            Assert.Equal(0, writer.WrittenCount);
        }
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(20)]
    [InlineData(50)]
    public void Page_IsBoundedAndPreservesEachActualProjection(int count)
    {
        var jobs = Enumerable.Range(0, count).Select(index => Job() with { TaskId = $"task-{index}" }).ToArray();
        var page = new DocumentExportPageResponseCoreModel(1000, 50, count == 50, jobs);
        byte[] payload = PodBinaryCodec.EncodeDocumentExportPageResponse(page);
        Assert.True(PodBinaryCodec.TryDecodeDocumentExportPageResponse(payload, out var actual));
        Assert.Equal(page.Offset, actual.Offset);
        Assert.Equal(page.HasMore, actual.HasMore);
        Assert.Equal(jobs.Select(job => job.TaskId), actual.Jobs.Select(job => job.TaskId));
        Assert.Equal(payload, PodBinaryCodec.EncodeDocumentExportPageResponse(actual));
    }

    [Fact]
    public void Page_RejectsUnknownBooleanAndUnboundedCount()
    {
        byte[] payload = Golden("empty-page-response");
        payload[12] = 2;
        Assert.False(PodBinaryCodec.TryDecodeDocumentExportPageResponse(payload, out _));
        payload = Golden("empty-page-response");
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(13), int.MaxValue);
        Assert.False(PodBinaryCodec.TryDecodeDocumentExportPageResponse(payload, out _));
    }

    [Fact]
    public void PageWriter_RejectsDuplicateTasksAndUnprovenMoreBeforeWriting()
    {
        var writer = new ArrayBufferWriter<byte>();
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.WriteDocumentExportPageResponse(new(0, 20, false, [Job(), Job()]), writer));
        Assert.Equal(0, writer.WrittenCount);
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.WriteDocumentExportPageResponse(new(0, 20, true, [Job()]), writer));
        Assert.Equal(0, writer.WrittenCount);
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.WriteDocumentExportPageResponse(new(0, 51, false, []), writer));
        Assert.Equal(0, writer.WrittenCount);
    }

    [Fact]
    public void Job_PreservesCleanupRequiredAndDiagnosticWithoutSuccessfulDelivery()
    {
        var expected = Job() with
        {
            Status = 10,
            Reason = "cleanup_required",
            Attempts = [new(1, true, 0, null, 10, "interrupted")],
            Output = new("output-1", "application/pdf", ".pdf", "sha256:" + new string('c', 64), "sha256:" + new string('d', 64), 0, 0, 1000, 500)
        };
        byte[] payload = PodBinaryCodec.EncodeDocumentExportJobResponse(expected);
        Assert.True(PodBinaryCodec.TryDecodeDocumentExportJobResponse(payload, out var actual));
        Assert.Equal(10, actual.Status);
        Assert.True(actual.Attempts[0].Diagnostic);
        Assert.Null(actual.Attempts[0].FinishedAtUnixMs);
        Assert.Equal(500, actual.Output!.DeletedAtUnixMs);
        Assert.Equal(payload, PodBinaryCodec.EncodeDocumentExportJobResponse(actual));
    }

    [Fact]
    public void JobWriter_RejectsUnknownStatusVersionDigestAndOversizeAttemptHistory()
    {
        DocumentExportJobResponseCoreModel[] invalid =
        [
            Job() with { Status = 999 }, Job() with { Version = 0 }, Job() with { InputDigest = "unsealed" },
            Job() with { InputDigest = new string('a', 64) },
            Job() with { InputDigest = "SHA256:" + new string('a', 64) },
            Job() with { Attempts = Enumerable.Range(1, 4).Select(number => new DocumentExportAttemptCoreModel(number, true, 0, null, 7, "failed")).ToArray() }
        ];
        foreach (var job in invalid)
        {
            var writer = new ArrayBufferWriter<byte>();
            Assert.Throws<ArgumentException>(() => PodBinaryCodec.WriteDocumentExportJobResponse(job, writer));
            Assert.Equal(0, writer.WrittenCount);
        }
    }

    private static byte[] Golden(string name)
    {
        DirectoryInfo? root = new(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "tests/backend/Fixtures/document-export-payload-goldens-v1.json")))
        {
            root = root.Parent;
        }
        Assert.NotNull(root);
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(root.FullName,
            "tests/backend/Fixtures/document-export-payload-goldens-v1.json")));
        string hex = document.RootElement.GetProperty("vectors").EnumerateArray()
            .Single(vector => vector.GetProperty("name").GetString() == name).GetProperty("hex").GetString()!;
        return Convert.FromHexString(hex);
    }

    private static byte[] Encode(string name) => name switch
    {
        "request-revision" => PodBinaryCodec.EncodeDocumentExportRequest(Request()),
        "task-request" => PodBinaryCodec.EncodeDocumentExportTaskRequest(new("task-1")),
        "queued-job-response" => PodBinaryCodec.EncodeDocumentExportJobResponse(Job()),
        "empty-page-response" => PodBinaryCodec.EncodeDocumentExportPageResponse(new(0, 20, false, [])),
        "single-page-response" => PodBinaryCodec.EncodeDocumentExportPageResponse(new(20, 20, false, [Job()])),
        _ => throw new ArgumentException(name)
    };

    private static bool Decode(string name, byte[] payload) => name switch
    {
        "request-revision" => PodBinaryCodec.TryDecodeDocumentExportRequest(payload, out _),
        "task-request" => PodBinaryCodec.TryDecodeDocumentExportTaskRequest(payload, out _),
        "queued-job-response" => PodBinaryCodec.TryDecodeDocumentExportJobResponse(payload, out _),
        "empty-page-response" or "single-page-response" => PodBinaryCodec.TryDecodeDocumentExportPageResponse(payload, out _),
        _ => throw new ArgumentException(name)
    };
}
