using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.DocumentExport.Jobs;

namespace FsusBlog.Server.Services.DocumentExport.Sources;

/// <summary>Explicit original source coordinates, before the catalog allocates a source version.</summary>
public sealed record DocumentExportSourceRequest(
    DocumentExportCoordinateKind Kind,
    int ArticleId,
    string? DraftKey = null,
    long? RevisionId = null,
    long? PublicationId = null);

/// <summary>Authorized UI choice. The coordinate is the original private request contract, not an artifact identity.</summary>
public sealed record DocumentExportSourceChoice(
    string ChoiceId,
    string Label,
    DocumentExportArticleCoordinate Coordinate);

/// <summary>
/// Private, freshly checked domain input for the original freezer. This is not a sealed export input:
/// properties, assets, fonts and renderer provenance still require their original authorities.
/// Never serialize this object into a UI or public response.
/// </summary>
public sealed record DocumentExportBoundSource(
    DocumentExportSourceChoice Choice,
    string Fingerprint,
    ServerDraftResponse? Draft,
    ArticleRevision? Revision,
    ArticlePublicationRecord? Publication,
    ArticleRightsSnapshot? Rights,
    ArticleResponsibilitySnapshot? Responsibility);

/// <summary>Only supplied draft keys are read. Revision enumeration retains the lifecycle reader's 50-row limit.</summary>
public interface IDocumentExportSourceCatalog
{
    Task<IReadOnlyList<DocumentExportSourceChoice>> CaptureAsync(
        DocumentExportJobActor actor,
        IReadOnlyList<DocumentExportSourceRequest> sources,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyList<DocumentExportSourceChoice>> CaptureRevisionsAsync(
        DocumentExportJobActor actor,
        int articleId,
        CancellationToken cancellationToken = default);

    Task<DocumentExportBoundSource> ReadBoundAsync(
        DocumentExportJobActor actor,
        string choiceId,
        DocumentExportArticleCoordinate coordinate,
        CancellationToken cancellationToken = default);

    Task<DocumentExportBoundSource> ReadBoundAsync(
        DocumentExportJobActor actor,
        DocumentExportArticleCoordinate coordinate,
        CancellationToken cancellationToken = default);
}

/// <summary>Uniform refusal without raw source, database coordinates or permission details.</summary>
public sealed class DocumentExportSourceDeniedException() : InvalidOperationException("document_export_source_unavailable");

/// <summary>Private binding capacity requires an explicit lifecycle decision by the integration owner.</summary>
public sealed class DocumentExportSourceCapacityException() : InvalidOperationException("document_export_source_catalog_full");
