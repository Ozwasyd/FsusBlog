using System.Collections.Immutable;
using System.Data.Common;
using System.Runtime.InteropServices;

using FsusBlog.Contracts.Migration;

using Xunit;

namespace FsusBlog.Migration.Tests;

// All provider operations below are explicit pure fixtures with no native ports.
// A successful shape/selection control is not production registration or admission.
public sealed class OfflineMigrationArticlePreservationRouteTests
{
    [Theory]
    [InlineData(CurrentSchemaProviderKind.PostgreSql)]
    [InlineData(CurrentSchemaProviderKind.MySql)]
    [InlineData(CurrentSchemaProviderKind.Sqlite)]
    public void OriginalNativeShapeMatchesExactLegacyEntryAndTheSameCompleteCompiledDag(CurrentSchemaProviderKind provider)
    {
        var (article, dag) = Closure();
        var registry = new FixtureRegistry();
        OfflineMigrationSourceRouteSelection selected = Select(Source(provider, true), article, dag, registry);
        Assert.Equal(OfflineMigrationSourceFingerprints.LegacyId, selected.Fingerprint.Id);
        Assert.Equal(article.StepId, selected.Fingerprint.EntryStepId);
        Assert.Same(dag, selected.Dag);
        Assert.True(OfflineMigrationPlanValidation.Equal(dag.Steps, selected.OrderedSteps));
        Assert.Equal(3, registry.Resolved.Count);
        Assert.Equal(Enum.GetValues<CurrentSchemaProviderKind>(), registry.Resolved.OrderBy(value => value).ToArray());
    }

    [Fact]
    public void AKnownEmptyDatabaseCannotBeAliasedToTheArticleLegacyEntry()
    {
        var (article, dag) = Closure();
        OfflineMigrationSourceObservation empty = Source(CurrentSchemaProviderKind.PostgreSql, false);
        Assert.Equal("bootstrap-current-schema", OfflineMigrationSourceFingerprints.CreateRegistry().Match(empty).EntryStepId);
        Assert.Throws<InvalidOperationException>(() => Select(empty, article, dag, new FixtureRegistry()));
    }

    [Theory]
    [InlineData("unknown-table")]
    [InlineData("partial-schema")]
    [InlineData("unsupported-object")]
    public void TheOriginalRegistryRejectsUnknownOrPartialSourceBeforeResolvingAnyOwner(string drift)
    {
        var (article, dag) = Closure();
        var registry = new FixtureRegistry();
        OfflineMigrationSourceObservation source = Source(CurrentSchemaProviderKind.PostgreSql, true);
        Assert.Equal(OfflineMigrationSourceFingerprints.LegacyId, OfflineMigrationSourceFingerprints.CreateRegistry().Match(source).Id);
        source = source with
        {
            Schema = drift switch
            {
                "unknown-table" => [.. source.Schema, new("table/unknown", "base")],
                "partial-schema" => source.Schema.RemoveAt(source.Schema.Length - 1),
                "unsupported-object" => source.Schema.Select(fact => fact.Name == "objects.unsupported" ? fact with { Value = "1" } : fact).ToImmutableArray(),
                _ => throw new ArgumentOutOfRangeException(nameof(drift))
            }
        };
        Assert.ThrowsAny<InvalidOperationException>(() => Select(source, article, dag, registry));
        Assert.Empty(registry.Resolved);
    }

    [Theory]
    [InlineData(CurrentSchemaProviderKind.MySql)]
    [InlineData(CurrentSchemaProviderKind.Sqlite)]
    public void MissingActualProviderIsRejectedInsteadOfRegisteringPgAsACompleteRoute(CurrentSchemaProviderKind missing)
    {
        var (article, dag) = Closure();
        var registry = new FixtureRegistry();
        OfflineMigrationArticlePreservationRoute.RequireCompiledClosure(dag, registry, article, article.Operations[0], CancellationToken.None);
        registry.Resolved.Clear();
        dag = dag with
        {
            Steps = [article with { Operations = article.Operations.Where(value => value.Provider != missing).ToImmutableArray() }]
        };
        Assert.Throws<InvalidOperationException>(() => Select(Source(CurrentSchemaProviderKind.PostgreSql, true), article, dag, registry));
        Assert.Empty(registry.Resolved);
    }

