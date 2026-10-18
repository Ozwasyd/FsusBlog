using System.Collections.Immutable;
using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;

using FsusBlog.Contracts.Articles;
using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

// Explicit process-owned input/output selections, not backup authentication or a grant.
// The Host must retain the original artifact, URL/root/run selections and output scope;
// neither a sealed plan nor current database rows can supply historical source inputs.
internal sealed record ArticlePreservationProducerInputs(
    CurrentSchemaArtifactReference OriginArtifact, Uri DocumentBase, string OutputDirectory,
    long MaximumOriginBytes, string PublicationTransitionKind, string RevisionDiffSummary);

/// <summary>
/// Publishes the original article source and current-owner policy/graph artifacts from one
/// caller-owned historical snapshot. It owns no connection, transaction, journal or commit.
/// Published files alone do not authorize apply, and an interrupted publication may leave
/// task-owned artifacts that have no admitted plan or committed-journal provenance.
/// </summary>
internal sealed class ArticlePreservationProducer
{
    private readonly OwnedCurrentSchemaTarget _target;
    private readonly OwnedRetainedMigrationTool _tool;
    private readonly ArticlePreservationProducerInputs _inputs;
    private readonly PgArticlePreservationMediaConfiguration _media;
    private readonly PgArticlePreservationRecoveryConfiguration _recovery;

    private ArticlePreservationProducer(OwnedCurrentSchemaTarget target, OwnedRetainedMigrationTool tool,
        ArticlePreservationProducerInputs inputs, PgArticlePreservationMediaConfiguration media,
        PgArticlePreservationRecoveryConfiguration recovery, ArticlePreservationSourceExport source,
        ArticlePreservationCurrentExport current, OfflineMigrationSourceObservation observation)
    {
        _target = target;
        _tool = tool;
        _inputs = inputs;
        _media = media;
        _recovery = recovery;
        Source = source;
        Current = current;
        Observation = observation;
    }

    internal ArticlePreservationSourceExport Source
    {
        get;
    }
    internal ArticlePreservationCurrentExport Current
    {
        get;
    }
    internal OfflineMigrationSourceObservation Observation
    {
        get;
    }

