using System.Globalization;
using System.Text;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleProperties;
using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.Extensions.Configuration;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed partial class ArticleVaultPropertyMetadataMergeTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CurrentInputProposal_UsesActualServerRowsInsteadOfAssertedRows(bool badAssertion)
    {
        CurrentInputFixture fixture = new();
        ArticleVaultPropertyMetadataInput input = fixture.Input;
        if (badAssertion)
        {
            input = input with
            {
                Server = new(input.Base.Snapshot, input.Server.Bindings),
                Source = input.Source with
                {
                    ServerBytes = "caller assertion"u8.ToArray()
                }
            };
            Assert.Null(ArticleVaultPropertyMetadataMerge.Build(input).Candidate);
        }
        ArticleVaultCurrentPropertyMetadataResult result = await fixture.Reader.ReadAndBuildAsync(input, fixture.Context);
        ArticleVaultCurrentPropertyMetadataProposal proposal = Assert.IsType<ArticleVaultCurrentPropertyMetadataProposal>(result.Proposal);
        Assert.Equal(VaultPropertyChoiceOrigin.Server, Assert.Single(proposal.Candidate.Choices).Origin);
        Assert.Equal(new ArticlePropertyBooleanValue(true), Assert.IsType<ArticlePackagePrimitivePropertyProjection>(
            Assert.Single(proposal.Candidate.Server.Properties).Projection).Value);
        Assert.Same(fixture.Model.Current, proposal.Observed.Properties.Source);
        Assert.Equal(4, fixture.PropertyReads);
        Assert.True(proposal.SourceHold);
        Assert.False(proposal.CanExecute);
        Assert.False(proposal.CanCommitBase);
        Assert.True(proposal.Candidate.RequiresCurrentDefinitionAndRightsAdmission);
        Assert.False(ArticleVaultPropertyMetadataMerge.RequireExecutionAdmission(fixture.Input, proposal.Candidate).IsValid);
        await fixture.Authority.DidNotReceiveWithAnyArgs().MutateAsync(default, default!, default);
        await fixture.Store.DidNotReceiveWithAnyArgs().SaveResultAsync(default!, default);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("future")]
    [InlineData("digest")]
    public async Task CurrentInputProposal_RequiresOriginalCompleteMetadataBeforePropertyRead(string fault)
    {
        CurrentInputFixture fixture = new();
        ArticleVaultMetadataManifest manifest = ArticleVaultManifestCodec.DeserializeMetadata(fixture.Input.ServerMetadataBytes.Span);
        byte[] bytes = fault switch
        {
            "missing" => [],
            "future" => ArticleVaultOperationCodec.Serialize(manifest with { SchemaVersion = 99 }),
            _ => ArticleVaultOperationCodec.Serialize(manifest with { ContentSha256 = new string('b', 64) })
        };
        ArticleVaultCurrentPropertyMetadataResult result = await fixture.Reader.ReadAndBuildAsync(
            fixture.Input with
            {
                ServerMetadataBytes = bytes
            }, fixture.Context);
        Assert.Null(result.Proposal);
        Assert.Equal("article_vault_current_property_metadata_full_metadata_bytes_invalid", result.ReasonCode);
        Assert.Equal(0, fixture.PropertyReads);
    }

    [Theory]
    [InlineData("missing-head")]
    [InlineData("provenance")]
    [InlineData("definition")]
    public async Task CurrentInputProposal_RefusesMissingHeadAndMovementAcrossProposalVerification(string fault)
    {
        CurrentInputFixture fixture = new();
        fixture.ReadMutation = (model, count) => fault switch
        {
            "missing-head" => model with { Current = null },
            "provenance" when count > 2 => model with
            {
                Current = model.Current! with
                {
                    FactsetId = Guid.Parse("00000000-0000-4000-8000-000000000020")
                }
            },
            "definition" when count > 2 => model with
            {
                Definitions = [fixture.Definition with
                {
                    SchemaRevision = 2,
                    ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(fixture.Definition with { SchemaRevision = 2 })
                }]
            },
            _ => model
        };
        if (fault == "missing-head")
        {
            await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.Reader.ReadAndBuildAsync(fixture.Input, fixture.Context));
        }
        else
        {
            ArticleVaultCurrentPropertyMetadataResult result = await fixture.Reader.ReadAndBuildAsync(fixture.Input, fixture.Context);
            Assert.Null(result.Proposal);
            Assert.Equal("article_vault_current_property_metadata_current_read_changed", result.ReasonCode);
        }
        await fixture.Authority.DidNotReceiveWithAnyArgs().MutateAsync(default, default!, default);
    }

    [Fact]
    public async Task CurrentInputProposal_HoldsOriginalBytesBeforeAwaitingAuthorizedReads()
    {
        CurrentInputFixture fixture = new();
        byte[] callerBytes = fixture.Input.LocalMetadataBytes.ToArray();
        fixture.ReadMutation = (model, _) =>
        {
            Array.Fill(callerBytes, (byte)0);
            return model;
        };
        ArticleVaultCurrentPropertyMetadataResult result = await fixture.Reader.ReadAndBuildAsync(
            fixture.Input with
            {
                LocalMetadataBytes = callerBytes
            }, fixture.Context);
        Assert.NotNull(result.Proposal);
        Assert.All(callerBytes, static value => Assert.Equal((byte)0, value));
        Assert.True(ArticleVaultPropertyMetadataMerge.VerifyCurrentCandidate(fixture.Input, result.Proposal!.Candidate).IsValid);
    }

    [Fact]
    public async Task CurrentInputProposal_InterruptedActualReadCanRepeatWithoutMutationOrCachedProposal()
    {
        CurrentInputFixture fixture = new();
        using var cancelled = new CancellationTokenSource();
        fixture.ReadMutation = (model, count) =>
        {
            if (count == 1)
                cancelled.Cancel();
            return model;
        };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Reader.ReadAndBuildAsync(
            fixture.Input, fixture.Context, cancelled.Token));
        fixture.ReadMutation = null;
        ArticleVaultCurrentPropertyMetadataResult retry = await fixture.Reader.ReadAndBuildAsync(fixture.Input, fixture.Context);
        Assert.NotNull(retry.Proposal);
        Assert.False(retry.Proposal!.CanCommitBase);
        await fixture.Authority.DidNotReceiveWithAnyArgs().MutateAsync(default, default!, default);
        await fixture.Store.DidNotReceiveWithAnyArgs().SaveResultAsync(default!, default);
    }

    [Fact]
    public async Task CurrentInputProposal_RejectsForeignActorBeforePropertyRead()
    {
        CurrentInputFixture fixture = new();
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.Reader.ReadAndBuildAsync(
            fixture.Input, fixture.Context with
            {
                AdminPrincipalId = 999
            }));
        Assert.Equal(0, fixture.PropertyReads);
    }

    [Fact]
    public async Task CurrentInputProposal_PreservesOriginalBaseByteGate()
    {
        CurrentInputFixture fixture = new();
        ArticleVaultCurrentPropertyMetadataResult result = await fixture.Reader.ReadAndBuildAsync(fixture.Input with
        {
            Source = fixture.Input.Source with
            {
                BaseBytes = "tampered base"u8.ToArray()
            }
        }, fixture.Context);
        Assert.Null(result.Proposal);
        Assert.NotNull(result.ReasonCode);
        await fixture.Authority.DidNotReceiveWithAnyArgs().MutateAsync(default, default!, default);
    }

    // Task-local controlled read ports; no database, HTTP, native fixture or qualification hook.
    private sealed class CurrentInputFixture
    {
        internal ArticleVaultPropertyMetadataInput Input
        {
            get;
        }
        internal ArticleVaultConflictReviewContext Context
        {
            get;
        }
        internal ArticlePropertyDefinition Definition
        {
            get;
        }
        internal ArticlePropertyValueReadModel Model
        {
            get;
        }
        internal IArticlePropertyValueAuthority Authority { get; } = Substitute.For<IArticlePropertyValueAuthority>();
        internal IArticleVaultExecutionStore Store { get; } = Substitute.For<IArticleVaultExecutionStore>();
        internal ArticleVaultCurrentPropertyMetadataReader Reader
        {
            get;
        }
        internal int PropertyReads
        {
            get; private set;
        }
        internal Func<ArticlePropertyValueReadModel, int, ArticlePropertyValueReadModel>? ReadMutation
        {
            get; set;
        }

        internal CurrentInputFixture()
        {
            var unsigned = new ArticlePropertyDefinition(1, s_first, new(42, "site-primary"), "field", [new("en", "Field")],
                ArticlePropertyValueType.Boolean, ArticlePropertyCardinality.Single, false,
                new(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull, ArticlePropertyEmptyBehavior.PreserveEmpty),
                null, new(), [], null, null, false, false, false, ArticlePropertyDisplayPlacement.Metadata,
                ArticlePropertyVisibilityScope.AuthorOnly, ArticlePropertyDefinitionStatus.Active, 1, DateTime.UnixEpoch, DateTime.UnixEpoch, "");
            Definition = unsigned with
            {
                ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(unsigned)
            };
            ArticlePropertyValueEntry Row(bool value)
            {
                var row = new ArticlePropertyValueInput(s_first, 1, Definition.ContentDigest,
                    ArticlePropertyValuePresence.Present, new ArticlePropertyBooleanValue(value));
                return new(s_first, 1, Definition.ContentDigest, row.Presence, row.Value, ArticlePropertyValueDigest.ComputeValue(row));
            }
            Input = Fixture([Row(false)], [Row(false)], [Row(true)]);
            var source = Input.Source;
            VaultSyncPlanItem item = source.Plan.Groups.Single().Items.Single();
            Context = new(42, source.Plan.SiteIdentity, source.Plan.VaultIdentity, source.Plan.DeviceIdentity, 700, source.Binding.PortableArticleIdentity);
            var payload = new ArticleVaultExecutionPayload(ArticleVaultExecutionSchemas.Payload, 1, [], "");
            payload = payload with
            {
                ContentSha256 = ArticleVaultExecutionIntegrity.SealPayload(payload)
            };
            var bundle = new ArticleVaultSealedExecutionBundle(ArticleVaultExecutionSchemas.Bundle, 1, source.Plan.PlanCandidateIdentity,
                source.Plan.ContentSha256, 42, source.Plan, source.Root, source.Articles, source.Observations, payload, "");
            bundle = bundle with
            {
                ContentSha256 = ArticleVaultExecutionIntegrity.SealBundle(bundle)
            };
            ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
            Store.LoadSealedAsync(bundle.PlanReference, bundle.PlanSha256, Arg.Any<CancellationToken>()).Returns(bundle);
            var observations = Substitute.For<IArticleVaultCurrentObservationAuthority>();
            observations.ObserveGroupAsync(bundle, source.Plan.Groups[0], Arg.Any<CancellationToken>()).Returns(
                new[] { new ArticleVaultCurrentArticleObservation(item.PortableArticleIdentity, item.ServerArticleIdentity,
                    item.Server.ServerRevision, item.Server.Lifecycle, true, item.Server.PermissionSha256, item.Server.DependencySha256,
                    s_digest, s_digest, item.Server.Source!.Sha256, item.Preconditions.ServerObservationSha256) });
            var revisionAuthority = Substitute.For<IAuthoringRevisionCompareAuthority>();
            revisionAuthority.GetAuthorizedArticleAsync(Arg.Any<RevisionCompareReadContext>(), 700, Arg.Any<CancellationToken>())
                .Returns(new AuthoringRevisionCompareArticle(700, 102));
            revisionAuthority.GetCurrentRevisionIdAsync(700, Arg.Any<CancellationToken>()).Returns(102L);
            revisionAuthority.GetRevisionAsync(700, 102, Arg.Any<CancellationToken>()).Returns(new ArticleRevisionDetailResponse(
                102.ToString(CultureInfo.InvariantCulture), 700, 900, "Title", Encoding.UTF8.GetString(source.ServerBytes.Span), null, null,
                1, [], "controlled", "42", DateTime.UnixEpoch, null, null, true, null, null, null));
            var revisions = new AuthoringRevisionComparePackageReader(revisionAuthority, Substitute.For<IAuthoringRevisionCompareDraftContextAuthority>());
            var permissions = Substitute.For<IAuthorRecentArticleHistoryPermissionProjectionProvider>();
            permissions.ResolveAsync(Arg.Any<AuthorRecentArticleHistoryPermissionRequest>(), Arg.Any<CancellationToken>()).Returns(call =>
            {
                var request = call.Arg<AuthorRecentArticleHistoryPermissionRequest>();
                var result = new AuthorRecentArticleHistoryPermissionSnapshot(AuthorRecentArticleHistoryPermissionSnapshotStatus.Current,
                    request.Owner, s_digest, s_digest, s_digest, [new(700, true, true, s_digest)], "");
                return result with
                {
                    ContentDigest = AuthorRecentArticleHistoryContract.ComputePermissionDigest(result)
                };
            });
            var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["SITE_BASEURL"] = "https://site.example/"
            }).Build();
            var currentSource = new ArticleVaultCurrentSourceReader(Store, observations, revisions, permissions,
                configuration, new CurrentInputClock(), source.Plan.SiteIdentity);
            Guid snapshotId = Guid.Parse("00000000-0000-4000-8000-000000000010");
            var persisted = new ArticlePropertyValuePersistedSnapshot(snapshotId,
                Guid.Parse("00000000-0000-4000-8000-000000000011"), Input.Server.Snapshot, snapshotId, "20261009", s_digest);
            Model = new(700, 102, 102, persisted, [Definition], []);
            Authority.ReadAsync(42, Definition.Owner, 700, Arg.Any<CancellationToken>()).Returns(_ =>
            {
                PropertyReads++;
                return ReadMutation?.Invoke(Model, PropertyReads) ?? Model;
            });
            Reader = new(new(currentSource, new(Authority), "site-primary"));
        }
    }

    private sealed class CurrentInputClock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.FromUnixTimeMilliseconds(1_800_000_000_001);
    }
}
