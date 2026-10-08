using System.Collections.Immutable;

using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Publication;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Relations;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Retains the complete opaque public projection bytes alongside the existing
/// dependency receipt. ByteDigest seals retained bytes; it does not replace the
/// renderer-owned projection ContentDigest or establish its encoding authority.
/// </summary>
public sealed record DocumentExportFrozenEmbedProjection(
    ArticleEmbedDependencyReceipt Dependency,
    ArticleEmbedSafeProjectionReference Projection,
    ImmutableArray<byte> Bytes,
    string ByteDigest);

/// <summary>
/// Persistent export snapshot of a canonical frozen publication. ExpectedPlanDigest
/// comes from the authorized stored plan, independently of the supplied candidate.
/// Imports must resolve targets again through the existing authoring authority;
/// this export snapshot never grants current target access or authoring permission.
/// </summary>
public sealed record DocumentExportFrozenEmbeds(
    string ExpectedPlanDigest,
    ArticleEmbedPublicationPlan Plan,
    ArticleEmbedRelationDerivation Derivation,
    ImmutableArray<DocumentExportFrozenEmbedProjection> Projections);

internal static class DocumentExportFrozenEmbedContract
{
    private const long MaximumBytes = 32L * 1024 * 1024;

    internal static DocumentExportFrozenEmbeds? Own(DocumentExportFrozenEmbeds? embeds)
    {
        if (embeds is null)
        {
            return null;
        }
        Validate(embeds, sourceBytes: 0);
        return embeds with
        {
            Plan = embeds.Plan with
            {
                Edges = embeds.Plan.Edges.ToArray().ToImmutableArray(),
                Receipt = embeds.Plan.Receipt with
                {
                    Items = embeds.Plan.Receipt.Items.ToArray().ToImmutableArray()
                }
            },
            Derivation = embeds.Derivation with
            {
                EdgeSet = embeds.Derivation.EdgeSet! with
                {
                    Edges = embeds.Derivation.EdgeSet!.Edges.ToArray().ToImmutableArray()
                },
                DependencyReceipts = embeds.Derivation.DependencyReceipts.ToArray().ToImmutableArray()
            },
            Projections = embeds.Projections.Select(projection => projection with
            {
                Bytes = projection.Bytes.AsSpan().ToArray().ToImmutableArray()
            }).ToImmutableArray()
        };
    }

    internal static void Validate(DocumentExportFrozenEmbeds? embeds, long sourceBytes)
    {
        if (embeds is null)
        {
            return;
        }
        ArticleEmbedValidationResult projected = ArticleEmbedFrozenDependencyProjection.Project(
            embeds.ExpectedPlanDigest, embeds.Plan, embeds.Derivation,
            out ImmutableArray<ArticleEmbedDependencyReceipt> dependencies);
        if (!projected.IsValid)
        {
            throw new InvalidDataException(projected.ReasonCode);
        }
        if (embeds.Projections.IsDefault
            || embeds.Projections.Length == 0
            || embeds.Projections.Length != dependencies.Length)
        {
            throw new InvalidDataException("document-export-frozen-embed-retention-incomplete");
        }
        long totalBytes = sourceBytes;
        for (int index = 0; index < dependencies.Length; index++)
        {
            DocumentExportFrozenEmbedProjection projection = embeds.Projections[index]
                ?? throw new InvalidDataException("document-export-frozen-embed-projection-missing");
            ArticleEmbedDependencyReceipt expected = dependencies[index];
            if (projection.Dependency != expected
                || projection.Projection is null
                || !Enum.IsDefined(projection.Projection.Kind)
                || projection.Projection.ProjectionIdentity != expected.Coordinate.ProjectionIdentity
                || projection.Projection.ContentDigest != expected.Coordinate.ProjectionDigest)
            {
                throw new InvalidDataException("document-export-frozen-embed-projection-binding-mismatch");
            }
            if (projection.Bytes.IsDefaultOrEmpty
                || projection.ByteDigest != DocumentExportDigest.ComputeBytes(projection.Bytes.AsSpan()))
            {
                throw new InvalidDataException("document-export-frozen-embed-bytes-missing-or-drifted");
            }
            totalBytes = checked(totalBytes + projection.Bytes.Length);
            if (totalBytes > MaximumBytes)
            {
                throw new InvalidDataException("document-export-frozen-embed-input-budget");
            }
        }
    }

    internal static void RequireMaterializer(DocumentExportFrozenEmbeds? embeds)
    {
        if (embeds is not null)
        {
            // A byte seal cannot prove the upstream projection codec, retention
            // authority or numeric-to-portable host binding. No format can render
            // this snapshot until the canonical materializer is actually connected.
            throw new InvalidOperationException("document-export-frozen-embed-materializer-unavailable");
        }
    }
}