    /// <summary>Captures, validates and publishes a complete source/current artifact set.</summary>
    /// <remarks>
    /// This component can publish PostgreSQL inputs without claiming the missing other
    /// provider operations. The whole-route entry below requires their actual owners before
    /// any publication. Planning uses the original strict reader, not the apply-only reader.
    /// </remarks>
    internal static async Task<ArticlePreservationProducer> PublishAsync(
        ArticlePreservationProducerInputs inputs, OwnedCurrentSchemaTarget target, OwnedRetainedMigrationTool tool,
        PgArticlePreservationMediaConfiguration media, PgArticlePreservationRecoveryConfiguration recovery,
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        RequireInputs(inputs);
        ArgumentNullException.ThrowIfNull(target);
        ArgumentNullException.ThrowIfNull(tool);
        PgArticlePreservationOperation.RequireConfiguration(media);
        PgArticlePreservationOperation.RequireRecoveryConfiguration(recovery);
        if (!ReferenceEquals(recovery.Tool, tool))
            throw new InvalidOperationException("article_preservation_producer_original_tool_changed");
        if (inputs.DocumentBase.Scheme != media.TrustedSiteOrigin.Scheme
            || inputs.DocumentBase.IdnHost != media.TrustedSiteOrigin.IdnHost
            || inputs.DocumentBase.Port != media.TrustedSiteOrigin.Port)
            throw new InvalidOperationException("article_preservation_producer_original_site_origin_changed");
        RequireSeparateOutput(inputs.OutputDirectory, media.SourceAssetRoot, media.TargetParent);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(media.WriteLimits.OperationBudget);
        cancellationToken = deadline.Token;
        ArticlePreservationStorageWriter.RequireSession(connection, transaction);
        OfflineMigrationSourceObserver.RequirePostgreSqlStageSession(connection, transaction);
        CurrentSchemaVerifierIdentity actualTool = await tool.RevalidateAsync(cancellationToken).ConfigureAwait(false);
        await target.RevalidateRetainedArtifactAsync(cancellationToken).ConfigureAwait(false);
        await RequireOriginAsync(inputs, cancellationToken).ConfigureAwait(false);
        var observer = new OfflineMigrationSourceObserver();
        ArticlePreservationSourceReadResult read = await ArticlePreservationSourceReader.ReadAsync(
            CurrentSchemaProviderKind.PostgreSql, connection, transaction, observer, inputs.OriginArtifact,
            inputs.DocumentBase, media.ProjectionLimits, media.SourceReadBudget, cancellationToken).ConfigureAwait(false);

        // Allocate only deterministic new storage coordinates. Business defaults come from
        // the sole current policy exporter; audit text/transition identity remain explicit
        // selections of the current owner, not invented historical administrator approvals.
        ArticlePreservationSourceExport source = ArticlePreservationPolicyExporter.PrepareSource(
            read, Output(inputs, "source.json"), cancellationToken);
        ArticlePreservationDefaultPolicyExport policy = ArticlePreservationPolicyExporter.PrepareDefaultPolicy(
            source, Output(inputs, "policy.json"), cancellationToken);
        ImmutableArray<ArticlePreservationTaxonomyMap> categories = PreserveTaxonomy(read.Data.Categories);
        ImmutableArray<ArticlePreservationTaxonomyMap> tags = PreserveTaxonomy(read.Data.Tags);
        ImmutableArray<ArticlePreservationCurrentPackage> packages = PreparePackages(
            source, policy, categories, tags, inputs, cancellationToken);
        ArticlePreservationCurrentExport current = ArticlePreservationPolicyExporter.PrepareCurrentExport(
            source, policy, categories, tags, packages, Output(inputs, "current.json"), cancellationToken);
        if (source.Bytes.Length > media.WriteLimits.MaximumArtifactBytes || current.Bytes.Length > media.WriteLimits.MaximumArtifactBytes
            || policy.Bytes.Length > media.WriteLimits.MaximumArtifactBytes
            || packages.Any(package => package.Bytes.Length > media.WriteLimits.MaximumArtifactBytes))
            throw new InvalidOperationException("article_preservation_producer_artifact_byte_budget");
        ArticleMediaInventory inventory = await ArticleMediaPreservation.InventoryAsync(
            Documents(source, cancellationToken), media.SourceAssetRoot, media.TrustedSiteOrigin,
            media.PublicPathPrefix, media.MediaLimits, cancellationToken).ConfigureAwait(false);
        ArticlePreservationWritePlan projection = ArticlePreservationProjection.Project(
            source, current, inventory, media.ProjectionLimits, media.MediaLimits, cancellationToken);
        ArticlePreservationStorageProgram program = ArticlePreservationStorageProgram.Compile(projection, target, cancellationToken);
        ArticlePreservationStorageWriter.RequireRows(program.Rows, media.WriteLimits);
        await RequireOriginalAsync(inputs, read.Observation, observer, tool, actualTool,
            connection, transaction, cancellationToken).ConfigureAwait(false);

        source = await ArticlePreservationPolicyExporter.PublishSourceAsync(
            read, source.Artifact.Reference, cancellationToken).ConfigureAwait(false);
        policy = await ArticlePreservationPolicyExporter.PublishDefaultPolicyAsync(
            source, policy.Artifact.Reference, cancellationToken).ConfigureAwait(false);
        var published = ImmutableArray.CreateBuilder<ArticlePreservationCurrentPackage>(packages.Length);
        Dictionary<int, LegacyArticlePreservationRow> rows = source.Data.Articles.ToDictionary(static row => row.Id);
        foreach (ArticlePreservationCurrentPackage package in packages)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticlePreservationCurrentData data = package.Data;
            ArticlePreservationCurrentPackage actual = await ArticlePreservationPolicyExporter.PublishCurrentPackageAsync(
                source, rows[data.SourceArticleId], policy, data.Article.CategoryId, data.Article.TagIds.ToImmutableArray(),
                data.Coordinates, package.Artifact.Reference, cancellationToken).ConfigureAwait(false);
            if (!actual.Bytes.AsSpan().SequenceEqual(package.Bytes.AsSpan()))
                throw new InvalidOperationException("article_preservation_producer_package_changed");
            published.Add(actual);
        }
        current = await ArticlePreservationPolicyExporter.PublishCurrentExportAsync(
            source, policy, categories, tags, published.MoveToImmutable(), current.Artifact.Reference,
            cancellationToken).ConfigureAwait(false);
        await RequirePublishedAsync(source, current, media.WriteLimits.MaximumArtifactBytes,
            cancellationToken).ConfigureAwait(false);
        await target.RevalidateRetainedArtifactAsync(cancellationToken).ConfigureAwait(false);
        await RequireOriginalAsync(inputs, read.Observation, observer, tool, actualTool,
            connection, transaction, cancellationToken).ConfigureAwait(false);
        return new(target, tool, inputs, media, recovery, source, current, read.Observation);
    }

    /// <summary>Publishes and matches the actual complete compiled provider route.</summary>
    internal static async Task<OfflineMigrationArticlePreservationRoute> CreateMatchedRouteAsync(
        ArticlePreservationProducerInputs inputs, OwnedCurrentSchemaTarget target, OwnedRetainedMigrationTool tool,
        PgArticlePreservationMediaConfiguration media, PgArticlePreservationRecoveryConfiguration recovery,
        ImmutableArray<OfflineMigrationApplyOperation> otherProviderOwners, DbConnection connection,
        DbTransaction transaction, CancellationToken cancellationToken)
    {
        RequireProviderOwners(otherProviderOwners);
        ArticlePreservationProducer producer = await PublishAsync(inputs, target, tool, media, recovery,
            connection, transaction, cancellationToken).ConfigureAwait(false);
        return await producer.CreateMatchedRouteAsync(otherProviderOwners, connection, transaction,
            cancellationToken).ConfigureAwait(false);
    }

    internal async Task<OfflineMigrationArticlePreservationRoute> CreateMatchedRouteAsync(
        ImmutableArray<OfflineMigrationApplyOperation> otherProviderOwners, DbConnection connection,
        DbTransaction transaction, CancellationToken cancellationToken)
    {
        RequireProviderOwners(otherProviderOwners);
        ArticlePreservationStorageWriter.RequireSession(connection, transaction);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(_media.WriteLimits.OperationBudget);
        cancellationToken = deadline.Token;
        CurrentSchemaVerifierIdentity actualTool = await _tool.RevalidateAsync(cancellationToken).ConfigureAwait(false);
        var observer = new OfflineMigrationSourceObserver();
        await RequireOriginalAsync(_inputs, Observation, observer, _tool, actualTool,
            connection, transaction, cancellationToken).ConfigureAwait(false);
        await RequirePublishedAsync(Source, Current, _media.WriteLimits.MaximumArtifactBytes,
            cancellationToken).ConfigureAwait(false);
        OfflineMigrationArticlePreservationRoute route = await OfflineMigrationArticlePreservationRoute.CreateFromDescriptorsAsync(
            Source.Artifact, Current.Artifact, _target, _tool, _media, _recovery, otherProviderOwners,
            cancellationToken).ConfigureAwait(false);
        OfflineMigrationSourceObservation actual = await observer.ObserveAsync(CurrentSchemaProviderKind.PostgreSql,
            connection, transaction, cancellationToken).ConfigureAwait(false);
        PgLegacyCurrentSchemaPreparation.RequireUnchangedSource(Observation, actual);
        OfflineMigrationSourceRouteSelection selection = route.MatchSource(actual, cancellationToken);
        if (!ReferenceEquals(selection.Dag, route.Dag))
            throw new InvalidOperationException("article_preservation_producer_route_changed");
        await RequireOriginalAsync(_inputs, Observation, observer, _tool, actualTool,
            connection, transaction, cancellationToken).ConfigureAwait(false);
        await RequirePublishedAsync(Source, Current, _media.WriteLimits.MaximumArtifactBytes,
            cancellationToken).ConfigureAwait(false);
        return route;
    }

    internal static void RequireProviderOwners(ImmutableArray<OfflineMigrationApplyOperation> owners)
    {
        if (owners.IsDefault || owners.Any(static owner => owner is null))
            throw new InvalidOperationException("article_preservation_producer_actual_provider_owners_missing");
        OfflineMigrationPlanValidation.RequireProviders(new[] { CurrentSchemaProviderKind.PostgreSql }
            .Concat(owners.Select(static owner => owner.Identity.Provider)));
    }

    internal static ImmutableArray<ArticlePreservationTaxonomyMap> PreserveTaxonomy(
        ImmutableArray<LegacyArticlePreservationTaxonomy> source)
    {
        if (source.IsDefault || source.Any(static row => row is null || row.Id <= 0 || string.IsNullOrWhiteSpace(row.Name))
            || source.Select(static row => row.Id).Distinct().Count() != source.Length
            || source.Select(static row => row.Name).Distinct(StringComparer.Ordinal).Count() != source.Length)
            throw new InvalidOperationException("article_preservation_producer_taxonomy_identity_conflict");
        return source.OrderBy(static row => row.Id).Select(static row => new ArticlePreservationTaxonomyMap(
            row.Id, row.Name, row.Id, row.Name)).ToImmutableArray();
    }

    internal static ImmutableArray<ArticlePreservationCurrentPackage> PreparePackages(
        ArticlePreservationSourceExport source, ArticlePreservationDefaultPolicyExport policy,
        ImmutableArray<ArticlePreservationTaxonomyMap> categories, ImmutableArray<ArticlePreservationTaxonomyMap> tags,
        ArticlePreservationProducerInputs inputs, CancellationToken cancellationToken)
    {
        RequireInputs(inputs);
        ArticlePreservationPolicyExporter.RequireDefaultPolicy(source, policy);
        var categoryIds = categories.ToDictionary(static map => map.SourceId, static map => map.TargetId);
        var tagIds = tags.ToDictionary(static map => map.SourceId, static map => map.TargetId);
        var blockIds = new Dictionary<string, long>(StringComparer.Ordinal);
        var articleIds = new HashSet<int>();
        var packages = ImmutableArray.CreateBuilder<ArticlePreservationCurrentPackage>(source.Data.Articles.Length);
        foreach (LegacyArticlePreservationRow row in source.Data.Articles.OrderBy(static row => row.Id))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (row.Id <= 0 || !articleIds.Add(row.Id) || row.Markdown is null || row.TagIds.IsDefault
                || row.TagIds.Distinct().Count() != row.TagIds.Length || !categoryIds.TryGetValue(row.CategoryId, out int category))
                throw new InvalidOperationException("article_preservation_producer_source_graph_incomplete");
            ImmutableArray<int> mappedTags = row.TagIds.Select(id => tagIds.TryGetValue(id, out int target) ? target
                : throw new InvalidOperationException("article_preservation_producer_source_graph_incomplete")).Order().ToImmutableArray();
            if (!blockIds.TryGetValue(row.Markdown, out long blockId))
                blockIds.Add(row.Markdown, blockId = row.Id);
            var coordinates = new ArticlePreservationGraphCoordinates(blockId, row.Id, row.Id, row.Id,
                policy.Data.ResponsibilityVersion, row.Id, 1, policy.Data.RevisionCreatorId,
                inputs.RevisionDiffSummary, inputs.PublicationTransitionKind, row.CreateTime);
            packages.Add(ArticlePreservationPolicyExporter.PrepareCurrentPackage(source, row, policy, category,
                mappedTags, coordinates, Output(inputs, "article-" + row.Id.ToString(CultureInfo.InvariantCulture) + ".json"),
                cancellationToken));
        }
        return packages.MoveToImmutable();
    }

    internal static void RequireInputs(ArticlePreservationProducerInputs inputs)
    {
        ArgumentNullException.ThrowIfNull(inputs);
        if (inputs.OriginArtifact is null || !ArticlePreservationSemanticReceipt.IsDigest(inputs.OriginArtifact.Sha256)
            || inputs.MaximumOriginBytes <= 0 || inputs.DocumentBase is null || !inputs.DocumentBase.IsAbsoluteUri
            || inputs.DocumentBase.Scheme is not ("http" or "https") || inputs.DocumentBase.UserInfo.Length != 0
            || string.IsNullOrWhiteSpace(inputs.PublicationTransitionKind) || inputs.PublicationTransitionKind.Any(char.IsControl)
            || string.IsNullOrWhiteSpace(inputs.RevisionDiffSummary) || inputs.RevisionDiffSummary.Any(char.IsControl))
            throw new InvalidOperationException("article_preservation_producer_original_inputs_required");
        RequirePath(inputs.OriginArtifact.Reference);
        RequirePath(inputs.OutputDirectory);
    }

    private static string Output(ArticlePreservationProducerInputs inputs, string file)
        => Path.Combine(inputs.OutputDirectory, file);

    internal static void RequireSeparateOutput(string output, string sourceRoot, string targetRoot)
    {
        RequirePath(output);
        foreach (string root in new[] { sourceRoot, targetRoot })
        {
            RequirePath(root);
            if (output == root || output.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal)
                || root.StartsWith(output + Path.DirectorySeparatorChar, StringComparison.Ordinal))
                throw new InvalidOperationException("article_preservation_producer_output_media_overlap");
        }
        // The original publisher owns no-replace files. This rejects an already
        // redirected output scope; it is not an atomic directory lease guarantee.
        for (DirectoryInfo? directory = new(output); directory is not null; directory = directory.Parent)
            if (!directory.Exists || directory.LinkTarget is not null)
                throw new InvalidOperationException("article_preservation_producer_owned_output_directory_required");
    }

    private static void RequirePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path) || Path.GetFullPath(path) != path
            || Path.GetPathRoot(path) == path || path.Any(char.IsControl)
            || path.Split('/', '\\').Any(static component => component.Equals("latest", StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("article_preservation_producer_original_path_required");
    }

    private static async Task RequireOriginAsync(ArticlePreservationProducerInputs inputs, CancellationToken token)
    {
        using var handle = OfflineMigrationCurrentSchemaArtifactReader.OpenOriginalRegularFile(inputs.OriginArtifact.Reference, token);
        var initial = OfflineMigrationCurrentSchemaArtifactReader.CaptureOriginalRegularFileIdentity(
            inputs.OriginArtifact.Reference, handle, token);
        var stream = new FileStream(handle, FileAccess.Read, 4096);
        _ = await PgArticlePreservationOperation.PreserveFirstAsync(stream, async () =>
        {
            if (stream.Length <= 0 || stream.Length > inputs.MaximumOriginBytes)
                throw new InvalidOperationException("article_preservation_producer_original_byte_budget");
            long length = stream.Length;
            string digest = Convert.ToHexStringLower(await SHA256.HashDataAsync(stream, token).ConfigureAwait(false));
            if (stream.Position != length || digest != inputs.OriginArtifact.Sha256)
                throw new InvalidOperationException("article_preservation_producer_original_artifact_changed");
            OfflineMigrationCurrentSchemaArtifactReader.ValidateOriginalRegularFileUnchanged(
                inputs.OriginArtifact.Reference, handle, initial, token);
            return digest;
        }).ConfigureAwait(false);
    }

    private static async Task RequirePublishedAsync(ArticlePreservationSourceExport source,
        ArticlePreservationCurrentExport current, long maximumBytes, CancellationToken token)
    {
        async Task Require(CurrentSchemaArtifactReference reference, ImmutableArray<byte> expected)
        {
            ImmutableArray<byte> actual = await PgArticlePreservationOperation.ReadArtifactAsync(reference,
                maximumBytes, token).ConfigureAwait(false);
            if (!actual.AsSpan().SequenceEqual(expected.AsSpan()))
                throw new InvalidOperationException("article_preservation_producer_published_artifact_changed");
        }
        await Require(source.Artifact, source.Bytes).ConfigureAwait(false);
        await Require(current.Artifact, current.Bytes).ConfigureAwait(false);
        ArticlePreservationDefaultPolicyExport policy = current.DefaultPolicy
            ?? throw new InvalidOperationException("article_preservation_producer_current_policy_missing");
        await Require(policy.Artifact, policy.Bytes).ConfigureAwait(false);
        foreach (ArticlePreservationCurrentPackage package in current.Articles)
            await Require(package.Artifact, package.Bytes).ConfigureAwait(false);
    }

    private static async Task RequireOriginalAsync(ArticlePreservationProducerInputs inputs,
        OfflineMigrationSourceObservation expected, OfflineMigrationSourceObserver observer,
        OwnedRetainedMigrationTool tool, CurrentSchemaVerifierIdentity actualTool,
        DbConnection connection, DbTransaction transaction, CancellationToken token)
    {
        await RequireOriginAsync(inputs, token).ConfigureAwait(false);
        OfflineMigrationSourceObservation actual = await observer.ObserveAsync(CurrentSchemaProviderKind.PostgreSql,
            connection, transaction, token).ConfigureAwait(false);
        PgLegacyCurrentSchemaPreparation.RequireUnchangedSource(expected, actual);
        if (await tool.RevalidateAsync(token).ConfigureAwait(false) != actualTool)
            throw new InvalidOperationException("article_preservation_producer_original_tool_changed");
    }

    private static async IAsyncEnumerable<ArticleMediaSource> Documents(ArticlePreservationSourceExport source,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken token)
    {
        foreach (LegacyArticlePreservationRow row in source.Data.Articles.OrderBy(static row => row.Id))
        {
            token.ThrowIfCancellationRequested();
            yield return new(row.Id, null, row.Markdown!, source.Data.DocumentBase);
        }
        await Task.CompletedTask.ConfigureAwait(false);
    }
}
