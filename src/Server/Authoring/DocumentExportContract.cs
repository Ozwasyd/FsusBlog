using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;

namespace FsusBlog.V2.Server.Authoring;

internal static class DocumentExportContract
{
    internal static BusinessException Missing() => new(Rejection.NotFound, "Document export is unavailable.");

    internal static (string ContentType, string Extension) Presentation(DocumentExportFormat format) => format switch
    {
        DocumentExportFormat.Html => (HtmlDocumentExport.ContentType, "html"),
        DocumentExportFormat.Pdf => (PdfDocumentExport.ContentType, "pdf"),
        DocumentExportFormat.Docx => (WordDocumentExport.ContentType, "docx"),
        DocumentExportFormat.Epub => (EpubDocumentExport.ContentType, "epub"),
        _ => throw new InvalidOperationException("Unregistered document format."),
    };
}
