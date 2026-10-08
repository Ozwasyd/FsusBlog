using System.Collections.Immutable;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Services.DocumentExport.Jobs;
using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Publication;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Relations;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// An authorized stored publication and its explicit numeric-to-portable host binding.
/// This is reader data, not an authority receipt. ExpectedPlanDigest must be read from
/// persistence independently of the candidate plan. SourceDocumentEpoch preserves the
/// source reader's domain; it is never converted into HostDocument.Epoch.
/// </summary>
public sealed record DocumentExportFrozenEmbedPublicationSource(
    long UserId,
    string SiteScope,
    DocumentExportArticleCoordinate Coordinate,
    string SourcePackageDigest,
    string? SourceDocumentEpoch,
    string HostPortableArticleIdentity,
    ArticleEmbedDocumentIdentity HostDocument,
    string ExpectedPlanDigest,
    IReadOnlyList<ArticleEmbedProviderRequest> Requests,
    ArticleEmbedPublicationAuthority Authority,
    ArticleEmbedResolutionBudgetLimits Budgets,
    ArticleEmbedPublicationPlan Plan,
    ArticleEmbedRelationDerivation Derivation);

/// <summary>
/// Reads the authorized retained publication corresponding to this exact source
/// package. Implementations must use the canonical stored mapping, persisted plan
/// and parser-produced requests. Replanning, latest-target lookup and caller-owned
/// authority snapshots cannot substitute for an unavailable stored publication.
/// </summary>
public interface IDocumentExportFrozenEmbedPublicationReader
{
    Task<DocumentExportFrozenEmbedPublicationSource?> ReadAsync(
        DocumentExportJobActor actor,
        DocumentExportArticleCoordinate coordinate,
        RevisionComparePackage package,
        CancellationToken cancellationToken);
}

/// <summary>Reads complete retained bytes for the original dependency, without resolving a current target.</summary>
public interface IDocumentExportFrozenEmbedProjectionReader
{
    Task<DocumentExportFrozenEmbedProjection?> ReadAsync(
        DocumentExportJobActor actor,
        ArticleEmbedDependencyReceipt dependency,
        CancellationToken cancellationToken);
}

/// <summary>
/// Independently verifies the canonical projection codec, original content digest
/// and retention authority for the exact owned bytes. No implementation or byte-hash
/// fallback is provided by the export bridge.
/// </summary>
public interface IDocumentExportFrozenEmbedProjectionVerifier
{
    Task VerifyAsync(
        DocumentExportJobActor actor,
        DocumentExportFrozenEmbedPublicationSource publication,
        DocumentExportFrozenEmbedProjection projection,
        CancellationToken cancellationToken);
}

