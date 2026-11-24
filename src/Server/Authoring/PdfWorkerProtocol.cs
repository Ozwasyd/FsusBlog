namespace FsusBlog.V2.Server.Authoring;

internal static class PdfWorkerProtocol
{
    internal const int MaximumOutput = 4 * 1024 * 1024;
    private static readonly byte[] ReadyBytes = "FSUS-PDF-1\n"u8.ToArray();
    internal static ReadOnlyMemory<byte> Ready => ReadyBytes;

    internal static byte[] Accept(int exit, byte[] result, byte[] errors)
    {
        if (exit == 2 && result.Length == 0)
        {
            Exception rejection = Encoding.ASCII.GetString(errors).TrimEnd('\n', '\r') switch
            {
                "pdf-glyphs" => new BusinessException(Rejection.Invalid, "Offline PDF cannot display one or more characters in this revision."),
                "pdf-resources" => new BusinessException(Rejection.Invalid, "Offline PDF could not render the revision without external resources."),
                "pdf-budget" => HtmlDocumentExport.TooLarge("PDF"),
                _ => new PublicUnavailableException()
            };
            throw rejection;
        }
        if (exit != 0 || errors.Length != 0 || !result.AsSpan().StartsWith("%PDF-"u8))
            throw new PublicUnavailableException();
        return result;
    }

}
