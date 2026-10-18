using System.Collections.Immutable;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

// A selection from the original registry and actual compiled closure, not an
// execution/source admission. Native source and journal revalidation remain in Core.
internal sealed record OfflineMigrationSourceRouteSelection(
    OfflineMigrationFingerprintDefinition Fingerprint,
    OfflineMigrationDag Dag,
    ImmutableArray<OfflineMigrationStep> OrderedSteps);

internal interface IOfflineMigrationMatchedSourceRoute
{
    OfflineMigrationSourceRouteSelection MatchSource(OfflineMigrationSourceObservation source, CancellationToken cancellationToken);
}

// The Host retains this process-owned route. Neither CLI steps nor plan JSON can
// fill an absent provider owner, substitute a fingerprint or register executable SQL.
internal sealed class OfflineMigrationArticlePreservationRoute :
    IOfflineMigrationMatchedSourceRoute, IOfflineMigrationApplyOperationRegistry
{
    private readonly PgArticlePreservationOperation _article;
    private readonly IOfflineMigrationApplyOperationRegistry _otherOwners;
    private readonly OfflineMigrationSourceRegistry _sources;

    private OfflineMigrationArticlePreservationRoute(PgArticlePreservationOperation article,
        OfflineMigrationDag dag, IOfflineMigrationApplyOperationRegistry otherOwners)
    {
        _article = article;
        _otherOwners = otherOwners;
        _sources = OfflineMigrationSourceFingerprints.CreateRegistry();
        Dag = dag;
    }

    internal OfflineMigrationDag Dag
    {
        get;
    }
    internal PgArticlePreservationOperation ArticleOperation => _article;

    // The concrete single-transaction legacy node obtains identities from actual
    // descriptor instances. Missing MySQL/SQLite bodies are not invented from PG.
    internal static async Task<OfflineMigrationArticlePreservationRoute> CreateFromDescriptorsAsync(
        CurrentSchemaArtifactReference sourceArtifact, CurrentSchemaArtifactReference currentArtifact,
        OwnedCurrentSchemaTarget target, OwnedRetainedMigrationTool retainedTool,
        PgArticlePreservationMediaConfiguration configuration,
        PgArticlePreservationRecoveryConfiguration recoveryConfiguration,
        ImmutableArray<OfflineMigrationApplyOperation> otherProviderOwners, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(retainedTool);
        if (otherProviderOwners.IsDefault || otherProviderOwners.Any(owner => owner is null))
            throw new InvalidOperationException("article_preservation_route_actual_provider_owners_missing");
        OfflineMigrationPlanValidation.RequireProviders(new[] { CurrentSchemaProviderKind.PostgreSql }
            .Concat(otherProviderOwners.Select(owner => owner.Identity.Provider)));
        CurrentSchemaVerifierIdentity actualTool = await retainedTool.RevalidateAsync(cancellationToken).ConfigureAwait(false);
        PgArticlePreservationOperation article = await PgArticlePreservationOperation.CreateAsync(
            sourceArtifact, currentArtifact, target, actualTool, configuration, cancellationToken).ConfigureAwait(false);
        await article.BindRecoveryOwnerAsync(recoveryConfiguration, cancellationToken).ConfigureAwait(false);
        ImmutableArray<OfflineMigrationApplyOperation> actualOwners = [article, .. otherProviderOwners];
        var (dag, registry) = BuildDeclaredDag(article.Step, actualOwners, cancellationToken);
        OfflineMigrationArticlePreservationRoute route = Create(article, dag, registry, retainedTool, cancellationToken);
        if (await retainedTool.RevalidateAsync(cancellationToken).ConfigureAwait(false) != actualTool)
            throw new InvalidOperationException("article_preservation_route_retained_tool_changed");
        return route;
    }

    internal static (OfflineMigrationDag Dag, IOfflineMigrationApplyOperationRegistry Registry) BuildDeclaredDag(
        OfflineMigrationStep compiledPgStep, ImmutableArray<OfflineMigrationApplyOperation> actualOwners,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (actualOwners.IsDefault || actualOwners.Any(owner => owner is null))
            throw new InvalidOperationException("article_preservation_route_actual_provider_owners_missing");
        ImmutableArray<OfflineMigrationProviderOperation> identities = actualOwners.Select(owner => owner.Identity)
            .OrderBy(identity => identity.Provider).ToImmutableArray();
        var step = compiledPgStep with
        {
            Operations = identities
        };
        var dag = new OfflineMigrationDag("article-preservation-whole-legacy-transaction", "1", [step]);
        // Before creating a registry, the sole original validator proves all three
        // actual providers, common semantics, exact entry and transactional shape.
        _ = OfflineMigrationPlanValidation.OrderSteps(dag, compiledPgStep.StepId);
        OfflineMigrationProviderOperation pgIdentity = compiledPgStep.Operations.Single(identity => identity.Provider == CurrentSchemaProviderKind.PostgreSql);
        RequireArticleStep(step, compiledPgStep, pgIdentity);
        return (dag, new CompiledDescriptorRegistry(dag, actualOwners));
    }

    // This phase retains actual compiled descriptors only. Source entry selection
    // follows the original native observation; no native connection is opened here.
    internal static async Task<OfflineMigrationArticlePreservationRoute> CreateAsync(
        CurrentSchemaArtifactReference sourceArtifact, CurrentSchemaArtifactReference currentArtifact,
        OwnedCurrentSchemaTarget target, OwnedRetainedMigrationTool retainedTool,
        PgArticlePreservationMediaConfiguration configuration,
        PgArticlePreservationRecoveryConfiguration recoveryConfiguration,
        OfflineMigrationDag codeOwnedDag, IOfflineMigrationApplyOperationRegistry otherOwners,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(codeOwnedDag);
        ArgumentNullException.ThrowIfNull(otherOwners);
        ArgumentNullException.ThrowIfNull(retainedTool);
        CurrentSchemaVerifierIdentity actualTool = await retainedTool.RevalidateAsync(cancellationToken).ConfigureAwait(false);
        PgArticlePreservationOperation article = await PgArticlePreservationOperation.CreateAsync(
            sourceArtifact, currentArtifact, target, actualTool, configuration, cancellationToken).ConfigureAwait(false);
        await article.BindRecoveryOwnerAsync(recoveryConfiguration, cancellationToken).ConfigureAwait(false);
        OfflineMigrationArticlePreservationRoute route = Create(article, codeOwnedDag, otherOwners, retainedTool, cancellationToken);
        if (await retainedTool.RevalidateAsync(cancellationToken).ConfigureAwait(false) != actualTool)
            throw new InvalidOperationException("article_preservation_route_retained_tool_changed");
        return route;
    }

    internal static OfflineMigrationArticlePreservationRoute Create(PgArticlePreservationOperation article,
        OfflineMigrationDag codeOwnedDag, IOfflineMigrationApplyOperationRegistry otherOwners,
        OwnedRetainedMigrationTool retainedTool, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(article);
        ArgumentNullException.ThrowIfNull(codeOwnedDag);
        ArgumentNullException.ThrowIfNull(otherOwners);
        ArgumentNullException.ThrowIfNull(retainedTool);
        if (article.RetainedTool != retainedTool.Identity)
            throw new InvalidOperationException("article_preservation_route_retained_tool_changed");
        var route = new OfflineMigrationArticlePreservationRoute(article, codeOwnedDag, otherOwners);
        RequireCompiledClosure(codeOwnedDag, route, article.Step, article.Identity, cancellationToken);
        return route;
    }

    public OfflineMigrationApplyOperation Resolve(OfflineMigrationStep step, OfflineMigrationProviderOperation identity)
    {
        RequireDeclaredOperation(Dag, step, identity);
        if (step.StepId == _article.Step.StepId && identity.Provider == CurrentSchemaProviderKind.PostgreSql)
        {
            _article.RequireStep(step, identity);
            return _article;
        }
        OfflineMigrationApplyOperation operation = _otherOwners.Resolve(step, identity);
        if (operation is null || operation.Identity != identity)
            throw new InvalidOperationException("article_preservation_route_compiled_owner_changed");
        return operation;
    }

    internal static void RequireDeclaredOperation(OfflineMigrationDag dag,
        OfflineMigrationStep step, OfflineMigrationProviderOperation identity)
    {
        OfflineMigrationStep? declared = dag.Steps.SingleOrDefault(value => value.StepId == step.StepId);
        if (declared is null || !OfflineMigrationPlanValidation.Equal(step, declared with
        {
            Dependencies = declared.Dependencies.OrderBy(value => value, StringComparer.Ordinal).ToImmutableArray(),
            Operations = declared.Operations.OrderBy(value => value.Provider).ToImmutableArray()
        }) || !step.Operations.Contains(identity))
            throw new InvalidOperationException("article_preservation_route_undeclared_operation");
    }

    public OfflineMigrationSourceRouteSelection MatchSource(OfflineMigrationSourceObservation source, CancellationToken cancellationToken)
        => MatchAndValidateSource(source, _sources, Dag, this, _article.Step, _article.Identity, cancellationToken);

    internal static OfflineMigrationSourceRouteSelection MatchAndValidateSource(
        OfflineMigrationSourceObservation source, OfflineMigrationSourceRegistry sources,
        OfflineMigrationDag dag, IOfflineMigrationApplyOperationRegistry operations,
        OfflineMigrationStep articleStep, OfflineMigrationProviderOperation articleIdentity, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        // The original registry supplies the full unknown/ambiguous differences.
        // A supported empty database belongs to its bootstrap owner, not this route.
        OfflineMigrationFingerprintDefinition fingerprint = sources.Match(source);
        if (fingerprint.Id != OfflineMigrationSourceFingerprints.LegacyId
            || fingerprint.EntryStepId != articleStep.StepId)
            throw new InvalidOperationException("article_preservation_route_source_entry_mismatch");
        ImmutableArray<OfflineMigrationStep> ordered = RequireCompiledClosure(dag, operations,
            articleStep, articleIdentity, cancellationToken);
        return new(fingerprint, dag, ordered);
    }

    internal static ImmutableArray<OfflineMigrationStep> RequireCompiledClosure(
        OfflineMigrationDag dag, IOfflineMigrationApplyOperationRegistry operations,
        OfflineMigrationStep articleStep, OfflineMigrationProviderOperation articleIdentity,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(dag);
        ArgumentNullException.ThrowIfNull(operations);
        cancellationToken.ThrowIfCancellationRequested();
        // Reuse the original whole-DAG ordering, provider completeness, semantic
        // equality and dependency validation. A PG-only node cannot pass this gate.
        ImmutableArray<OfflineMigrationStep> ordered = OfflineMigrationPlanValidation.OrderSteps(dag, articleStep.StepId);
        OfflineMigrationStep selected = ordered.Single(step => step.StepId == articleStep.StepId);
        RequireArticleStep(selected, articleStep, articleIdentity);
        foreach (OfflineMigrationStep step in ordered)
        {
            foreach (OfflineMigrationProviderOperation identity in step.Operations)
            {
                cancellationToken.ThrowIfCancellationRequested();
                OfflineMigrationApplyOperation operation = operations.Resolve(step, identity);
                if (operation is null || operation.Identity != identity)
                    throw new InvalidOperationException("article_preservation_route_compiled_owner_changed");
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        return ordered;
    }

    internal static void RequireArticleStep(OfflineMigrationStep selected,
        OfflineMigrationStep article, OfflineMigrationProviderOperation identity)
    {
        if (identity.Provider != CurrentSchemaProviderKind.PostgreSql
            || selected.StepId != article.StepId || selected.SourcePrecondition != article.SourcePrecondition
            || selected.TargetPostcondition != article.TargetPostcondition
            || !selected.Dependencies.SequenceEqual(article.Dependencies)
            || selected.IdempotencyDefinition != article.IdempotencyDefinition || selected.Destructive != article.Destructive
            || selected.ResumePolicy != article.ResumePolicy
            || selected.Operations.Count(operation => operation.Provider == identity.Provider) != 1
            || selected.Operations.Single(operation => operation.Provider == identity.Provider) != identity)
            throw new InvalidOperationException("article_preservation_route_step_changed");
    }

    private sealed class CompiledDescriptorRegistry(OfflineMigrationDag dag,
        ImmutableArray<OfflineMigrationApplyOperation> owners) : IOfflineMigrationApplyOperationRegistry
    {
        public OfflineMigrationApplyOperation Resolve(OfflineMigrationStep step, OfflineMigrationProviderOperation identity)
        {
            RequireDeclaredOperation(dag, step, identity);
            OfflineMigrationApplyOperation owner = owners.Single(owner => owner.Identity.Provider == identity.Provider);
            if (owner.Identity != identity)
                throw new InvalidOperationException("article_preservation_route_compiled_owner_changed");
            return owner;
        }
    }
}
