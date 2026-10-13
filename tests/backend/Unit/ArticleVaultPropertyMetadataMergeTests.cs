using System.Collections.Immutable;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleProperties;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Real canonical APIs with contract fixtures, not persisted-reader or permission evidence.</summary>
[Trait("Category", "Unit")]
public sealed partial class ArticleVaultPropertyMetadataMergeTests
{
    private static readonly string s_digest = new('a', 64);
    private static readonly Guid s_first = Guid.Parse("21180000-0000-4000-8000-000000000001");
    private static readonly Guid s_second = Guid.Parse("21180000-0000-4000-8000-000000000002");
    private static readonly Guid s_third = Guid.Parse("21180000-0000-4000-8000-000000000003");
    private static readonly Guid s_optionA = Guid.Parse("21180000-0000-4000-8000-000000000101");
    private static readonly Guid s_optionB = Guid.Parse("21180000-0000-4000-8000-000000000102");
    private static readonly Guid s_optionC = Guid.Parse("21180000-0000-4000-8000-000000000103");

    [Fact]
    public void DisjointProperties_PreserveFalseZeroMissingNullAndNeverAdmitExecution()
    {
        ArticleVaultPropertyMetadataInput input = Fixture(
            [Entry(s_first, new ArticlePropertyBooleanValue(false)), Entry(s_second, new ArticlePropertyNumberValue(0)), Entry(s_third, null, ArticlePropertyValuePresence.Missing)],
            [Entry(s_first, new ArticlePropertyBooleanValue(true)), Entry(s_second, new ArticlePropertyNumberValue(0)), Entry(s_third, null, ArticlePropertyValuePresence.Missing)],
            [Entry(s_first, new ArticlePropertyBooleanValue(false)), Entry(s_second, new ArticlePropertyNumberValue(1)), Entry(s_third, null, ArticlePropertyValuePresence.Null)]);
        ArticleVaultPropertyMetadataCandidate candidate = Candidate(input);

        Assert.Equal([VaultPropertyChoiceOrigin.Local, VaultPropertyChoiceOrigin.Server, VaultPropertyChoiceOrigin.Server],
            candidate.Choices.Select(static choice => choice.Origin));
        Assert.Equal(new ArticlePropertyBooleanValue(false),
            Assert.IsType<ArticlePackagePrimitivePropertyProjection>(candidate.Base.Properties[0].Projection).Value);
        Assert.Equal(new ArticlePropertyNumberValue(0),
            Assert.IsType<ArticlePackagePrimitivePropertyProjection>(candidate.Base.Properties[1].Projection).Value);
        Assert.Equal(ArticlePropertyValuePresence.Missing, candidate.Base.Properties[2].Presence);
        Assert.Equal(ArticlePropertyValuePresence.Null, candidate.Server.Properties[2].Presence);
        Assert.True(candidate.RequiresCurrentDefinitionAndRightsAdmission);
        Assert.True(ArticleVaultPropertyMetadataMerge.VerifyCurrentCandidate(input, candidate).IsValid);
        Assert.Equal("article_vault_property_metadata_current_definition_rights_and_persisted_reader_missing",
            ArticleVaultPropertyMetadataMerge.RequireExecutionAdmission(input, candidate).ReasonCode);
        Assert.Equal(VaultSyncPlanStatus.Blocked, input.Source.Plan.Status);
    }

