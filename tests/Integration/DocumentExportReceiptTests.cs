namespace FsusBlog.V2.Integration.Tests;

public sealed class DocumentExportReceiptTests
{
    [Fact]
    public void GeneratedReceiptPreservesTheFrozenEncoderBytesAcrossVersionsAndProviders()
    {
        var id = Guid.Parse("11111111-2222-3333-4444-555555555555");
        var digest = Enumerable.Range(0, 32).Select(value => (byte)value).ToArray();
        var images = new[] { new DocumentExportAttachment("图 <&> \".png", MediaFormat.Png, 3, 4, [1, 2, 3], digest) };
        foreach (var version in new[] { 1, 2 })
        foreach (var format in Enum.GetValues<DocumentExportFormat>())
        foreach (byte provider in new byte[] { 1, 2, 4 })
        foreach (var body in new[] { "Plain text 中文 😀 <&>", "# Heading\n\n~~Strike~~ and ~~again~~\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```mermaid\ngraph TD; A-->B;\n```" })
        foreach (var attached in new[] { false, true })
        {
            var input = new DocumentExportInput("中文 <&> \" 😀", body,
                new DateTimeOffset(2026, 11, 16, 1, 2, 3, TimeSpan.Zero).AddTicks(1234567),
                attached ? [id] : [], attached ? images : []);
            var task = new DocumentExportTask(new(id, 42, 9_007_199_254_740_993L, 9_007_199_254_740_991L, format),
                DocumentExportState.Succeeded, DocumentExportFailure.None, provider, 1, 2, 3, 4, digest, digest, 123);
            byte[]? tool = format == DocumentExportFormat.Pdf ? digest : null;
            var expected = FrozenEncode(task, input, tool, version, CancellationToken.None);
            var actual = DocumentExportReceipt.Encode(task, input, tool, version, CancellationToken.None);
            Assert.Equal(expected, actual);
            using var parsed = JsonDocument.Parse(actual);
            Assert.Equal(version != 1, parsed.RootElement.TryGetProperty("warnings", out _));
        }
    }

    [Fact]
    public void GeneratedContextDoesNotFallBackToReflectionForUnregisteredTypes()
    {
        Assert.Throws<NotSupportedException>(() => JsonSerializer.Serialize(new Unregistered("not registered"),
            DocumentExportReceiptJson.Default.Options));
    }

    private sealed record Unregistered(string Value);

    // Independent compatibility oracle: the exact 060be89 receipt encoder, not the new DTOs.
    private static byte[] FrozenEncode(DocumentExportTask task, DocumentExportInput input, byte[]? toolDigest,
        int version, CancellationToken ct)
    {
        var (mime, format) = DocumentExportContract.Presentation(task.Request.Format);
        var result = new
        {
            version, taskId = task.Request.Id, article = task.Request.Article,
            expectedRevision = task.Request.Revision.ToString(CultureInfo.InvariantCulture),
            sourceRevision = task.Request.SourceRevision.ToString(CultureInfo.InvariantCulture),
            format, provider = task.Provider, layout = "basic-layout-1", state = "succeeded",
            toolchainSha256 = toolDigest is null ? null : Convert.ToHexStringLower(toolDigest),
            createdUnixMs = task.Created, startedUnixMs = task.Started, finishedUnixMs = task.Finished, expiresUnixMs = task.Expires,
            sourceSha256 = Convert.ToHexStringLower(task.SourceDigest),
            bodySha256 = TextDigest(input.Body),
            metadata = new
            {
                title = input.Title, savedUtcTicks = input.HappenedAt.UtcTicks.ToString(CultureInfo.InvariantCulture),
                titleSha256 = TextDigest(input.Title)
            },
            assets = input.Attachments.Select((image, index) => new
            {
                id = input.Assets[index], name = image.Name, mime = image.ContentType,
                width = image.Width, height = image.Height, bytes = image.Bytes.Length,
                sha256 = Convert.ToHexStringLower(image.VerifiedDigest!)
            }).ToArray(),
            output = new { mime = mime.Split(';', 2)[0], bytes = task.OutputBytes, sha256 = Convert.ToHexStringLower(task.OutputDigest!) }
        };
        if (version == 1) return JsonSerializer.SerializeToUtf8Bytes(result);
        var details = JsonSerializer.SerializeToNode(result)!.AsObject();
        var warnings = task.Request.Format == DocumentExportFormat.Docx
            ? WordDocumentExport.Warnings(input.Body, task.Provider != 1, ct)
            : EpubDocumentExport.Warnings(input.Body, task.Provider != 1, ct);
        details["warnings"] = JsonSerializer.SerializeToNode(warnings
            .Select(warning => new { code = warning.Code, start = warning.Start, length = warning.Length, occurrences = warning.Occurrences }));
        return JsonSerializer.SerializeToUtf8Bytes(details);

        static string TextDigest(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
    }

}