/// <summary>
/// Read-only assembly of the frozen embed slot using the existing authorized source
/// reader and independent publication/relation verifiers. It registers no provider,
/// parser or authority. Successful assembly does not remove the task materializer gate.
/// </summary>
public sealed class DocumentExportFrozenEmbedSourceBridge(
    IRevisionComparePackageReader sourceReader,
    IDocumentExportJobAuthorization authorization,
    IDocumentExportFrozenEmbedPublicationReader publicationReader,
    IDocumentExportFrozenEmbedProjectionReader projectionReader,
    IDocumentExportFrozenEmbedProjectionVerifier projectionVerifier)
{
    private const long MaximumInputBytes = 32L * 1024 * 1024;

    public async Task<DocumentExportFrozenInput> FreezeAsync(
        DocumentExportJobActor actor,
        RevisionCompareReadContext context,
        RevisionCompareSourceSelector selector,
        DocumentExportFrozenInput input,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(actor);
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(selector);
        DocumentExportContractValidator.Validate(input);
        if (input.FrozenEmbeds is not null
            || actor.UserId != input.UserId
            || actor.SiteScope != input.SiteScope
            || context.AdminPrincipalId != actor.UserId
            || context.SiteScope != actor.SiteScope
            || context.RequestId == Guid.Empty
            || string.IsNullOrWhiteSpace(actor.SessionId))
        {
            throw new InvalidDataException("document-export-frozen-embed-source-context-mismatch");
        }
        RequireSelector(input.Coordinate, selector);
        DocumentExportFrozenInput ownedInput = DocumentExportContractValidator.Seal(input);
        DocumentExportContractValidator.Validate(ownedInput);
        await RequireAuthorizationAsync(actor, ownedInput.Coordinate, cancellationToken).ConfigureAwait(false);

        RevisionComparePackageReadResult read = await sourceReader.ReadAuthorizedAsync(
            context, checked((int)ownedInput.Coordinate.ArticleId), selector, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (read.Status != RevisionComparePackageReadStatus.Available || read.Package is null)
        {
            throw new InvalidDataException("document-export-frozen-embed-source-unavailable");
        }
        RevisionComparePackage package = OwnPackage(read.Package);
        if (package.ArticleId != ownedInput.Coordinate.ArticleId
            || package.SourceKind != selector.Kind
            || package.RevisionId != selector.RevisionId
            || package.ServerRevision != selector.ExpectedServerRevision
            || package.DocumentEpoch != selector.DocumentEpoch
            || (selector.ExpectedSourceDigest is not null && selector.ExpectedSourceDigest != package.SourceDigest)
            || !package.RawMarkdown.AsSpan().SequenceEqual(ownedInput.MarkdownUtf8.AsSpan()))
        {
            throw new InvalidDataException("document-export-frozen-embed-source-package-mismatch");
        }

        DocumentExportFrozenEmbedPublicationSource stored = await publicationReader.ReadAsync(
            actor, ownedInput.Coordinate, package, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidDataException("document-export-frozen-embed-publication-unavailable");
        cancellationToken.ThrowIfCancellationRequested();
        DocumentExportFrozenEmbedPublicationSource publication = OwnPublication(stored);
        if (publication.UserId != actor.UserId
            || publication.SiteScope != actor.SiteScope
            || publication.Coordinate != ownedInput.Coordinate
            || publication.SourcePackageDigest != package.PackageDigest
            || publication.SourceDocumentEpoch != package.DocumentEpoch
            || publication.HostPortableArticleIdentity != publication.Authority.HostPortableArticleIdentity
            || publication.HostDocument != publication.Authority.HostDocument)
        {
            throw new InvalidDataException("document-export-frozen-embed-publication-binding-mismatch");
        }
        if (!ArticleEmbedPublicationVerifier.Verify(
            publication.Requests, publication.Authority, publication.Budgets, publication.Plan).Valid
            || !ArticleEmbedRelationVerifier.VerifyFromPlan(
                publication.Requests, publication.Authority, publication.Budgets,
                publication.Plan, publication.Derivation).Valid)
        {
            throw new InvalidDataException("document-export-frozen-embed-publication-verification-failed");
        }
        ArticleEmbedValidationResult projected = ArticleEmbedFrozenDependencyProjection.Project(
            publication.ExpectedPlanDigest, publication.Plan, publication.Derivation,
            out ImmutableArray<ArticleEmbedDependencyReceipt> dependencies);
        if (!projected.IsValid || dependencies.IsEmpty)
        {
            throw new InvalidDataException("document-export-frozen-embed-publication-incomplete");
        }

        long totalBytes = ownedInput.MarkdownUtf8.Length;
        var projections = ImmutableArray.CreateBuilder<DocumentExportFrozenEmbedProjection>(dependencies.Length);
        foreach (ArticleEmbedDependencyReceipt dependency in dependencies)
        {
            cancellationToken.ThrowIfCancellationRequested();
            DocumentExportFrozenEmbedProjection projection = await projectionReader.ReadAsync(
                actor, dependency, cancellationToken).ConfigureAwait(false)
                ?? throw new InvalidDataException("document-export-frozen-embed-projection-missing");
            cancellationToken.ThrowIfCancellationRequested();
            if (projection.Dependency != dependency || projection.Bytes.IsDefaultOrEmpty)
            {
                throw new InvalidDataException("document-export-frozen-embed-projection-binding-mismatch");
            }
            totalBytes = checked(totalBytes + projection.Bytes.Length);
            if (totalBytes > MaximumInputBytes)
            {
                throw new InvalidDataException("document-export-frozen-embed-input-budget");
            }
            DocumentExportFrozenEmbedProjection owned = projection with
            {
                Bytes = projection.Bytes.AsSpan().ToArray().ToImmutableArray()
            };
            // Preserve the reader's byte seal and original content digest. Neither
            // is recomputed to hide drift before the independent codec verifier.
            if (owned.Projection is null
                || !Enum.IsDefined(owned.Projection.Kind)
                || owned.Projection.ProjectionIdentity != dependency.Coordinate.ProjectionIdentity
                || owned.Projection.ContentDigest != dependency.Coordinate.ProjectionDigest
                || owned.ByteDigest != DocumentExportDigest.ComputeBytes(owned.Bytes.AsSpan()))
            {
                throw new InvalidDataException("document-export-frozen-embed-projection-binding-mismatch");
            }
            await projectionVerifier.VerifyAsync(actor, publication, owned, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            projections.Add(owned);
        }
        await RequireAuthorizationAsync(actor, ownedInput.Coordinate, cancellationToken).ConfigureAwait(false);
        DocumentExportFrozenInput frozen = DocumentExportContractValidator.Seal(ownedInput with
        {
            FrozenEmbeds = new DocumentExportFrozenEmbeds(publication.ExpectedPlanDigest,
                publication.Plan, publication.Derivation, projections.MoveToImmutable())
        });
        DocumentExportContractValidator.Validate(frozen);
        return frozen;
    }

    private async ValueTask RequireAuthorizationAsync(
        DocumentExportJobActor actor, DocumentExportArticleCoordinate coordinate, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!await authorization.IsAllowedAsync(actor, coordinate, DocumentExportJobOperation.Create,
            cancellationToken).ConfigureAwait(false))
        {
            throw new UnauthorizedAccessException("document-export-frozen-embed-source-forbidden");
        }
        cancellationToken.ThrowIfCancellationRequested();
    }

    private static void RequireSelector(DocumentExportArticleCoordinate coordinate, RevisionCompareSourceSelector selector)
    {
        bool valid = coordinate.ArticleId <= int.MaxValue && (coordinate.Kind switch
        {
            DocumentExportCoordinateKind.Draft => selector.Kind == RevisionCompareSourceKind.CurrentDraft
                && selector.DraftKey == coordinate.DraftKey && selector.ExpectedServerRevision == coordinate.SourceVersion
                && selector.RevisionId is null && !string.IsNullOrWhiteSpace(selector.DocumentEpoch),
            DocumentExportCoordinateKind.Revision => selector.Kind is RevisionCompareSourceKind.CurrentRevision
                or RevisionCompareSourceKind.HistoricalRevision && selector.RevisionId == coordinate.RevisionId
                && selector.DraftKey is null && selector.ExpectedServerRevision is null,
            _ => false
        });
        if (!valid)
        {
            throw new InvalidDataException("document-export-frozen-embed-source-selector-mismatch");
        }
    }

    private static RevisionComparePackage OwnPackage(RevisionComparePackage package)
    {
        if (!RevisionComparePackageSeal.Verify(package))
        {
            throw new InvalidDataException("document-export-frozen-embed-source-package-invalid");
        }
        RevisionComparePackage owned = RevisionComparePackageSeal.Create(package.ArticleId, package.SourceKind,
            package.SourceIdentity, package.RevisionId, package.RevisionNo, package.ServerRevision,
            package.DocumentEpoch, package.RawMarkdown.AsSpan(), package.Metadata.ToArray(),
            package.Snapshots.Select(snapshot => snapshot.State switch
            {
                RevisionCompareSnapshotState.Present => RevisionCompareSnapshot.Present(
                    snapshot.Kind, snapshot.Reference!, snapshot.SchemaVersion, snapshot.Payload.AsSpan()),
                RevisionCompareSnapshotState.NotApplicable => RevisionCompareSnapshot.NotApplicable(snapshot.Kind),
                _ => RevisionCompareSnapshot.Missing(snapshot.Kind)
            }));
        if (owned.PackageDigest != package.PackageDigest)
        {
            throw new InvalidDataException("document-export-frozen-embed-source-package-drifted");
        }
        return owned;
    }

    private static DocumentExportFrozenEmbedPublicationSource OwnPublication(DocumentExportFrozenEmbedPublicationSource source)
    {
        // Bound the complete collection closure before making owned copies or
        // invoking verifiers. A malicious reader cannot allocate an unbounded graph.
        long count = 0;
        IReadOnlyList<T> Copy<T>(IReadOnlyList<T>? items)
        {
            if (items is null || items.Count > ArticleEmbedResolutionBudgetLimits.AuthorityMessagesBound
                || (count = checked(count + items.Count)) > ArticleEmbedResolutionBudgetLimits.AuthorityMessagesBound)
            {
                throw new InvalidDataException("document-export-frozen-embed-publication-budget");
            }
            var owned = new T[items.Count];
            for (int index = 0; index < owned.Length; index++)
            {
                owned[index] = items[index];
            }
            if (owned.Any(item => item is null))
            {
                throw new InvalidDataException("document-export-frozen-embed-publication-incomplete");
            }
            return Array.AsReadOnly(owned);
        }
        if (source.Authority is null || source.Plan?.Receipt is null || source.Derivation?.EdgeSet is null)
        {
            throw new InvalidDataException("document-export-frozen-embed-publication-incomplete");
        }
        IReadOnlyList<ArticleEmbedProviderRequest> requests = Copy(source.Requests);
        IReadOnlyList<ArticleEmbedPublicationTargetFacts> targets = Copy(source.Authority.Targets)
            .Select(target => target with
            {
                Headings = Copy(target.Headings),
                Blocks = Copy(target.Blocks),
                NestedDirectives = Copy(target.NestedDirectives)
            }).ToArray();
        return source with
        {
            Requests = requests,
            Authority = source.Authority with
            {
                Targets = Array.AsReadOnly(targets.ToArray())
            },
            Plan = source.Plan with
            {
                Edges = Copy(source.Plan.Edges),
                Receipt = source.Plan.Receipt with
                {
                    Items = Copy(source.Plan.Receipt.Items)
                }
            },
            Derivation = source.Derivation with
            {
                EdgeSet = source.Derivation.EdgeSet with
                {
                    Edges = Copy(source.Derivation.EdgeSet.Edges)
                },
                DependencyReceipts = Copy(source.Derivation.DependencyReceipts)
            }
        };
    }
}