    [Fact]
    public void SamePropertyDifferentScalarValues_PreservesStructuralOverlap()
    {
        ArticleVaultPropertyMetadataInput input = Fixture([Entry(s_first, new ArticlePropertyTextValue("base"))],
            [Entry(s_first, new ArticlePropertyTextValue("local"))], [Entry(s_first, new ArticlePropertyTextValue("server"))]);
        ArticleVaultPropertyMetadataResult result = ArticleVaultPropertyMetadataMerge.Build(input);
        Assert.Null(result.Candidate);
        Assert.Equal("article_vault_property_metadata_overlap", result.ReasonCode);
        Assert.Equal(Definition(s_first), Assert.Single(result.OverlappingDefinitions));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void EquivalentAndNoop_AreDerivedFromActualPortableValueDigests(bool changed)
    {
        ArticlePropertyValueEntry baseline = Entry(s_first, new ArticlePropertyBooleanValue(false));
        ArticlePropertyValueEntry selected = Entry(s_first, new ArticlePropertyBooleanValue(changed));
        ArticleVaultPropertyMetadataInput input = Fixture([baseline], [selected], [selected]);
        ArticleVaultPropertyMetadataCandidate candidate = Candidate(input);
        Assert.Equal(changed ? VaultPropertyChoiceOrigin.Equivalent : VaultPropertyChoiceOrigin.Base,
            Assert.Single(candidate.Choices).Origin);
        Assert.True(ArticleVaultPropertyMetadataMerge.VerifyCurrentCandidate(input, candidate).IsValid);
    }

    [Fact]
    public void MultiSelect_MergesActualDefinitionScopedOptionDeltas()
    {
        ArticleVaultPropertyMetadataInput input = Fixture([Entry(s_first, new ArticlePropertyMultiSelectValue([s_optionA]))],
            [Entry(s_first, new ArticlePropertyMultiSelectValue([s_optionA, s_optionB]))],
            [Entry(s_first, new ArticlePropertyMultiSelectValue([s_optionC]))]);
        ArticleVaultPropertyMetadataCandidate candidate = Candidate(input);
        ArticleVaultPropertyChoice choice = Assert.Single(candidate.Choices);
        Assert.Equal(VaultPropertyChoiceOrigin.MergedOptions, choice.Origin);
        Assert.Equal(new[] { Option(s_optionB), Option(s_optionC) }, choice.MergedOptions.ToArray());
        Assert.True(ArticleVaultPropertyMetadataMerge.VerifyCurrentCandidate(input, candidate).IsValid);
        Assert.Equal(input.Base.Snapshot.ContentDigest, candidate.Base.SourceSnapshotDigest);
    }

    [Theory]
    [InlineData("schema")]
    [InlineData("default")]
    [InlineData("type")]
    public void SchemaDefaultAndTypeConflicts_RefuseRatherThanMerge(string fault)
    {
        ArticlePropertyValueEntry original = Entry(s_first, new ArticlePropertyBooleanValue(false));
        ArticlePropertyValueEntry changed = fault switch
        {
            "schema" => Entry(s_first, new ArticlePropertyBooleanValue(true), revision: 2),
            "default" => Entry(s_first, new ArticlePropertyBooleanValue(false), defaultApplied: true),
            _ => Entry(s_first, new ArticlePropertyNumberValue(0))
        };
        ArticleVaultPropertyMetadataResult result = ArticleVaultPropertyMetadataMerge.Build(Fixture([original], [changed], [original]));
        Assert.Null(result.Candidate);
        Assert.Equal("article_vault_property_metadata_" + (fault switch
        {
            "schema" => "definition_schema_drift",
            "default" => "default_provenance_conflict",
            _ => "typed_value_conflict"
        }), result.ReasonCode);
    }

    [Fact]
    public void DefaultProvenance_IsRetainedWhenAllThreeSnapshotsAgree()
    {
        ArticlePropertyValueEntry entry = Entry(s_first, new ArticlePropertyNumberValue(0), defaultApplied: true);
        ArticleVaultPropertyMetadataInput input = Fixture([entry], [entry], [entry]);
        ArticleVaultPropertyMetadataCandidate candidate = Candidate(input);
        Assert.All(new[] { candidate.Base, candidate.Local, candidate.Server },
            static mapped => Assert.True(Assert.Single(mapped.Properties).DefaultApplied));
    }

    [Theory]
    [InlineData("site")]
    [InlineData("article")]
    [InlineData("revision")]
    [InlineData("properties-sha")]
    [InlineData("snapshot-digest")]
    public void ActualTypedSnapshotAndMetadataBindings_RejectDrift(string fault)
    {
        ArticleVaultPropertyMetadataInput input = BooleanFixture();
        ArticlePropertySnapshotCoordinates coordinates = input.Local.Snapshot.Coordinates;
        coordinates = fault switch
        {
            "site" => coordinates with { SiteScope = "other-site" },
            "article" => coordinates with { ArticleId = 8 },
            "revision" => coordinates with { ArticleRevisionId = 900 },
            _ => coordinates
        };
        ArticlePropertyValueEntry[] entries = fault == "properties-sha"
            ? [Entry(s_first, new ArticlePropertyBooleanValue(true))] : input.Local.Snapshot.Values.ToArray();
        ArticlePropertyValueSnapshot snapshot = Snapshot(entries, coordinates);
        if (fault == "snapshot-digest")
        {
            snapshot = new(snapshot.SchemaVersion, snapshot.Coordinates, snapshot.Values, new string('b', 64));
        }
        ArticleVaultPropertyMetadataInput changed = input with
        {
            Local = new(snapshot, Bindings(snapshot))
        };
        Assert.Null(ArticleVaultPropertyMetadataMerge.Build(changed).Candidate);
    }

    [Theory]
    [InlineData("draft")]
    [InlineData("publication")]
    public void UnrepresentedDraftOrPublicationContext_RequiresActualOwnerMapping(string context)
    {
        ArticlePropertyValueEntry[] entries = [Entry(s_first, new ArticlePropertyBooleanValue(false))];
        ArticleVaultPropertyMetadataInput input = Fixture(entries, entries, entries, context);
        ArticleVaultPropertyMetadataResult result = ArticleVaultPropertyMetadataMerge.Build(input);
        Assert.Null(result.Candidate);
        Assert.Equal("article_vault_property_metadata_snapshot_context_mapping_missing", result.ReasonCode);
    }

    [Theory]
    [InlineData("source")]
    [InlineData("operation")]
    [InlineData("group")]
    [InlineData("coordinate")]
    [InlineData("observer")]
    public void OriginalPlanAndActualSourceBytes_RejectStaleCoordinates(string fault)
    {
        ArticleVaultPropertyMetadataInput input = BooleanFixture();
        ArticleVaultSourceAdmissionInput source = input.Source;
        VaultConflictBinding binding = source.Binding;
        ArticleVaultSourceAdmissionInput changed = fault switch
        {
            "source" => source with { LocalBytes = "changed bytes\n"u8.ToArray() },
            "operation" => source with { Binding = binding with { OperationIdentity = "wrong-operation" } },
            "group" => source with { Binding = binding with { GroupIdentity = "wrong-group" } },
            "coordinate" => source with { Binding = binding with { Coordinates = binding.Coordinates with { Server = binding.Coordinates.Base } } },
            _ => source with { Observations = [] }
        };
        Assert.Null(ArticleVaultPropertyMetadataMerge.Build(input with
        {
            Source = changed
        }).Candidate);
    }

    [Theory]
    [InlineData("unknown")]
    [InlineData("malformed")]
    [InlineData("cross-vault")]
    public void ClosedMetadataReader_RejectsUnknownMalformedAndCrossBindingBytes(string fault)
    {
        ArticleVaultPropertyMetadataInput input = BooleanFixture();
        byte[] bytes = input.LocalMetadataBytes.ToArray();
        if (fault == "malformed")
        {
            bytes = "{"u8.ToArray();
        }
        else
        {
            JsonObject json = Assert.IsType<JsonObject>(JsonNode.Parse(bytes));
            json[fault == "unknown" ? "unknown" : "vaultIdentity"] = "other-vault";
            bytes = Encoding.UTF8.GetBytes(json.ToJsonString());
        }
        Assert.Null(ArticleVaultPropertyMetadataMerge.Build(input with
        {
            LocalMetadataBytes = bytes
        }).Candidate);
    }

    [Fact]
    public void MissingOptionMapping_AndCrossSnapshotAlias_AreRejected()
    {
        ArticleVaultPropertyMetadataInput input = Fixture(
            [Entry(s_first, new ArticlePropertyMultiSelectValue([s_optionA])), Entry(s_second, new ArticlePropertyMultiSelectValue([s_optionB]))],
            [Entry(s_first, new ArticlePropertyMultiSelectValue([s_optionC])), Entry(s_second, new ArticlePropertyMultiSelectValue([s_optionB]))],
            [Entry(s_first, new ArticlePropertyMultiSelectValue([s_optionA])), Entry(s_second, new ArticlePropertyMultiSelectValue([s_optionB]))]);
        ArticlePackagePropertyMappingBindings valid = input.Local.Bindings;
        ArticlePackagePropertyMappingBindings missing = new(valid.SourceCoordinates, valid.SourceSnapshotDigest, valid.Definitions, [], []);
        Assert.Null(ArticleVaultPropertyMetadataMerge.Build(input with
        {
            Local = input.Local with
            {
                Bindings = missing
            }
        }).Candidate);
        ArticlePackagePropertyOptionBinding[] aliased = valid.Options.Select(option => option.SourceOptionId == s_optionC
            ? new ArticlePackagePropertyOptionBinding(option.SourceDefinitionId, option.SourceOptionId, Option(s_optionA)) : option).ToArray();
        ArticlePackagePropertyMappingBindings collision = new(valid.SourceCoordinates, valid.SourceSnapshotDigest, valid.Definitions, aliased, []);
        ArticleVaultPropertyMetadataResult result = ArticleVaultPropertyMetadataMerge.Build(input with
        {
            Local = input.Local with
            {
                Bindings = collision
            }
        });
        Assert.Null(result.Candidate);
        Assert.Equal("article_vault_property_metadata_option_definition_mapping_collision", result.ReasonCode);
    }

    [Fact]
    public void CandidateVerifier_RejectsChoiceAndPayloadTamperEvenAfterResealing()
    {
        ArticleVaultPropertyMetadataInput input = Fixture([Entry(s_first, new ArticlePropertyBooleanValue(false))],
            [Entry(s_first, new ArticlePropertyBooleanValue(true))], [Entry(s_first, new ArticlePropertyBooleanValue(false))]);
        ArticleVaultPropertyMetadataCandidate original = Candidate(input);
        ArticleVaultPropertyMetadataCandidate winner = Reseal(original,
            [original.Choices.Single() with { Origin = VaultPropertyChoiceOrigin.Server }]);
        Assert.False(ArticleVaultPropertyMetadataMerge.VerifyCurrentCandidate(input, winner).IsValid);
        ArticlePackageMappedProperty row = original.Local.Properties.Single();
        ArticlePackageMappedProperty altered = new(row.SourceDefinitionId, row.SourceSchemaRevision, row.SourceDefinitionDigest,
            row.PortableDefinition, row.SourceValueDigest, row.Presence, row.DefaultApplied, row.PortableValueDigest,
            new ArticlePackagePrimitivePropertyProjection(new ArticlePropertyBooleanValue(false)));
        ArticlePackagePropertyMappingCandidate payload = new(original.Local.SourceCoordinates, original.Local.SourceSnapshotDigest,
            [altered], original.Local.MappingDigest);
        ArticleVaultPropertyMetadataCandidate tampered = Reseal(original, original.Choices, payload);
        Assert.False(ArticleVaultPropertyMetadataMerge.VerifyCurrentCandidate(input, tampered).IsValid);
        Assert.False(ArticleVaultPropertyMetadataMerge.VerifyCurrentCandidate(input,
            new(original.Binding, original.Base, original.Local, original.Server, original.Choices, s_digest)).IsValid);
    }

    [Fact]
    public void CandidateVerifier_RejectsMergedOptionTamperAndMetadataChangedAfterBuild()
    {
        ArticleVaultPropertyMetadataInput input = Fixture([Entry(s_first, new ArticlePropertyMultiSelectValue([s_optionA]))],
            [Entry(s_first, new ArticlePropertyMultiSelectValue([s_optionA, s_optionB]))],
            [Entry(s_first, new ArticlePropertyMultiSelectValue([s_optionA, s_optionC]))]);
        ArticleVaultPropertyMetadataCandidate original = Candidate(input);
        ArticleVaultPropertyMetadataCandidate tampered = Reseal(original,
            [original.Choices.Single() with { MergedOptions = [Option(s_optionA)] }]);
        Assert.False(ArticleVaultPropertyMetadataMerge.VerifyCurrentCandidate(input, tampered).IsValid);
        Assert.False(ArticleVaultPropertyMetadataMerge.VerifyCurrentCandidate(input with
        {
            ServerMetadataBytes = input.BaseMetadataBytes
        }, original).IsValid);
    }

    [Fact]
    public void PackageBridge_BindsExactFiniteInputsAndPreservesSourceHold()
    {
        ArticleVaultPackagePropertyMetadataInput input = PackageFixture();
        ArticleVaultPackagePropertyMetadataResult result = ArticleVaultPackagePropertyMetadataBridge.Build(input);
        Assert.Null(result.ReasonCode);
        ArticleVaultPackagePropertyMetadataCandidate candidate = Assert.IsType<ArticleVaultPackagePropertyMetadataCandidate>(result.Candidate);
        Assert.Equal(VaultPropertyChoiceOrigin.Local, candidate.Properties.Choices.Single().Origin);
        Assert.Equal(3, candidate.PackageSemanticDigests.Length);
        Assert.True(ArticleVaultPackagePropertyMetadataBridge.VerifyCurrentCandidate(input, candidate).IsValid);
        Assert.True(candidate.SourceHold);
        Assert.False(candidate.CanExecute);
        Assert.False(candidate.CanCommitBase);
        Assert.True(candidate.Properties.RequiresCurrentDefinitionAndRightsAdmission);
        Assert.Equal("article_vault_package_property_source_hold_and_complete_metadata_authority_missing",
            ArticleVaultPackagePropertyMetadataBridge.RequireExecutionAdmission(input, candidate).ReasonCode);
    }

    [Fact]
    public void PackageBridge_RejectsBaseManifestReusedForLocalRevision()
    {
        ArticleVaultPackagePropertyMetadataInput input = PackageFixture();
        Assert.Equal("article_vault_package_property_projection_binding_drift",
            ArticleVaultPackagePropertyMetadataBridge.Build(input with
            {
                Local = input.Base
            }).ReasonCode);
    }

    [Theory]
    [InlineData("title")]
    [InlineData("site")]
    [InlineData("identity")]
    public void PackageBridge_RejectsIndependentlyResealedProjectionDrift(string field)
    {
        ArticleVaultPackagePropertyMetadataInput input = PackageFixture();
        ArticlePackageManifestCandidateInput actual = input.Local.Input;
        ArticleCanonicalInput article = field == "title" ? actual.Article with
        {
            Title = "different exact title"
        } : actual.Article;
        ArticlePropertyValueSnapshot snapshot = field == "site"
            ? Snapshot(actual.PropertySnapshot.Values, actual.PropertySnapshot.Coordinates with
            {
                SiteScope = "foreign-site"
            })
            : actual.PropertySnapshot;
        ArticlePackageIdentity portable = field == "identity"
            ? Parse(ArticlePackageIdentityKind.Article, "article:41180000-0000-4000-8000-000000000999")
            : actual.TitleBinding.PortableArticle;
        var binding = new ArticlePackageTitleSummaryBinding(actual.TitleBinding.SourceArticleId,
            actual.TitleBinding.SourceRevisionId, actual.TitleBinding.SourceRevisionNo,
            ArticleCanonicalHashV1.ComputeHashHex(article), portable);
        var changed = new ArticlePackageManifestCandidateInput(article, binding, snapshot, Bindings(snapshot), input.Metadata.Source.LocalBytes.Span);
        Assert.Equal("article_vault_package_property_projection_binding_drift",
            ArticleVaultPackagePropertyMetadataBridge.Build(input with
            {
                Local = PackageSnapshot(changed)
            }).ReasonCode);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void PackageBridge_RejectsCanonicalEquivalentBomOrNewlineDrift(bool bom)
    {
        ArticleVaultPackagePropertyMetadataInput input = PackageFixture();
        ArticlePackageManifestCandidateInput actual = input.Local.Input;
        string markdown = bom ? actual.Article.MarkdownContent : actual.Article.MarkdownContent.Replace("\r\n", "\n", StringComparison.Ordinal);
        byte[] bytes = bom ? [0xef, 0xbb, 0xbf, .. Encoding.UTF8.GetBytes(markdown)] : Encoding.UTF8.GetBytes(markdown);
        ArticleCanonicalInput article = actual.Article with
        {
            MarkdownContent = markdown
        };
        Assert.Equal(actual.TitleBinding.SourceCanonicalHash, ArticleCanonicalHashV1.ComputeHashHex(article));
        var changed = new ArticlePackageManifestCandidateInput(article, actual.TitleBinding,
            actual.PropertySnapshot, actual.PropertyBindings, bytes);
        Assert.Equal("article_vault_package_property_source_bytes_drift",
            ArticleVaultPackagePropertyMetadataBridge.Build(input with
            {
                Local = PackageSnapshot(changed)
            }).ReasonCode);
    }

    [Theory]
    [InlineData("assets")]
    [InlineData("taxonomy")]
    [InlineData("rights")]
    [InlineData("metadata")]
    public void PackageBridge_PreservesCanonicalUnknownCapabilityRefusal(string field)
    {
        ArticleVaultPackagePropertyMetadataInput input = PackageFixture();
        JsonObject document = JsonNode.Parse(input.Local.CandidateBytes.Span)!.AsObject();
        document[field] = new JsonObject();
        byte[] bytes = Encoding.UTF8.GetBytes(document.ToJsonString());
        ArticlePackageManifestCandidateResult expected = ArticlePackageManifestCandidateCodec.TryParseCandidate(bytes, out _);
        Assert.False(expected.IsValid);
        ArticleVaultPackagePropertyMetadataResult actual = ArticleVaultPackagePropertyMetadataBridge.Build(input with
        {
            Local = input.Local with
            {
                CandidateBytes = bytes
            }
        });
        Assert.Null(actual.Candidate);
        Assert.Equal(expected.ReasonCode, actual.ReasonCode);
    }

    [Fact]
    public void PackageBridge_RejectsVersionDriftAndRetainsExplicitOverlap()
    {
        ArticleVaultPackagePropertyMetadataInput input = PackageFixture();
        JsonObject document = JsonNode.Parse(input.Local.CandidateBytes.Span)!.AsObject();
        document["schemaVersion"] = 2;
        Assert.Equal("article_package_manifest_version_unsupported", ArticleVaultPackagePropertyMetadataBridge.Build(input with
        {
            Local = input.Local with
            {
                CandidateBytes = Encoding.UTF8.GetBytes(document.ToJsonString())
            }
        }).ReasonCode);
        ArticleVaultPropertyMetadataInput overlap = Fixture([Entry(s_first, new ArticlePropertyTextValue("base"))],
            [Entry(s_first, new ArticlePropertyTextValue("local"))], [Entry(s_first, new ArticlePropertyTextValue("server"))],
            portableIdentity: PackagePortableIdentity);
        ArticleVaultPackagePropertyMetadataResult result = ArticleVaultPackagePropertyMetadataBridge.Build(PackageFixture(overlap));
        Assert.Null(result.Candidate);
        Assert.Equal(Definition(s_first), Assert.Single(result.OverlappingDefinitions));
        Assert.Equal("article_vault_property_metadata_overlap", result.ReasonCode);
    }

    [Fact]
    public void PackageBridge_RefusesSlugProjectionMissingFromFiniteSchema()
    {
        ArticleVaultPropertyMetadataInput metadata = Fixture([Entry(s_first, new ArticlePropertyBooleanValue(false))],
            [Entry(s_first, new ArticlePropertyBooleanValue(true))], [Entry(s_first, new ArticlePropertyBooleanValue(false))],
            portableIdentity: PackagePortableIdentity, localSlug: "changed-slug");
        Assert.Equal("article_vault_package_property_slug_mapping_unavailable",
            ArticleVaultPackagePropertyMetadataBridge.Build(PackageFixture(metadata)).ReasonCode);
    }

    [Fact]
    public void PackageBridge_VerifierRejectsTamperedFrozenProvenance()
    {
        ArticleVaultPackagePropertyMetadataInput input = PackageFixture();
        ArticleVaultPackagePropertyMetadataCandidate candidate = Assert.IsType<ArticleVaultPackagePropertyMetadataCandidate>(
            ArticleVaultPackagePropertyMetadataBridge.Build(input).Candidate);
        ImmutableCollectionsMarshal.AsArray(candidate.PackageSemanticDigests)![1] = s_digest;
        Assert.Equal("article_vault_package_property_candidate_package_provenance_mismatch",
            ArticleVaultPackagePropertyMetadataBridge.VerifyCurrentCandidate(input, candidate).ReasonCode);
        Assert.False(ArticleVaultPackagePropertyMetadataBridge.RequireExecutionAdmission(input, candidate).IsValid);
    }

    [Fact]
    public void PackageBridge_DoesNotAdmitEvenEmptyReferenceWithoutProvider()
    {
        ArticleVaultPackagePropertyMetadataInput input = PackageFixture();
        ArticlePackageManifestCandidateInput actual = input.Local.Input;
        ArticlePropertyValueSnapshot snapshot = Snapshot([Entry(s_first, new ArticlePropertyArticleReferenceValue([]))],
            actual.PropertySnapshot.Coordinates);
        var unsupported = new ArticlePackageManifestCandidateInput(actual.Article, actual.TitleBinding,
            snapshot, Bindings(snapshot), input.Metadata.Source.LocalBytes.Span);
        Assert.Equal("article_package_manifest_reference_authority_unavailable", ArticleVaultPackagePropertyMetadataBridge.Build(input with
        {
            Local = input.Local with
            {
                Input = unsupported
            }
        }).ReasonCode);
    }

    private const string PackagePortableIdentity = "article:41180000-0000-4000-8000-000000000700";

    private static ArticleVaultPackagePropertyMetadataInput PackageFixture(ArticleVaultPropertyMetadataInput? metadata = null)
    {
        metadata ??= Fixture([Entry(s_first, new ArticlePropertyBooleanValue(false))],
            [Entry(s_first, new ArticlePropertyBooleanValue(true))], [Entry(s_first, new ArticlePropertyBooleanValue(false))],
            portableIdentity: PackagePortableIdentity);
        ArticleVaultPackageManifestSnapshot Slot(ArticleVaultPropertySnapshotInput typed, ReadOnlyMemory<byte> metaBytes, ReadOnlyMemory<byte> source)
        {
            ArticleVaultMetadataManifest fields = ArticleVaultManifestCodec.DeserializeMetadata(metaBytes.Span);
            var article = new ArticleCanonicalInput(typed.Snapshot.Coordinates.ArticleId,
                typed.Snapshot.Coordinates.ArticleRevisionId, checked((int)typed.Snapshot.Coordinates.ArticleRevisionId),
                null, fields.Title, fields.Summary, null, 1, [], ArticleStatusValues.Draft, null, null, Encoding.UTF8.GetString(source.Span));
            var title = new ArticlePackageTitleSummaryBinding(article.ArticleId, article.ArticleRevisionId!.Value, article.RevisionNo!.Value,
                ArticleCanonicalHashV1.ComputeHashHex(article), Parse(ArticlePackageIdentityKind.Article, fields.PortableArticleIdentity));
            return PackageSnapshot(new(article, title, typed.Snapshot, typed.Bindings, source.Span));
        }
        return new(metadata, Slot(metadata.Base, metadata.BaseMetadataBytes, metadata.Source.BaseBytes),
            Slot(metadata.Local, metadata.LocalMetadataBytes, metadata.Source.LocalBytes),
            Slot(metadata.Server, metadata.ServerMetadataBytes, metadata.Source.ServerBytes));
    }

    private static ArticleVaultPackageManifestSnapshot PackageSnapshot(ArticlePackageManifestCandidateInput input)
    {
        ArticlePackageManifestCandidateResult result = ArticlePackageManifestCandidatePlanner.TryCreateCandidatePlan([input], out var plan);
        Assert.True(result.IsValid, result.ReasonCode);
        return new(ArticlePackageManifestCandidateCodec.WriteCandidate(plan!.Manifest), input);
    }

    private static ArticleVaultPropertyMetadataInput BooleanFixture()
    {
        ArticlePropertyValueEntry[] entries = [Entry(s_first, new ArticlePropertyBooleanValue(false))];
        return Fixture(entries, entries, entries);
    }

    private static ArticleVaultPropertyMetadataCandidate Candidate(ArticleVaultPropertyMetadataInput input)
    {
        ArticleVaultPropertyMetadataResult result = ArticleVaultPropertyMetadataMerge.Build(input);
        Assert.Null(result.ReasonCode);
        return Assert.IsType<ArticleVaultPropertyMetadataCandidate>(result.Candidate);
    }

    private static ArticleVaultPropertyMetadataCandidate Reseal(ArticleVaultPropertyMetadataCandidate original,
        ImmutableArray<ArticleVaultPropertyChoice> choices, ArticlePackagePropertyMappingCandidate? local = null)
    {
        ArticleVaultPropertyMetadataCandidate unsealed = new(original.Binding, original.Base, local ?? original.Local,
            original.Server, choices, string.Empty);
        return new(unsealed.Binding, unsealed.Base, unsealed.Local, unsealed.Server, choices,
            ArticleVaultPropertyMetadataMerge.ComputeContentSha256(unsealed));
    }

    private static ArticleVaultPropertyMetadataInput Fixture(ArticlePropertyValueEntry[] baseline,
        ArticlePropertyValueEntry[] local, ArticlePropertyValueEntry[] server, string? context = null,
        string portableIdentity = "property-merge-article", string? localSlug = null)
    {
        const string SourcePath = "articles/property-merge.md";
        byte[] sourceBytes = "raw source e\u0301 😀\r\n"u8.ToArray();
        ArticlePropertySnapshotCoordinates Coordinates(long revision)
            => new(42, "site-primary", 700, revision, revision,
                context == "draft" ? 9 : null, context == "draft" ? 1 : null,
                context == "publication" ? 11 : null);
        ArticlePropertyValueSnapshot[] typed = [Snapshot(baseline, Coordinates(100)), Snapshot(local, Coordinates(101)), Snapshot(server, Coordinates(102))];
        ArticleVaultMetadataManifest[] metadata = typed.Select((snapshot, index) =>
        {
            ArticleVaultMetadataManifest unsigned = new(ArticleVaultSchemas.MetadataManifest, ArticleVaultSchemas.Version,
                "site-primary", "vault-primary", "device-primary", portableIdentity, "700", "Title", null,
                index == 1 && localSlug is not null ? localSlug : "slug",
                s_digest, snapshot.ContentDigest, string.Empty);
            return unsigned with
            {
                ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(unsigned)
            };
        }).ToArray();
        VaultArticleCoordinate[] coordinates = typed.Select((snapshot, index) =>
        {
            VaultArticleCoordinate unsigned = new(ArticleVaultSchemas.Coordinate, ArticleVaultSchemas.Version, true,
                false, snapshot.Coordinates.ArticleRevisionId, ArticleVaultManifestCodec.CaptureSourceBytes(sourceBytes),
                metadata[index].ContentSha256, s_digest, "draft", s_digest, string.Empty);
            return unsigned with
            {
                ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(unsigned)
            };
        }).ToArray();
        ArticleVaultArticleManifest unsignedArticle = new(ArticleVaultSchemas.ArticleManifest, ArticleVaultSchemas.Version,
            "site-primary", "vault-primary", "device-primary", portableIdentity, "700",
            new(SourcePath, ArticleVaultManifestCodec.ComputeProjectionSha256(SourcePath)), new(coordinates[0], coordinates[1], coordinates[0]),
            new(0, null, null, null, null, null, null), VaultArticleState.Clean, string.Empty);
        unsignedArticle = unsignedArticle with
        {
            State = ArticleVaultStateMachine.Derive(unsignedArticle)
        };
        ArticleVaultArticleManifest article = unsignedArticle with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(unsignedArticle)
        };
        ArticleVaultRootManifest unsignedRoot = new(ArticleVaultSchemas.RootManifest, ArticleVaultSchemas.Version,
            ArticleVaultSchemas.ControlTreeVersion, new(ArticleVaultSchemas.RootManifestPath,
                ArticleVaultSchemas.ArticleManifestDirectory, ArticleVaultSchemas.ReceiptDirectory),
            article.SiteIdentity, article.VaultIdentity, article.DeviceIdentity,
            [new(portableIdentity, $"{ArticleVaultSchemas.ArticleManifestDirectory}/{portableIdentity}.json", article.ContentSha256, SourcePath)], [], string.Empty);
        ArticleVaultRootManifest root = unsignedRoot with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(unsignedRoot)
        };
        ArticleVaultServerObservation unsignedObservation = new(ArticleVaultPlanSchemas.ServerObservation, ArticleVaultPlanSchemas.Version,
            article.SiteIdentity, article.VaultIdentity, article.DeviceIdentity, portableIdentity, "700", coordinates[2], string.Empty);
        ArticleVaultServerObservation observation = unsignedObservation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(unsignedObservation)
        };
        ArticleVaultPlanRequest request = new(root, [article], [observation], [new("property-group", [portableIdentity], [])],
            VaultSyncDirection.Sync, 1_800_000_000_000, 1_800_000_060_000, false);
        ArticleVaultPlanBuildResult built = ArticleVaultSyncPlanner.Build(request);
        Assert.True(built.IsSuccess, string.Join(',', built.Errors));
        ArticleVaultSyncPlan plan = built.Plan!;
        VaultSyncPlanItem item = plan.Groups.Single().Items.Single();
        VaultConflictBinding binding = new(plan.SiteIdentity, plan.VaultIdentity, plan.DeviceIdentity, portableIdentity, "700",
            plan.PlanCandidateIdentity, plan.ContentSha256, "property-group", item.OperationIdentity,
            item.Preconditions.ArticleManifestSha256, item.Preconditions.ServerObservationSha256, new(item.Base, item.Local, item.Server));
        ArticleVaultSourceAdmissionInput source = new(plan, root, [article], [observation],
            new(request.CreatedAtUnixMs, request.Direction, false), binding, sourceBytes, sourceBytes, sourceBytes);
        return new(source, ArticleVaultManifestCodec.Serialize(metadata[0]), ArticleVaultManifestCodec.Serialize(metadata[1]),
            ArticleVaultManifestCodec.Serialize(metadata[2]), new(typed[0], Bindings(typed[0])),
            new(typed[1], Bindings(typed[1])), new(typed[2], Bindings(typed[2])));
    }

    private static ArticlePropertyValueEntry Entry(Guid definition, ArticlePropertyTypedValue? value,
        ArticlePropertyValuePresence presence = ArticlePropertyValuePresence.Present, bool defaultApplied = false, long revision = 1)
    {
        ArticlePropertyValueInput input = new(definition, revision, s_digest, presence, value);
        return new(definition, revision, s_digest, presence, value,
            ArticlePropertyValueDigest.ComputeValue(input, defaultApplied), defaultApplied);
    }

    private static ArticlePropertyValueSnapshot Snapshot(IEnumerable<ArticlePropertyValueEntry> values, ArticlePropertySnapshotCoordinates coordinates)
    {
        ArticlePropertyValueEntry[] ordered = values.OrderBy(static entry => entry.DefinitionId).ToArray();
        return new(ArticlePropertyValueSnapshot.CurrentSchemaVersion, coordinates, ordered,
            ArticlePropertyValueDigest.ComputeSnapshot(coordinates, ordered));
    }

    private static ArticlePackagePropertyMappingBindings Bindings(ArticlePropertyValueSnapshot snapshot)
    {
        ArticlePackagePropertyDefinitionBinding[] definitions = snapshot.Values.Select(entry =>
            new ArticlePackagePropertyDefinitionBinding(entry.DefinitionId, entry.DefinitionSchemaRevision,
                entry.DefinitionDigest, Definition(entry.DefinitionId))).ToArray();
        ArticlePackagePropertyOptionBinding[] options = snapshot.Values.SelectMany(entry => entry.Value switch
        {
            ArticlePropertyMultiSelectValue multiple => multiple.OptionIds.Select(option => new ArticlePackagePropertyOptionBinding(entry.DefinitionId, option, Option(option))),
            ArticlePropertySingleSelectValue single => [new ArticlePackagePropertyOptionBinding(entry.DefinitionId, single.OptionId, Option(single.OptionId))],
            _ => Enumerable.Empty<ArticlePackagePropertyOptionBinding>()
        }).ToArray();
        return new(snapshot.Coordinates, snapshot.ContentDigest, definitions, options, []);
    }

    // Explicit test bindings only. Production never constructs a portable token from a source GUID.
    private static ArticlePackageIdentity Definition(Guid definition)
        => Parse(ArticlePackageIdentityKind.Definition, definition == s_first ? "portable-definition:41180000-0000-4000-8000-000000000001"
            : definition == s_second ? "portable-definition:41180000-0000-4000-8000-000000000002"
            : definition == s_third ? "portable-definition:41180000-0000-4000-8000-000000000003" : throw new ArgumentException("Unknown fixture definition."));

    private static ArticlePackageIdentity Option(Guid option)
        => Parse(ArticlePackageIdentityKind.Option, option == s_optionA ? "portable-option:41180000-0000-4000-8000-000000000101"
            : option == s_optionB ? "portable-option:41180000-0000-4000-8000-000000000102"
            : option == s_optionC ? "portable-option:41180000-0000-4000-8000-000000000103" : throw new ArgumentException("Unknown fixture option."));

    private static ArticlePackageIdentity Parse(ArticlePackageIdentityKind kind, string value)
    {
        Assert.True(ArticlePackageIdentity.TryCreate(kind, value, out ArticlePackageIdentity identity).IsValid);
        return identity;
    }
}