    [Theory]
    [InlineData("predicate")]
    [InlineData("idempotency")]
    [InlineData("resume")]
    [InlineData("destructive")]
    [InlineData("entry")]
    [InlineData("pg-identity")]
    public void AResealedOrRenamedStepDoesNotReplaceTheActualArticleDescriptor(string drift)
    {
        var (article, dag) = Closure();
        OfflineMigrationStep changed = drift switch
        {
            "predicate" => article with { SourcePrecondition = "unrelated-source" },
            "idempotency" => article with { IdempotencyDefinition = "unrelated-idempotency" },
            "resume" => article with { ResumePolicy = article.ResumePolicy with { Version = "unrelated-resume" } },
            "destructive" => article with { Destructive = !article.Destructive },
            "entry" => article with { StepId = "alias-legacy-entry" },
            "pg-identity" => article with
            {
                Operations = article.Operations.Select(value => value.Provider == CurrentSchemaProviderKind.PostgreSql
                ? value with
                {
                    OperationReference = "unrelated-owner"
                } : value).ToImmutableArray()
            },
            _ => throw new ArgumentOutOfRangeException(nameof(drift))
        };
        var registry = new FixtureRegistry();
        Assert.Throws<InvalidOperationException>(() => Select(Source(CurrentSchemaProviderKind.PostgreSql, true), article,
            dag with
            {
                Steps = [changed]
            }, registry));
        Assert.Empty(registry.Resolved);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("identity")]
    [InlineData("semantics")]
    public void MissingOrChangedRealOwnerIsNotFilledFromTheDagPayload(string drift)
    {
        var (article, dag) = Closure();
        Assert.Throws<InvalidOperationException>(() => Select(Source(CurrentSchemaProviderKind.PostgreSql, true), article, dag,
            new FixtureRegistry(drift)));
    }

