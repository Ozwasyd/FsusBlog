using System.Text.Json;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleScalePlanTests
{
    [Theory]
    [InlineData("scale-xs", 1, 1, 0, 0, 0, 0)]
    [InlineData("scale-s", 100, 80, 5, 5, 5, 5)]
    [InlineData("scale-m", 10_000, 8_000, 500, 500, 500, 500)]
    [InlineData("scale-l-nightly", 100_000, 80_000, 5_000, 5_000, 5_000, 5_000)]
    public void Create_UsesClosedVersionedDistributionWithoutChangingTierCounts(
        string tier,
        int articleCount,
        int published,
        int scheduled,
        int scheduledUpdate,
        int archived,
        int deleted)
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create(tier, "run-a", Artifacts());

        Assert.Equal(ArticleScaleContractIds.PlanSchema, plan.Schema);
        Assert.Equal(ArticleScaleContractIds.GraphSchema, plan.GraphSchema);
        Assert.Equal(ArticleScaleContractIds.RequiredGraphFactory, plan.RequiredGraphFactory);
        Assert.Equal(articleCount, plan.ArticleCount);
        Assert.Equal(Enum.GetValues<ArticleScaleVariant>(), plan.StateDistribution.Select(static item => item.Variant));
        Assert.Equal(published, Allocation(plan, ArticleScaleVariant.Published).Count);
        Assert.Equal(scheduled, Allocation(plan, ArticleScaleVariant.Scheduled).Count);
        Assert.Equal(scheduledUpdate, Allocation(plan, ArticleScaleVariant.PublishedWithScheduledUpdate).Count);
        Assert.Equal(archived, Allocation(plan, ArticleScaleVariant.Archived).Count);
        Assert.Equal(deleted, Allocation(plan, ArticleScaleVariant.Deleted).Count);
        Assert.Equal(articleCount, plan.StateDistribution.Sum(static item => item.Count));
        Assert.True(Validate(plan).IsValid);
    }

    [Fact]
    public void Plan_DeclaresCompleteProviderNeutralGraphCountsAndPostconditions()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", "graph-counts", Artifacts());

        Assert.Equal(100, ExpectedRows(plan, ArticleScaleRowKind.Article));
        Assert.Equal(105, ExpectedRows(plan, ArticleScaleRowKind.ArticleRevision));
        Assert.Equal(95, ExpectedRows(plan, ArticleScaleRowKind.ArticlePublication));
        Assert.Equal(115, ExpectedRows(plan, ArticleScaleRowKind.ArticleMutationOutboxEnvelope));
        Assert.Equal(
            115 * ArticleMutationReplayEdges.Required.Count,
            ExpectedRows(plan, ArticleScaleRowKind.ArticleMutationOutboxEdge));
        Assert.Equal(0, plan.Postconditions.ExpectedOrphans);
        Assert.Contains("semantic-graph-digest-matches", plan.Postconditions.RequiredInvariants);
        Assert.Contains("plan.stateDistribution", plan.Postconditions.SemanticGraphDigestInputs);
        Assert.Contains("plan.outbox", plan.Postconditions.SemanticGraphDigestInputs);
        Assert.StartsWith("sha256:", plan.ContentDigest, StringComparison.Ordinal);
    }

    [Fact]
    public void Published_RequiresExactCurrentCoordinatesRightsResponsibilityAndOutbox()
    {
        ArticleScaleVariantContract contract = ArticleScaleVariantContractCatalog.Get(ArticleScaleVariant.Published);

        Assert.Equal(ArticleStatus.Published, contract.TerminalStatus);
        Assert.False(contract.IsDeleted);
        Assert.True(contract.RetainsPublicationHistory);
        AssertRowCount(contract, ArticleScaleRowKind.ArticleRevision, 1);
        AssertRowCount(contract, ArticleScaleRowKind.ArticleRightsSnapshot, 1);
        AssertRowCount(contract, ArticleScaleRowKind.ArticleRightsProof, 1);
        AssertRowCount(contract, ArticleScaleRowKind.ArticleResponsibilitySnapshot, 1);
        AssertRowCount(contract, ArticleScaleRowKind.ArticlePublication, 1);
        AssertRowCount(contract, ArticleScaleRowKind.ArticleMutationOutboxEnvelope, 1);
        Assert.Contains(contract.Pointers, static pointer => pointer.Kind == ArticleScalePointerKind.CurrentRevision);
        Assert.Contains(contract.Pointers, static pointer => pointer.Kind == ArticleScalePointerKind.CurrentPublication);
        Assert.Contains(ArticleScaleRelationKind.PublicationToRightsSnapshot, contract.Relations);
        Assert.Contains(ArticleScaleRelationKind.PublicationToResponsibilitySnapshot, contract.Relations);
        Assert.Equal(ArticleMutationEventTypes.Created, Assert.Single(contract.OutboxEvents).EventType);
    }

    [Fact]
    public void ScheduledVariants_RequireFutureDueAndRetainOldPublicationOnlyForUpdate()
    {
        ArticleScaleVariantContract scheduled = ArticleScaleVariantContractCatalog.Get(ArticleScaleVariant.Scheduled);
        ArticleScaleVariantContract update = ArticleScaleVariantContractCatalog.Get(
            ArticleScaleVariant.PublishedWithScheduledUpdate);

        Assert.False(scheduled.RetainsPublicationHistory);
        Assert.False(scheduled.RetainsPriorPublicationWhileScheduled);
        AssertRowCount(scheduled, ArticleScaleRowKind.ArticlePublication, 0);
        Assert.Contains(
            scheduled.Pointers,
            static pointer => pointer.Kind == ArticleScalePointerKind.ScheduledPublishAt);
        Assert.Contains(
            scheduled.TemporalOrder,
            static order => order.EarlierRoleId == ArticleScaleTemporalRoles.CommandTime
                && order.LaterRoleId == ArticleScaleTemporalRoles.BoundaryTime
                && order.Order == ArticleScaleTemporalOrder.StrictlyBefore);

        Assert.Equal(ArticleStatus.Published, update.TerminalStatus);
        Assert.True(update.RetainsPublicationHistory);
        Assert.True(update.RetainsPriorPublicationWhileScheduled);
        AssertRowCount(update, ArticleScaleRowKind.ArticleRevision, 2);
        AssertRowCount(update, ArticleScaleRowKind.ArticlePublication, 1);
        Assert.Contains(
            update.Pointers,
            static pointer => pointer.Kind == ArticleScalePointerKind.CurrentRevision
                && pointer.SemanticTargetRole == "revision:2");
        Assert.Contains(
            update.Pointers,
            static pointer => pointer.Kind == ArticleScalePointerKind.CurrentPublication
                && pointer.SemanticTargetRole == "publication:1");
        Assert.Contains(
            update.Pointers,
            static pointer => pointer.Kind == ArticleScalePointerKind.PendingPublicationAt);

        ArticleScaleOutboxEventRequirement scheduledEvent = Assert.Single(scheduled.OutboxEvents);
        Assert.Equal(1, scheduledEvent.RevisionOrdinal);
        Assert.Null(scheduledEvent.PublicationOrdinal);
        Assert.Equal(ArticleScaleTemporalRoles.CommandTime, scheduledEvent.OccurredAtRole);
        Assert.Collection(
            update.OutboxEvents,
            first =>
            {
                Assert.Equal(1, first.RevisionOrdinal);
                Assert.Equal(1, first.PublicationOrdinal);
                Assert.Equal(ArticleMutationEventTypes.Created, first.EventType);
            },
            second =>
            {
                Assert.Equal(2, second.RevisionOrdinal);
                Assert.Equal(1, second.PublicationOrdinal);
                Assert.Equal(ArticleMutationEventTypes.Updated, second.EventType);
                Assert.Equal(ArticleScaleTemporalRoles.CommandTime, second.OccurredAtRole);
            });
    }

    [Fact]
    public void ArchivedAndDeleted_RetainHistoryAndUseLegalFlows()
    {
        ArticleScaleVariantContract archived = ArticleScaleVariantContractCatalog.Get(ArticleScaleVariant.Archived);
        ArticleScaleVariantContract deleted = ArticleScaleVariantContractCatalog.Get(ArticleScaleVariant.Deleted);

        Assert.True(archived.RetainsPublicationHistory);
        Assert.Equal(ArticleStatus.Archived, archived.TerminalStatus);
        Assert.Equal(ArticlePublicationTransitionKinds.Archive, archived.Transitions[^1].TransitionKind);
        Assert.Equal(ArticleStatusTransitionOperation.Update, archived.Transitions[^1].Operation);
        Assert.Contains(archived.Pointers, static pointer => pointer.Kind == ArticleScalePointerKind.ArchivedAt);

        Assert.True(deleted.RetainsPublicationHistory);
        Assert.True(deleted.IsDeleted);
        Assert.Equal(ArticleStatus.Deleted, deleted.TerminalStatus);
        Assert.Null(deleted.Transitions[^1].Operation);
        Assert.Equal("article-delete-flow", deleted.Transitions[^1].TransitionKind);
        Assert.Equal(ArticleMutationEventTypes.Deleted, deleted.Transitions[^1].OutboxEventType);
        Assert.Contains(deleted.Pointers, static pointer => pointer.Kind == ArticleScalePointerKind.DeletedAt);
        AssertRowCount(deleted, ArticleScaleRowKind.ArticlePublication, 1);
        Assert.All(
            archived.OutboxEvents.Concat(deleted.OutboxEvents),
            static item =>
            {
                Assert.Equal(1, item.RevisionOrdinal);
                Assert.Equal(1, item.PublicationOrdinal);
            });
    }

    [Fact]
    public void Plan_ReferencesResolvedAndGeneratedAuthoritiesWithoutPayloads()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", "artifact-bindings", Artifacts());

        Assert.Equal(ArticleScaleContractIds.TemporalArtifactSchema, plan.Artifacts.Temporal.Schema);
        Assert.Equal(ArticleScaleContractIds.DistributionShape, plan.Artifacts.Distribution.ShapeId);
        Assert.All(
            plan.Artifacts.Content,
            static item => Assert.Equal(ArticleScaleContractIds.ContentShapeCatalogSchema, item.Schema));
        Assert.All(
            plan.Artifacts.Media,
            static item => Assert.Equal(ArticleScaleContractIds.MediaShapeCatalogSchema, item.Schema));
        Assert.Equal(ArticleScaleContractIds.TaxonomyShape, Assert.Single(plan.Artifacts.Taxonomy).ShapeId);
        Assert.DoesNotContain("://", JsonSerializer.Serialize(plan.Artifacts), StringComparison.Ordinal);
        Assert.All(
            plan.StateDistribution.SelectMany(static allocation => allocation.Contract.TemporalRoles),
            static role => Assert.Contains(role.RoleId, ArticleScaleTemporalRoles.All));
    }

    [Fact]
    public void Outbox_ExactMatchesProductionFactoryEnvelopeAndEdgeContracts()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", "outbox-binding", Artifacts());

        Assert.Equal(ArticleMutationOutboxProducer.FactoryId, plan.Outbox.FactoryId);
        Assert.Equal(ArticleMutationOutboxEnvelopeCodec.CurrentSchemaId, plan.Outbox.EnvelopeSchemaId);
        Assert.Equal(ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion, plan.Outbox.EnvelopeSchemaVersion);
        Assert.Equal(ArticleMutationReplayEdges.ContractId, plan.Outbox.EdgeContractId);
        Assert.Equal(
            ArticleMutationReplayEdges.Required.Order(StringComparer.Ordinal),
            plan.Outbox.RequiredEdges);
        Assert.All(
            plan.StateDistribution.SelectMany(static allocation => allocation.Contract.OutboxEvents),
            static item =>
            {
                Assert.True(item.RequiresRightsSnapshot);
                Assert.True(item.RequiresResponsibilitySnapshot);
            });
    }

    [Fact]
    public void SemanticIds_ExplicitlyMapEveryRowKindAndRemainProviderNeutral()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", "semantic-ids", Artifacts());

        Assert.Equal(ArticleScaleContractIds.SemanticIdPolicy, plan.IdAllocation.PolicyId);
        Assert.Equal(1, plan.IdAllocation.ArticleOrdinalBase);
        Assert.Equal(Enum.GetValues<ArticleScaleRowKind>(), plan.IdAllocation.KeyMappings.Select(static item => item.RowKind));
        Assert.All(
            plan.IdAllocation.KeyMappings,
            static mapping =>
            {
                Assert.Equal(ArticleScaleKeySource.DatabaseGeneratedMappedBySemanticRole, mapping.KeySource);
                Assert.Contains("{article}", mapping.SemanticRoleTemplate, StringComparison.Ordinal);
            });
        string contract = JsonSerializer.Serialize(plan);
        Assert.DoesNotContain("Npgsql", contract, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("SqlSugar", contract, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("PostgreSQL", contract, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("MySQL", contract, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("SQLite", contract, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(
            Enum.GetNames<ArticleScaleRowKind>(),
            static name => name.Contains("Redis", StringComparison.Ordinal)
                || name.Contains("Search", StringComparison.Ordinal)
                || name.Contains("Aot", StringComparison.Ordinal)
                || name.Contains("HotRead", StringComparison.Ordinal));
    }

    [Fact]
    public void Validator_RejectsMissingDuplicateUnknownAndNonCanonicalDistribution()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", "distribution-tamper", Artifacts());
        ArticleScaleVariantAllocation first = plan.StateDistribution[0];
        ArticleScalePlan missing = Reseal(plan with
        {
            StateDistribution = plan.StateDistribution.Take(4).ToArray()
        });
        ArticleScalePlan duplicate = Reseal(plan with
        {
            StateDistribution = [first, first, .. plan.StateDistribution.Skip(2)]
        });
        ArticleScalePlan unknown = Reseal(plan with
        {
            StateDistribution =
            [
                first with { Variant = (ArticleScaleVariant)999 },
                .. plan.StateDistribution.Skip(1)
            ]
        });
        ArticleScalePlan nonCanonical = Reseal(plan with
        {
            StateDistribution =
            [
                first with { Count = first.Count - 1 },
                plan.StateDistribution[1] with { Count = plan.StateDistribution[1].Count + 1 },
                .. plan.StateDistribution.Skip(2)
            ]
        });

        Assert.False(Validate(missing).IsValid);
        Assert.False(Validate(duplicate).IsValid);
        Assert.False(Validate(unknown).IsValid);
        Assert.False(Validate(nonCanonical).IsValid);
    }

    [Fact]
    public void Validator_RejectsMissingRowsRelationsPointersAndOrphanPronePostconditions()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", "graph-tamper", Artifacts());
        ArticleScaleVariantAllocation published = Allocation(plan, ArticleScaleVariant.Published);
        ArticleScalePlan missingRow = ReplaceAllocation(
            plan,
            published with
            {
                Contract = published.Contract with
                {
                    Rows = published.Contract.Rows.Skip(1).ToArray()
                }
            });
        ArticleScalePlan missingRelation = ReplaceAllocation(
            plan,
            published with
            {
                Contract = published.Contract with
                {
                    Relations = published.Contract.Relations.Skip(1).ToArray()
                }
            });
        ArticleScalePlan missingPointer = ReplaceAllocation(
            plan,
            published with
            {
                Contract = published.Contract with
                {
                    Pointers = published.Contract.Pointers.Skip(1).ToArray()
                }
            });
        ArticleScalePlan orphan = Reseal(plan with
        {
            Postconditions = plan.Postconditions with
            {
                ExpectedOrphans = 1
            }
        });

        Assert.False(Validate(missingRow).IsValid);
        Assert.False(Validate(missingRelation).IsValid);
        Assert.False(Validate(missingPointer).IsValid);
        Assert.False(Validate(orphan).IsValid);
    }

    [Fact]
    public void Validator_RejectsUnknownAuthorityPayloadAndOutboxDrift()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", "authority-tamper", Artifacts());
        ArticleScalePlan wrongTemporal = Reseal(plan with
        {
            Artifacts = plan.Artifacts with
            {
                Temporal = plan.Artifacts.Temporal with
                {
                    Schema = "fsusblog.private-temporal.v1"
                }
            }
        });
        ArticleScalePlan payload = Reseal(plan with
        {
            Artifacts = plan.Artifacts with
            {
                Content =
                [
                    plan.Artifacts.Content[0] with
                    {
                        AuthorityId = "https://example.invalid/payload"
                    }
                ]
            }
        });
        ArticleScalePlan validDigestDrift = Reseal(plan with
        {
            Artifacts = plan.Artifacts with
            {
                Content =
                [
                    plan.Artifacts.Content[0] with
                    {
                        ContentDigest = Digest('a')
                    }
                ]
            }
        });
        ArticleScalePlan outbox = Reseal(plan with
        {
            Outbox = plan.Outbox with
            {
                EnvelopeSchemaVersion = plan.Outbox.EnvelopeSchemaVersion + 1
            }
        });

        Assert.False(Validate(wrongTemporal).IsValid);
        Assert.False(Validate(payload).IsValid);
        Assert.False(Validate(validDigestDrift).IsValid);
        Assert.False(Validate(outbox).IsValid);
    }

    [Fact]
    public void Validator_RejectsSchemaPolicySentinelSimplificationAndDigestTamper()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", "policy-tamper", Artifacts());
        ArticleScalePlan graphSchema = Reseal(plan with
        {
            GraphSchema = "fsusblog.article-scale-graph-row-plan.v2"
        });
        ArticleScalePlan policy = Reseal(plan with
        {
            IdAllocation = plan.IdAllocation with
            {
                PolicyId = "fsusblog.article-scale-semantic-id.v2"
            }
        });
        ArticleScalePlan sentinel = Reseal(plan with
        {
            Artifacts = plan.Artifacts with
            {
                Content =
                [
                    plan.Artifacts.Content[0] with
                    {
                        ShapeId = "rights-v3:content-hash:recompute"
                    }
                ]
            }
        });
        ArticleScalePlan simplified = Reseal(plan with
        {
            Artifacts = plan.Artifacts with
            {
                Content = [plan.Artifacts.Content[0] with { ShapeId = "simplified-graph" }]
            }
        });
        ArticleScalePlan staleDigest = plan with
        {
            ContentDigest = Digest('f')
        };

        Assert.False(Validate(graphSchema).IsValid);
        Assert.False(Validate(policy).IsValid);
        Assert.False(Validate(sentinel).IsValid);
        Assert.False(Validate(simplified).IsValid);
        Assert.False(Validate(staleDigest).IsValid);
    }

    [Fact]
    public void Contract_HasOnePlanTypeCanonicalFactoryAndNoWriterImplementation()
    {
        Type[] planTypes = typeof(ArticleScalePlan).Assembly.GetTypes()
            .Where(static type => type.Name == nameof(ArticleScalePlan))
            .ToArray();
        Type[] factoryTypes = typeof(ArticleScalePlan).Assembly.GetTypes()
            .Where(static type => type.Name == "CanonicalArticleGraphFactory")
            .ToArray();
        Type[] forbiddenImplementations = typeof(ArticleScalePlan).Assembly.GetTypes()
            .Where(static type => type.Name == "ArticleScaleWriter")
            .ToArray();

        Assert.Single(planTypes);
        Assert.Single(factoryTypes);
        Assert.Empty(forbiddenImplementations);
        Assert.DoesNotContain(
            typeof(ArticleScalePlanBuilder).GetMethods(),
            static method => method.Name.Contains("Generate", StringComparison.Ordinal)
                || method.Name.Contains("Write", StringComparison.Ordinal));
    }

    [Fact]
    public void Validator_RejectsScaleXsWithOneScheduledArticleAndNoPublishedArticle()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-xs", "single-variant-drift", Artifacts());
        Assert.True(Validate(plan).IsValid);

        ArticleScalePlan nonCanonical = Reseal(plan with
        {
            StateDistribution = plan.StateDistribution.Select(static allocation => allocation with
            {
                Count = allocation.Variant switch
                {
                    ArticleScaleVariant.Published => 0,
                    ArticleScaleVariant.Scheduled => 1,
                    _ => allocation.Count
                }
            }).ToArray()
        });

        Assert.Equal(1, nonCanonical.ArticleCount);
        Assert.Equal(1, nonCanonical.StateDistribution.Sum(static allocation => allocation.Count));
        Assert.Equal(0, Allocation(nonCanonical, ArticleScaleVariant.Published).Count);
        Assert.Equal(1, Allocation(nonCanonical, ArticleScaleVariant.Scheduled).Count);
        ArticleScalePlanValidationResult validation = Validate(nonCanonical);
        Assert.False(validation.IsValid);
        Assert.Contains("state distribution count for Published is not canonical", validation.Errors);
        Assert.Contains("state distribution count for Scheduled is not canonical", validation.Errors);
    }

    [Fact]
    public void Validator_RejectsPublishedVariantContractWithDeletedFlag()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-xs", "deleted-flag-drift", Artifacts());
        Assert.True(Validate(plan).IsValid);
        ArticleScaleVariantAllocation published = Allocation(plan, ArticleScaleVariant.Published);
        Assert.False(published.Contract.IsDeleted);

        ArticleScalePlan tampered = ReplaceAllocation(plan, published with
        {
            Contract = published.Contract with
            {
                IsDeleted = true
            }
        });

        ArticleScalePlanValidationResult validation = Validate(tampered);
        Assert.False(validation.IsValid);
        Assert.Contains("variant contract for Published is incomplete or stale", validation.Errors);
    }

    private static ArticleScaleArtifactBindings Artifacts()
        => new(
            new(
                ArticleScaleContractIds.TemporalArtifactSchema,
                "config/testing/resolved-temporal-roles",
                "data-scale.lifecycle",
                Digest('1')),
            new(
                ArticleScaleContractIds.FixtureVariantCatalogSchema,
                "config/testing/fixture-variant-catalog",
                ArticleScaleContractIds.DistributionShape,
                Digest('2')),
            [
                new(
                    ArticleScaleContractIds.ContentShapeCatalogSchema,
                    "config/testing/content-shape-catalog",
                    "script.zh-hans",
                    Digest('3'))
            ],
            [
                new(
                    ArticleScaleContractIds.MediaShapeCatalogSchema,
                    "config/testing/media-shape-catalog",
                    "webp-landscape",
                    Digest('4')),
                new(
                    ArticleScaleContractIds.MediaShapeCatalogSchema,
                    "config/testing/media-shape-catalog",
                    "no-cover",
                    Digest('5'))
            ],
            [
                new(
                    ArticleScaleContractIds.FixtureVariantCatalogSchema,
                    "config/testing/fixture-variant-catalog",
                    ArticleScaleContractIds.TaxonomyShape,
                    Digest('6'))
            ]);

    private static ArticleScaleVariantAllocation Allocation(
        ArticleScalePlan plan,
        ArticleScaleVariant variant)
        => plan.StateDistribution.Single(item => item.Variant == variant);

    private static long ExpectedRows(ArticleScalePlan plan, ArticleScaleRowKind kind)
        => plan.Postconditions.ExpectedRows.Single(item => item.Kind == kind).Count;

    private static void AssertRowCount(
        ArticleScaleVariantContract contract,
        ArticleScaleRowKind kind,
        int count)
        => Assert.Equal(count, contract.Rows.Single(item => item.Kind == kind).CountPerArticle);

    private static ArticleScalePlan ReplaceAllocation(
        ArticleScalePlan plan,
        ArticleScaleVariantAllocation replacement)
        => Reseal(plan with
        {
            StateDistribution = plan.StateDistribution
                .Select(item => item.Variant == replacement.Variant ? replacement : item)
                .ToArray()
        });

    private static ArticleScalePlan Reseal(ArticleScalePlan plan)
        => plan with
        {
            ContentDigest = ArticleScalePlanDigest.Compute(plan)
        };

    private static ArticleScalePlanValidationResult Validate(ArticleScalePlan plan)
        => ArticleScalePlanValidator.Validate(plan, Artifacts());

    private static string Digest(char value) => "sha256:" + new string(value, 64);
}
