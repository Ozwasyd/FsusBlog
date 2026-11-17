using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Authoring;

// The receipt contract is independent of persistence and uses no reflection or intermediate JSON DOM.
internal static class DocumentExportReceipt
{
    internal static byte[] Encode(DocumentExportTask task, DocumentExportInput input, byte[]? toolDigest,
        int version, CancellationToken ct)
    {
        var (mime, format) = DocumentExportContract.Presentation(task.Request.Format);
        var warnings = version == 1 ? null : task.Request.Format == DocumentExportFormat.Docx
            ? WordDocumentExport.Warnings(input.Body, task.Provider != 1, ct)
            : EpubDocumentExport.Warnings(input.Body, task.Provider != 1, ct);
        var payload = new Payload(version, task.Request.Id, task.Request.Article,
            task.Request.Revision.ToString(CultureInfo.InvariantCulture),
            task.Request.SourceRevision.ToString(CultureInfo.InvariantCulture), format, task.Provider,
            "basic-layout-1", "succeeded", toolDigest is null ? null : Convert.ToHexStringLower(toolDigest),
            task.Created, task.Started, task.Finished, task.Expires, Convert.ToHexStringLower(task.SourceDigest),
            TextDigest(input.Body), new(input.Title, input.HappenedAt.UtcTicks.ToString(CultureInfo.InvariantCulture),
                TextDigest(input.Title)),
            input.Attachments.Select((image, index) => new Asset(input.Assets[index], image.Name, image.ContentType,
                image.Width, image.Height, image.Bytes.Length, Convert.ToHexStringLower(image.VerifiedDigest!))).ToArray(),
            new(mime.Split(';', 2)[0], task.OutputBytes, Convert.ToHexStringLower(task.OutputDigest!)), warnings);
        return JsonSerializer.SerializeToUtf8Bytes(payload, DocumentExportReceiptJson.Default.Payload);
    }

    private static string TextDigest(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));

    internal sealed record Payload(int Version, Guid TaskId, int Article, string ExpectedRevision, string SourceRevision,
        string Format, byte Provider, string Layout, string State, string? ToolchainSha256, long CreatedUnixMs,
        long StartedUnixMs, long FinishedUnixMs, long ExpiresUnixMs, string SourceSha256, string BodySha256,
        Metadata Metadata, Asset[] Assets, Output Output,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] DocumentExportWarning[]? Warnings);
    internal sealed record Metadata(string Title, string SavedUtcTicks, string TitleSha256);
    internal sealed record Asset(Guid Id, string Name, string Mime, int Width, int Height, int Bytes, string Sha256);
    internal sealed record Output(string Mime, int Bytes, string Sha256);
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    GenerationMode = JsonSourceGenerationMode.Serialization)]
[JsonSerializable(typeof(DocumentExportReceipt.Payload))]
internal partial class DocumentExportReceiptJson : JsonSerializerContext;