    [Theory]
    [InlineData("unknown-step")]
    [InlineData("changed-step")]
    [InlineData("unknown-identity")]
    public void ResolveRefusesAnUndeclaredNodeEvenIfADelegateWouldAcceptIt(string drift)
    {
        var (article, dag) = Closure();
        OfflineMigrationProviderOperation identity = article.Operations[0];
        OfflineMigrationArticlePreservationRoute.RequireDeclaredOperation(dag, article, identity);
        OfflineMigrationStep requested = drift switch
        {
            "unknown-step" => article with { StepId = "unknown-node" },
            "changed-step" => article with { TargetPostcondition = "unrelated-target" },
            "unknown-identity" => article,
            _ => throw new ArgumentOutOfRangeException(nameof(drift))
        };
        if (drift == "unknown-identity")
            identity = identity with
            {
                OperationReference = "unregistered-owner"
            };
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationArticlePreservationRoute.RequireDeclaredOperation(dag, requested, identity));
    }

    [Fact]
    public void CancelledSourceSelectionDoesNotResolveOrEmitRouteEvidence()
    {
        var (article, dag) = Closure();
        var registry = new FixtureRegistry();
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        Assert.Throws<OperationCanceledException>(() => OfflineMigrationArticlePreservationRoute.MatchAndValidateSource(
            Source(CurrentSchemaProviderKind.PostgreSql, true), OfflineMigrationSourceFingerprints.CreateRegistry(),
            dag, registry, article, article.Operations[0], cancelled.Token));
        Assert.Empty(registry.Resolved);
    }

    [Fact]
    public void DeclaredDagAndRegistryRetainTheSameActualDescriptorInstances()
    {
        var (article, _) = Closure();
        ImmutableArray<OfflineMigrationApplyOperation> owners = article.Operations
            .Select(identity => (OfflineMigrationApplyOperation)new FixtureOperation(identity)).ToImmutableArray();
        var (dag, registry) = OfflineMigrationArticlePreservationRoute.BuildDeclaredDag(article, owners, CancellationToken.None);
        Assert.Equal(article.StepId, dag.Steps.Single().StepId);
        Assert.Equal(article.SourcePrecondition, dag.Steps.Single().SourcePrecondition);
        foreach (OfflineMigrationApplyOperation owner in owners)
            Assert.Same(owner, registry.Resolve(dag.Steps.Single(), owner.Identity));
        _ = Select(Source(CurrentSchemaProviderKind.PostgreSql, true), article, dag, new FixtureRegistry());
    }

    [Theory]
    [InlineData("missing-mysql")]
    [InlineData("missing-sqlite")]
    [InlineData("duplicate-provider")]
    [InlineData("divergent-semantics")]
    public void ActualDescriptorConstructionCannotManufactureAMissingProviderOrDivergentMeaning(string drift)
    {
        var (article, _) = Closure();
        ImmutableArray<OfflineMigrationProviderOperation> identities = drift switch
        {
            "missing-mysql" => article.Operations.Where(value => value.Provider != CurrentSchemaProviderKind.MySql).ToImmutableArray(),
            "missing-sqlite" => article.Operations.Where(value => value.Provider != CurrentSchemaProviderKind.Sqlite).ToImmutableArray(),
            "duplicate-provider" => [.. article.Operations, article.Operations[0]],
            "divergent-semantics" => article.Operations.Select(value => value.Provider == CurrentSchemaProviderKind.MySql
                ? value with
                {
                    SemanticDigest = new string('c', 64)
                } : value).ToImmutableArray(),
            _ => throw new ArgumentOutOfRangeException(nameof(drift))
        };
        ImmutableArray<OfflineMigrationApplyOperation> owners = identities
            .Select(identity => (OfflineMigrationApplyOperation)new FixtureOperation(identity)).ToImmutableArray();
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationArticlePreservationRoute.BuildDeclaredDag(article, owners, CancellationToken.None));
    }

    [Fact]
    public void ReadonlyTargetKeepsTheActualPublishedGenerationIdentity()
        => PgArticlePreservationOperation.RequireGenerationIdentity("linux:device:mount:original-inode", "linux:device:mount:original-inode");

    [Theory]
    [InlineData("linux:device:mount:replacement-inode", "linux:device:mount:original-inode")]
    [InlineData("", "linux:device:mount:original-inode")]
    [InlineData("linux:device:mount:original-inode", "")]
    public void EqualFileBytesDoNotReplaceTheOriginalNativeGenerationIdentity(string actual, string expected)
        => Assert.Throws<InvalidOperationException>(() => PgArticlePreservationOperation.RequireGenerationIdentity(actual, expected));

    [Theory]
    [InlineData("original")]
    [InlineData("digest")]
    [InlineData("byte-budget")]
    [InlineData("symlink")]
    public async Task ArtifactConsumptionUsesTheOriginalNativeFdBoundaryAndNeverReturnsFailedEvidence(string kind)
    {
        DirectoryInfo temporary = Directory.CreateTempSubdirectory("fsusblog-article-original-fd-");
        try
        {
            string path = Path.Combine(temporary.FullName, "original-artifact");
            byte[] bytes = [1, 2, 3, 4];
            await File.WriteAllBytesAsync(path, bytes);
            string digest = ArticlePreservationSemanticReceipt.HashBytes(bytes);
            bool nativeOwner = OperatingSystem.IsLinux()
                && RuntimeInformation.ProcessArchitecture is Architecture.X64 or Architecture.Arm64;
            if (kind == "symlink" && nativeOwner)
            {
                string link = Path.Combine(temporary.FullName, "input-link");
                File.CreateSymbolicLink(link, path);
                path = link;
            }
            var artifact = new CurrentSchemaArtifactReference(path, kind == "digest" ? new string('0', 64) : digest);
            long maximumBytes = kind == "byte-budget" ? 3 : 4;
            if (kind == "original" && nativeOwner)
            {
                ImmutableArray<byte> actual = await PgArticlePreservationOperation.ReadArtifactAsync(artifact, maximumBytes, CancellationToken.None);
                Assert.Equal(bytes, actual.ToArray());
            }
            else
            {
                // An unowned platform must refuse, not silently skip the FD requirement.
                await Assert.ThrowsAsync<InvalidOperationException>(() =>
                    PgArticlePreservationOperation.ReadArtifactAsync(artifact, maximumBytes, CancellationToken.None));
            }
        }
        finally
        {
            Directory.Delete(temporary.FullName, recursive: true);
        }
    }

    private static OfflineMigrationSourceRouteSelection Select(OfflineMigrationSourceObservation source,
        OfflineMigrationStep article, OfflineMigrationDag dag, FixtureRegistry operations)
        => OfflineMigrationArticlePreservationRoute.MatchAndValidateSource(source, OfflineMigrationSourceFingerprints.CreateRegistry(),
            dag, operations, article, article.Operations[0], CancellationToken.None);

    private static OfflineMigrationSourceObservation Source(CurrentSchemaProviderKind provider, bool legacy)
    {
        OfflineMigrationSourceShape shape = OfflineMigrationSourceFingerprints.Shape(provider, legacy);
        return new(new(provider, "fixture-instance", "fixture-database"), shape.ExtractorId, shape.ExtractorVersion,
            shape.Schema, shape.History, shape.BusinessShape, new string('a', 64));
    }

    private static (OfflineMigrationStep Article, OfflineMigrationDag Dag) Closure()
    {
        ImmutableArray<OfflineMigrationProviderOperation> identities = Enum.GetValues<CurrentSchemaProviderKind>()
            .Select(provider => new OfflineMigrationProviderOperation(provider, "fixture-owner:" + provider,
                new string('a', 64), new string('b', 64), OfflineMigrationExecutionMode.Transaction)).ToImmutableArray();
        var step = new OfflineMigrationStep(PgArticlePreservationOperation.StepReference,
            PgArticlePreservationOperation.SourcePredicate, PgArticlePreservationOperation.TargetPredicate, [],
            "fixture-transaction", true, new("fixture-resume", 0, "no-watermark", PgArticlePreservationOperation.TargetPredicate), identities);
        return (step, new("fixture-compiled-dag-not-native-qualification", "v1", [step]));
    }

    private sealed class FixtureRegistry(string? drift = null) : IOfflineMigrationApplyOperationRegistry
    {
        internal List<CurrentSchemaProviderKind> Resolved { get; } = [];
        public OfflineMigrationApplyOperation Resolve(OfflineMigrationStep step, OfflineMigrationProviderOperation identity)
        {
            Resolved.Add(identity.Provider);
            if (drift == "missing")
                throw new InvalidOperationException("fixture-actual-owner-missing");
            return new FixtureOperation(drift switch
            {
                "identity" => identity with { OperationReference = "changed-real-owner" },
                "semantics" => identity with { SemanticDigest = new string('c', 64) },
                _ => identity
            });
        }
    }

    private sealed class FixtureOperation(OfflineMigrationProviderOperation identity) : OfflineMigrationApplyOperation
    {
        internal override OfflineMigrationProviderOperation Identity => identity;
        internal override Task<OfflineMigrationPredicateObservation> ObserveAsync(string predicate,
            DbConnection connection, DbTransaction transaction, CancellationToken token)
            => throw new NotSupportedException("compiled_route_fixture_has_no_native_observation");
        internal override Task<OfflineMigrationApplyUnit> ExecuteAsync(OfflineMigrationStep step,
            OfflineMigrationApplyJournalEntry? previous, DbConnection connection, DbTransaction transaction, CancellationToken token)
            => throw new NotSupportedException("compiled_route_fixture_has_no_native_execution");
    }
}
