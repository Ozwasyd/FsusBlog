using System.ComponentModel;
using System.Globalization;
using System.Text;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Extensions;

namespace FsusBlog.V2.Server.Authoring;

internal sealed class PdfDocumentExport(Func<byte[], CancellationToken, Task<byte[]>> render)
{
    internal const string ContentType = "application/pdf";
    internal const string RatePolicy = "pdf-export";
    internal const string PageMarker = "<meta name=\"fsus-pdf-export\" content=\"1\">";
    private const int MaximumInput = 384 * 1024;
    private const int MaximumMarkdown = 256 * 1024;
    private readonly SemaphoreSlim rendererSlot = new(1, 1);
    internal byte[]? ToolDigest { get; private init; }

    internal static PdfDocumentExport? Read(IConfiguration configuration)
    {
        var root = configuration["FSUSBLOG_PDF_TOOL_ROOT"];
        var digest = configuration["FSUSBLOG_PDF_TOOL_SHA256"];
        if (string.IsNullOrEmpty(root) && string.IsNullOrEmpty(digest)) return null;
        if (OperatingSystem.IsLinux())
            return new(LinuxPdfRuntime.Read(root, digest).RenderAsync) { ToolDigest = Convert.FromHexString(digest!) };
        if (!OperatingSystem.IsMacOS() || !File.Exists(MacPdfRuntime.Sandbox) || !File.Exists(MacPdfRuntime.Env))
            throw new InvalidOperationException("Offline PDF requires a supported sandbox host.");
        return new(new MacPdfRuntime(PdfExportToolchain.Read(root, digest)).RenderAsync) { ToolDigest = Convert.FromHexString(digest!) };
    }

    internal async Task<byte[]> WriteAsync(string title, string markdown, DateTimeOffset happenedAt, CancellationToken ct,
        bool includeTables = true, DocumentExportAttachment[]? images = null)
    {
        ct.ThrowIfCancellationRequested();
        if (Encoding.UTF8.GetByteCount(markdown) > MaximumMarkdown) throw HtmlDocumentExport.TooLarge("PDF");
        var body = HtmlDocumentExport.RenderBody(title, markdown, "PDF", ct, includeTables);
        var created = happenedAt.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
        var metadata = $"<meta name=\"dcterms.created\" content=\"{created}\">";
        var document = HtmlDocumentExport.Wrap(title, body, metadata);
        if (Encoding.UTF8.GetByteCount(document) > MaximumInput) throw HtmlDocumentExport.TooLarge("PDF");
        if (images is { Length: > 0 })
        {
            if (images.Length > DocumentExportAttachment.MaximumImages ||
                images.Sum(image => (long)image.Bytes.Length) > DocumentExportAttachment.MaximumBytes ||
                images.Sum(image => (long)image.Width * image.Height) > 4 * 1024 * 1024)
                throw HtmlDocumentExport.TooLarge("PDF");
            document = HtmlDocumentExport.Wrap(title, body + string.Concat(images.Select(image => image.InlineFigure())), metadata);
        }

        await rendererSlot.WaitAsync(ct);
        try
        {
            ct.ThrowIfCancellationRequested();
            return await render(Encoding.UTF8.GetBytes(document), ct);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new PublicUnavailableException(); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or Win32Exception or
            ExtensionRejectedException or InvalidOperationException or TimeoutException)
        {
            // An engine error or its stderr must never appear in the public response or service log.
            throw new PublicUnavailableException();
        }
        finally { rendererSlot.Release(); }
    }

}
