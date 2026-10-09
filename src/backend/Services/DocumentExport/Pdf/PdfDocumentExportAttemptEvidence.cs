using System.Runtime.CompilerServices;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Keeps the actual canonical evidence for the current Export/Verify call pair.
/// This is weak, in-memory custody of an attempt, not job persistence or a
/// replacement receipt. The job owner can copy result bytes before Verify.
/// </summary>
internal sealed class PdfDocumentExportAttemptEvidence
{
    private readonly object _sync = new();
    private readonly ConditionalWeakTable<DocumentExportAttemptResources, PdfDocumentExportResult> _pending = new();
    private readonly ConditionalWeakTable<DocumentExportProviderResult, DocumentExportAttemptResources> _legacy = new();

    internal DocumentExportProviderResult Retain(PdfDocumentExportResult result)
    {
        ArgumentNullException.ThrowIfNull(result);
        if (result.AttemptResources is null)
        {
            throw new InvalidDataException("PDF export did not retain its original attempt resource owner.");
        }
        lock (_sync)
        {
            _pending.Add(result.AttemptResources, result);
            _legacy.Add(result.ProviderResult, result.AttemptResources);
        }
        return result.ProviderResult;
    }

    internal PdfDocumentExportResult Take(
        DocumentExportProviderResult result, DocumentExportAttemptResources? resources = null)
    {
        ArgumentNullException.ThrowIfNull(result);
        lock (_sync)
        {
            if (resources is null && !_legacy.TryGetValue(result, out resources))
            {
                throw new InvalidDataException("PDF verification has no evidence from this original export attempt.");
            }
            if (!_pending.TryGetValue(resources!, out PdfDocumentExportResult? evidence)
                || !result.Bytes.AsSpan().SequenceEqual(evidence.ProviderResult.Bytes)
                || !result.SandboxOutputBytes.AsSpan().SequenceEqual(evidence.ProviderResult.SandboxOutputBytes)
                || result.Receipt?.ContentDigest != evidence.ProviderResult.Receipt?.ContentDigest
                || result.SandboxPlan?.ContentDigest != evidence.ProviderResult.SandboxPlan?.ContentDigest
                || result.SandboxReceipt?.ContentDigest != evidence.ProviderResult.SandboxReceipt?.ContentDigest)
            {
                throw new InvalidDataException("PDF verification result does not bind this original export attempt.");
            }
            _pending.Remove(resources!);
            _legacy.Remove(evidence.ProviderResult);
            // Verify the job's privately copied bytes, preserving the actual
            // canonical evidence. All original receipts are revalidated later.
            return ReferenceEquals(result, evidence.ProviderResult) ? evidence : evidence with
            {
                ProviderResult = result
            };
        }
    }
}
