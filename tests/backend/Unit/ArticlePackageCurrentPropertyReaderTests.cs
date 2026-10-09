using System.Text;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleProperties;

using NSubstitute;

namespace FsusBlog.Tests.Unit;

// These are controlled source-port tests, not actual database, permission or signed-audit receipts.
public sealed class ArticlePackageCurrentPropertyReaderTests
{
    private static readonly Guid s_definitionId = Id(1);
    private static readonly Guid s_optionId = Id(2);
    private static readonly ArticlePropertyDefinitionOwner s_owner = new(42, "primary-site");
    private static readonly DateTime s_now = new(2026, 10, 9, 0, 0, 0, DateTimeKind.Utc);
    private static readonly ArticlePropertySnapshotCoordinates s_coordinates = new(42, "primary-site", 7, 3, 100);

    [Theory]
    [InlineData(ArticlePropertyValueType.Text)]
    [InlineData(ArticlePropertyValueType.Number)]
    [InlineData(ArticlePropertyValueType.Boolean)]
    [InlineData(ArticlePropertyValueType.Date)]
    [InlineData(ArticlePropertyValueType.SingleSelect)]
    [InlineData(ArticlePropertyValueType.MultiSelect)]
    [InlineData(ArticlePropertyValueType.ArticleReference)]
    [InlineData(ArticlePropertyValueType.Url)]
    public async Task SourcePortMapsEightExactTypesAndRebindsDecodedV1(ArticlePropertyValueType type)
    {
        ArticlePropertyValueReadModel model = Model(type);
        ArticlePackagePropertyMappingBindings bindings = Bindings(model);
        var (reader, authority) = Reader(model);
        ArticlePackageCurrentPropertyReadResult result = await reader.ReadAndMapAsync(42, bindings);
        Assert.True(result.IsValid, result.ReasonCode);
        Assert.Same(model.Current, result.Projection!.Source);
        Assert.Equal(42, result.Projection.ActorAdminPrincipalId);
        Assert.False(result.Projection.Component.RequirePropertyAuthority().IsValid);
        byte[] bytes = ArticlePackageManifestCandidateCodec.WritePropertyCandidate(result.Projection.Component);
        Assert.True(ArticlePackageManifestCandidateCodec.TryParsePropertyCandidate(bytes, out var decoded).IsValid);
        ArticlePackageCurrentPropertyReadResult rebound = await reader.ReadAndMapAsync(42, bindings, decoded);
        Assert.True(rebound.IsValid, rebound.ReasonCode);
        Assert.Equal(bytes, ArticlePackageManifestCandidateCodec.WritePropertyCandidate(rebound.Projection!.Component));
        await authority.Received(4).ReadAsync(42, s_owner, 7, Arg.Any<CancellationToken>());
        Assert.DoesNotContain("audit", Encoding.UTF8.GetString(bytes), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(model.Current!.AuditRecordHash, Encoding.UTF8.GetString(bytes));
        Assert.Equal(model.Current.SnapshotId, result.Projection.Source.AuditReference);
    }

    [Fact]
    public async Task HistoricalInactiveOptionAndReconciliationArePreservedWithoutNewValueAdmission()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.SingleSelect);
        definition = Seal(definition with
        {
            Options = [definition.Options[0] with { Status = ArticlePropertyOptionStatus.Deprecated }]
        });
        ArticlePropertyValueReadModel model = Model(ArticlePropertyValueType.SingleSelect, definition);
        model = model with
        {
            Reconciliation = [new(s_definitionId, ArticlePropertyValueReconciliationStatus.ValueRejected, "value_rejected")]
        };
        var result = await Reader(model).Reader.ReadAndMapAsync(42, Bindings(model));
        Assert.True(result.IsValid, result.ReasonCode);
        Assert.Equal(s_optionId, Assert.IsType<ArticlePropertySingleSelectValue>(
            Assert.Single(result.Projection!.Source.Snapshot.Values).Value).OptionId);
        Assert.Equal(model.Reconciliation, result.Projection.Reconciliation);
        Assert.False(result.Projection.Component.RequirePropertyAuthority().IsValid);
    }

    [Theory]
    [InlineData(ArticlePropertyValuePresence.Missing, false)]
    [InlineData(ArticlePropertyValuePresence.Null, false)]
    [InlineData(ArticlePropertyValuePresence.Present, false)]
    [InlineData(ArticlePropertyValuePresence.Present, true)]
    public async Task MissingNullEmptyAndDefaultOriginAreNotRenormalized(ArticlePropertyValuePresence presence, bool applied)
    {
        ArticlePropertyValueReadModel model = Model(ArticlePropertyValueType.Text, presence: presence, defaultApplied: applied);
        var result = await Reader(model).Reader.ReadAndMapAsync(42, Bindings(model));
        Assert.True(result.IsValid, result.ReasonCode);
        ArticlePackageMappedProperty row = Assert.Single(result.Projection!.Component.Mapping.Properties);
        Assert.Equal(presence, row.Presence);
        Assert.Equal(applied, row.DefaultApplied);
        Assert.Equal(model.Current!.Snapshot.Values[0].ValueDigest, row.SourceValueDigest);
    }

    [Theory]
    [InlineData("owner")]
    [InlineData("site")]
    [InlineData("article")]
    [InlineData("revision")]
    [InlineData("property-revision")]
    [InlineData("publication")]
    public async Task ExactObservedCoordinatesRejectEveryDrift(string field)
    {
        var model = Model(ArticlePropertyValueType.Boolean);
        var coordinates = field switch
        {
            "owner" => s_coordinates with { DefinitionOwnerUserId = 43 },
            "site" => s_coordinates with { SiteScope = "other-site" },
            "article" => s_coordinates with { ArticleId = 8 },
            "revision" => s_coordinates with { ArticleRevisionId = 101 },
            "property-revision" => s_coordinates with { PropertyRevision = 4 },
            _ => s_coordinates with { PublicationId = 200 }
        };
        var changed = model with
        {
            Current = model.Current! with
            {
                Snapshot = ArticlePropertyValueValidator.BindSnapshot(coordinates, model.Current.Snapshot.Values)
            }
        };
        await Reject(Reader(changed).Reader, Bindings(model), "article_package_property_read_coordinates_mismatch");
    }

    [Theory]
    [InlineData("snapshot")]
    [InlineData("factset")]
    [InlineData("audit-reference")]
    [InlineData("audit-chain")]
    [InlineData("audit-hash")]
    public async Task PersistedProvenanceMustBeStructurallyComplete(string field)
    {
        var model = Model(ArticlePropertyValueType.Boolean);
        var source = field switch
        {
            "snapshot" => model.Current! with { SnapshotId = Guid.Empty },
            "factset" => model.Current! with { FactsetId = Guid.Empty },
            "audit-reference" => model.Current! with { AuditReference = Id(999) },
            "audit-chain" => model.Current! with { AuditChainId = "20261301" },
            _ => model.Current! with { AuditRecordHash = "not-a-hash" }
        };
        await Reject(Reader(model with
        {
            Current = source
        }).Reader, Bindings(model),
            "article_package_property_persisted_provenance_invalid");
    }

    [Theory]
    [InlineData("definition-owner")]
    [InlineData("definition-digest")]
    [InlineData("definition-schema")]
    [InlineData("missing-definition")]
    [InlineData("option")]
    [InlineData("type")]
    public async Task ActualDefinitionsAndTypedStorageCannotBeReplacedByBindings(string field)
    {
        var model = Model(ArticlePropertyValueType.SingleSelect);
        ArticlePropertyDefinition definition = model.Definitions[0];
        definition = field switch
        {
            "definition-owner" => Seal(definition with { Owner = new(43, "primary-site") }),
            "definition-digest" => definition with { ContentDigest = new string('b', 64) },
            "definition-schema" => Seal(definition with { SchemaRevision = 0 }),
            "option" => Seal(definition with { Options = [definition.Options[0] with { OptionId = Id(99) }] }),
            "type" => Definition(ArticlePropertyValueType.Text),
            _ => definition
        };
        var changed = model with
        {
            Definitions = field == "missing-definition" ? [] : [definition]
        };
        var result = await Reader(changed).Reader.ReadAndMapAsync(42, Bindings(model));
        Assert.False(result.IsValid);
        Assert.Null(result.Projection);
    }

    [Theory]
    [InlineData("snapshot")]
    [InlineData("factset")]
    [InlineData("audit-chain")]
    [InlineData("audit-hash")]
    [InlineData("reconciliation")]
    public async Task RepeatedReadDetectsResealedIdentityOrAuthorityObservationDrift(string field)
    {
        var model = Model(ArticlePropertyValueType.Boolean);
        var changed = field switch
        {
            "snapshot" => model with { Current = model.Current! with { SnapshotId = Id(20), AuditReference = Id(20) } },
            "factset" => model with { Current = model.Current! with { FactsetId = Id(21) } },
            "audit-chain" => model with { Current = model.Current! with { AuditChainId = "20261010" } },
            "audit-hash" => model with { Current = model.Current! with { AuditRecordHash = new string('b', 64) } },
            _ => model with { Reconciliation = [new(s_definitionId, ArticlePropertyValueReconciliationStatus.ValueRejected, "rejected")] }
        };
        await Reject(Reader(model, changed).Reader, Bindings(model), "article_package_property_read_drift");
    }

    [Fact]
    public async Task MissingPersistedHeadNeverBecomesEmptySnapshot()
    {
        var model = Model(ArticlePropertyValueType.Text);
        await Reject(Reader(model with
        {
            Current = null,
            PropertyRevision = 0
        }).Reader, Bindings(model),
            "article_package_property_persisted_head_unavailable");
    }

    [Fact]
    public async Task UnsupportedDraftIsRefusedBeforeCurrentRead()
    {
        var model = Model(ArticlePropertyValueType.Text);
        var (reader, authority) = Reader(model);
        var bindings = Bindings(model);
        var draft = new ArticlePackagePropertyMappingBindings(s_coordinates with
        {
            DraftId = 5,
            DraftServerRevision = 2
        },
            bindings.SourceSnapshotDigest, bindings.Definitions, bindings.Options, bindings.Articles);
        await Reject(reader, draft, "article_package_property_draft_read_authority_unavailable");
        await authority.DidNotReceiveWithAnyArgs().ReadAsync(default, default, default);
    }

    [Fact]
    public async Task NonemptyReferenceRequiresRealOperationAuthority()
    {
        var model = Model(ArticlePropertyValueType.ArticleReference, referenceTarget: 8);
        await Reject(Reader(model).Reader, Bindings(model),
            "article_package_property_reference_operation_authority_unavailable");
    }

    [Fact]
    public async Task CanonicalAccessDenialAndInterruptedReadsPropagateWithoutProjection()
    {
        var model = Model(ArticlePropertyValueType.Text);
        var authority = Substitute.For<IArticlePropertyValueAuthority>();
        authority.ReadAsync(42, s_owner, 7, Arg.Any<CancellationToken>())
            .Returns<Task<ArticlePropertyValueReadModel>>(_ => throw new ArticlePropertyDefinitionAccessDeniedException());
        await Assert.ThrowsAsync<ArticlePropertyDefinitionAccessDeniedException>(() =>
            new ArticlePackageCurrentPropertyReader(authority).ReadAndMapAsync(42, Bindings(model)));
        using var cancellation = new CancellationTokenSource();
        authority.ReadAsync(42, s_owner, 7, Arg.Any<CancellationToken>()).Returns(_ =>
        {
            cancellation.Cancel();
            return Task.FromResult(model);
        });
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            new ArticlePackageCurrentPropertyReader(authority).ReadAndMapAsync(42, Bindings(model),
                cancellationToken: cancellation.Token));
    }

    [Fact]
    public async Task ResealedPayloadStillMustMatchActualDefinitionType()
    {
        var model = Model(ArticlePropertyValueType.Text);
        var row = model.Current!.Snapshot.Values[0];
        var input = new ArticlePropertyValueInput(row.DefinitionId, row.DefinitionSchemaRevision,
            row.DefinitionDigest, row.Presence, new ArticlePropertyBooleanValue(false));
        var forged = row with
        {
            Value = input.Value,
            ValueDigest = ArticlePropertyValueDigest.ComputeValue(input)
        };
        var changed = model with
        {
            Current = model.Current with
            {
                Snapshot = ArticlePropertyValueValidator.BindSnapshot(s_coordinates, [forged])
            }
        };
        await Reject(Reader(changed).Reader, Bindings(changed), "article_package_property_definition_type_mismatch");
    }

    [Fact]
    public async Task PermissionRevokedOnSecondReadCannotReturnFirstProjection()
    {
        var model = Model(ArticlePropertyValueType.Text);
        var authority = Substitute.For<IArticlePropertyValueAuthority>();
        int reads = 0;
        authority.ReadAsync(42, s_owner, 7, Arg.Any<CancellationToken>()).Returns(_ =>
            ++reads == 1 ? Task.FromResult(model) : throw new ArticlePropertyDefinitionAccessDeniedException());
        await Assert.ThrowsAsync<ArticlePropertyDefinitionAccessDeniedException>(() =>
            new ArticlePackageCurrentPropertyReader(authority).ReadAndMapAsync(42, Bindings(model)));
        Assert.Equal(2, reads);
    }

    [Fact]
    public async Task CurrentInactiveDefinitionObservationsDoNotRewriteHistoricalValueEpoch()
    {
        var historical = Model(ArticlePropertyValueType.SingleSelect);
        var currentDefinition = Seal(historical.Definitions[0] with
        {
            SchemaRevision = 2,
            Options = [historical.Definitions[0].Options[0] with { Status = ArticlePropertyOptionStatus.Deprecated }]
        });
        var current = historical with
        {
            Definitions = [currentDefinition],
            Reconciliation = [new(s_definitionId, ArticlePropertyValueReconciliationStatus.DefinitionChanged, "definition_changed")]
        };
        var result = await Reader(current).Reader.ReadAndMapAsync(42, Bindings(historical));
        Assert.True(result.IsValid, result.ReasonCode);
        var row = Assert.Single(result.Projection!.Component.Mapping.Properties);
        Assert.Equal(1, row.SourceSchemaRevision);
        Assert.Equal(historical.Definitions[0].ContentDigest, row.SourceDefinitionDigest);
        Assert.Equal(2, Assert.Single(result.Projection.Definitions).SchemaRevision);
        Assert.Equal(currentDefinition.ContentDigest, result.Projection.Definitions[0].ContentDigest);
        Assert.Same(historical.Current, result.Projection.Source);
        Assert.False(result.Projection.Component.RequirePropertyAuthority().IsValid);
    }

    [Fact]
    public async Task CurrentDefinitionEpochMovementIsDetectedEvenWhenImmutableValuesAreUnchanged()
    {
        var model = Model(ArticlePropertyValueType.Boolean);
        var changed = model with
        {
            Definitions = [Seal(model.Definitions[0] with { SchemaRevision = 2 })]
        };
        await Reject(Reader(model, changed).Reader, Bindings(model), "article_package_property_read_drift");
    }

    [Fact]
    public async Task ExistingPlannerUsesObservedRowsInsteadOfAssertedPropertySnapshot()
    {
        var model = Model(ArticlePropertyValueType.Text);
        var input = PlannerInput(model);
        var badSnapshot = new ArticlePropertyValueSnapshot(1, s_coordinates, input.PropertySnapshot.Values, new string('b', 64));
        var asserted = new ArticlePackageManifestCandidateInput(input.Article, input.TitleBinding,
            badSnapshot, input.PropertyBindings, Encoding.UTF8.GetBytes(input.Article.MarkdownContent));
        Assert.False(ArticlePackageManifestCandidatePlanner.TryCreateCandidatePlan([asserted], out _).IsValid);
        var result = await ArticlePackageManifestCandidatePlanner.ReadCurrentPropertiesAndCreateCandidatePlanAsync(
            42, [asserted], Reader(model).Reader);
        Assert.True(result.IsValid, result.ReasonCode);
        Assert.Same(model.Current, Assert.Single(result.Sources!).Source);
        Assert.Equal(model.Current!.Snapshot.ContentDigest,
            Assert.Single(result.Plan!.Articles).Properties.SourceSnapshotDigest);
        Assert.False(result.Plan.RequirePackageAuthority().IsValid);
    }

    [Fact]
    public async Task PlannerRefusalCannotExposePartialPlanOrObservedSources()
    {
        var model = Model(ArticlePropertyValueType.Text);
        var missing = model with
        {
            Current = null
        };
        var result = await ArticlePackageManifestCandidatePlanner.ReadCurrentPropertiesAndCreateCandidatePlanAsync(
            42, [PlannerInput(model)], Reader(missing).Reader);
        Assert.False(result.IsValid);
        Assert.Null(result.Plan);
        Assert.Null(result.Sources);
    }

    [Fact]
    public async Task PlannerRejectsOversizedArticleSetBeforeAnyPropertyRead()
    {
        var model = Model(ArticlePropertyValueType.Text);
        var (reader, authority) = Reader(model);
        var inputs = Enumerable.Repeat(PlannerInput(model), 1001).ToArray();
        var result = await ArticlePackageManifestCandidatePlanner.ReadCurrentPropertiesAndCreateCandidatePlanAsync(42, inputs, reader);
        Assert.False(result.IsValid);
        Assert.Null(result.Plan);
        Assert.Null(result.Sources);
        await authority.DidNotReceiveWithAnyArgs().ReadAsync(default, default, default);
    }

    private static ArticlePackageManifestCandidateInput PlannerInput(ArticlePropertyValueReadModel model)
    {
        var article = new ArticleCanonicalInput(7, 100, 1, "route", "Title", null, null, 1, [],
            ArticleStatusValues.Draft, null, null, "# Body\r\nexact  \r\n");
        Assert.True(ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article, "article:" + Id(7).ToString("D"),
            out var portable).IsValid);
        var title = new ArticlePackageTitleSummaryBinding(7, 100, 1, ArticleCanonicalHashV1.ComputeHashHex(article), portable);
        return new(article, title, model.Current!.Snapshot, Bindings(model), Encoding.UTF8.GetBytes(article.MarkdownContent));
    }

    private static async Task Reject(ArticlePackageCurrentPropertyReader reader,
        ArticlePackagePropertyMappingBindings bindings, string reason)
    {
        var result = await reader.ReadAndMapAsync(42, bindings);
        Assert.False(result.IsValid);
        Assert.Equal(reason, result.ReasonCode);
        Assert.Null(result.Projection);
    }

    private static (ArticlePackageCurrentPropertyReader Reader, IArticlePropertyValueAuthority Authority) Reader(
        ArticlePropertyValueReadModel model, ArticlePropertyValueReadModel? second = null)
    {
        var authority = Substitute.For<IArticlePropertyValueAuthority>();
        authority.ReadAsync(42, s_owner, 7, Arg.Any<CancellationToken>()).Returns(model, second ?? model);
        return (new(authority), authority);
    }

    private static ArticlePropertyValueReadModel Model(ArticlePropertyValueType type,
        ArticlePropertyDefinition? definition = null, ArticlePropertyValuePresence presence = ArticlePropertyValuePresence.Present,
        bool defaultApplied = false, long? referenceTarget = null)
    {
        definition ??= Definition(type);
        ArticlePropertyTypedValue value = type switch
        {
            ArticlePropertyValueType.Text => new ArticlePropertyTextValue(""),
            ArticlePropertyValueType.Number => new ArticlePropertyNumberValue(0.0000000000000000000000000001m),
            ArticlePropertyValueType.Boolean => new ArticlePropertyBooleanValue(false),
            ArticlePropertyValueType.Date => new ArticlePropertyDateValue(s_now.AddTicks(1)),
            ArticlePropertyValueType.SingleSelect => new ArticlePropertySingleSelectValue(s_optionId),
            ArticlePropertyValueType.MultiSelect => new ArticlePropertyMultiSelectValue([s_optionId]),
            ArticlePropertyValueType.ArticleReference => new ArticlePropertyArticleReferenceValue(referenceTarget.HasValue ? [referenceTarget.Value] : []),
            ArticlePropertyValueType.Url => new ArticlePropertyUrlValue("https://example.com/path"),
            _ => throw new ArgumentOutOfRangeException(nameof(type))
        };
        var input = new ArticlePropertyValueInput(s_definitionId, definition.SchemaRevision, definition.ContentDigest,
            presence, presence == ArticlePropertyValuePresence.Present ? value : null);
        var entry = new ArticlePropertyValueEntry(input.DefinitionId, input.DefinitionSchemaRevision, input.DefinitionDigest,
            presence, input.Value, ArticlePropertyValueDigest.ComputeValue(input, defaultApplied), defaultApplied);
        var snapshot = ArticlePropertyValueValidator.BindSnapshot(s_coordinates, [entry]);
        var persisted = new ArticlePropertyValuePersistedSnapshot(Id(10), Id(11), snapshot, Id(10), "20261009", new string('a', 64));
        return new(7, 100, 3, persisted, [definition],
            [new(s_definitionId, ArticlePropertyValueReconciliationStatus.Current, "current")]);
    }

    private static ArticlePackagePropertyMappingBindings Bindings(ArticlePropertyValueReadModel model)
        => new(model.Current!.Snapshot.Coordinates, model.Current.Snapshot.ContentDigest,
            [new(s_definitionId, model.Current.Snapshot.Values[0].DefinitionSchemaRevision,
                model.Current.Snapshot.Values[0].DefinitionDigest, Portable(ArticlePackageIdentityKind.Definition, 101))],
            model.Current.Snapshot.Values[0].Value is ArticlePropertySingleSelectValue or ArticlePropertyMultiSelectValue
                ? [new(s_definitionId, s_optionId, Portable(ArticlePackageIdentityKind.Option, 102))] : [], []);

    private static ArticlePropertyDefinition Definition(ArticlePropertyValueType type)
    {
        bool multiple = type is ArticlePropertyValueType.MultiSelect or ArticlePropertyValueType.ArticleReference;
        var cardinality = multiple ? ArticlePropertyCardinality.Multiple : ArticlePropertyCardinality.Single;
        return Seal(new(1, s_definitionId, s_owner, "field", [new("en", "Field")], type, cardinality, false,
            new(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull, ArticlePropertyEmptyBehavior.PreserveEmpty),
            null, new(), type is ArticlePropertyValueType.SingleSelect or ArticlePropertyValueType.MultiSelect
                ? [new(s_optionId, "One", 0, ArticlePropertyOptionStatus.Active)] : [],
            type == ArticlePropertyValueType.ArticleReference ? new(cardinality,
                ArticlePropertyReferencePermission.SourceActorMustReadTarget, false, false, false, false, false) : null,
            type == ArticlePropertyValueType.Url ? new(["https"], false, true, 2048, ArticlePropertyUrlNormalization.LowerSchemeHost) : null,
            false, false, false, ArticlePropertyDisplayPlacement.Metadata, ArticlePropertyVisibilityScope.AuthorOnly,
            ArticlePropertyDefinitionStatus.Active, 1, s_now, s_now, ""));
    }

    private static ArticlePropertyDefinition Seal(ArticlePropertyDefinition definition)
        => definition with
        {
            ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(definition)
        };

    private static Guid Id(int number) => Guid.Parse($"00000000-0000-4000-8000-{number:x12}");

    private static ArticlePackageIdentity Portable(ArticlePackageIdentityKind kind, int number)
    {
        string prefix = kind switch
        {
            ArticlePackageIdentityKind.Definition => "portable-definition:",
            ArticlePackageIdentityKind.Option => "portable-option:",
            _ => throw new ArgumentOutOfRangeException(nameof(kind))
        };
        Assert.True(ArticlePackageIdentity.TryCreate(kind, prefix + Id(number).ToString("D"), out var identity).IsValid);
        return identity;
    }
}
