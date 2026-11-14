using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Services.ArticleVault.Assets;
using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault.Dependencies;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Product adapter controls using synthetic execution-store and original-upload observations.
/// These tests do not establish live ledger, native materialization or synchronized-base acceptance.
/// </summary>
[Trait("Category", "Unit")]
public sealed class ArticleVaultAssetStagingAdapterTests
{
    private const string DigestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DigestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string SiteIdentity = "site-primary";
    private const string VaultIdentity = "vault-primary";
    private const string ArticleIdentity = "article:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    private const long CreatedAtUnixMs = 1_800_000_000_000;
    private static readonly UploadSessionAccess s_access = new("11111111111111111111111111111111", 7, "original-session-grant");

    [Fact]
    public async Task DeterministicRetryAndRevalidationRereadOriginalSessionWithoutWriting()
    {
        Fixture fixture = CreateFixture();

        ArticleVaultAssetUploadHandoff first = RequireHandoff(await fixture.PrepareAsync());
        ArticleVaultAssetUploadHandoff retry = RequireHandoff(await fixture.PrepareAsync());
        ArticleVaultAssetUploadHandoff revalidated = RequireHandoff(await fixture.Adapter.RevalidateAsync(
            first, fixture.Dependencies, fixture.Request, fixture.Inputs, s_access));

        Assert.Equal(ArticleVaultOperationCodec.Serialize(first), ArticleVaultOperationCodec.Serialize(retry));
        Assert.Equal(first.ContentSha256, revalidated.ContentSha256);
        Assert.Equal(3, fixture.Store.LoadCount);
        Assert.Equal(3, fixture.Files.Reads.Count);
        Assert.All(fixture.Files.Reads, read =>
        {
            Assert.Equal(s_access, read.Access);
            Assert.Equal(fixture.Asset.ContentSha256, read.Sha256);
        });
        Assert.Equal(first.PreparationIdentity, ArticleVaultAssetUploadHandoffCodec.ComputePreparationIdentity(first));
        Assert.Equal(first.ContentSha256, ArticleVaultAssetUploadHandoffCodec.ComputeContentSha256(first));
        AssertReadOnly(fixture);
    }

    [Fact]
    public async Task HandoffBindsWholeOperationAndExactItemGroupArticleAndAsset()
    {
        Fixture fixture = CreateFixture();

        ArticleVaultAssetUploadHandoff handoff = RequireHandoff(await fixture.PrepareAsync());

        Assert.Equal(fixture.Operation, handoff.Operation);
        Assert.NotEqual(handoff.Operation.OperationIdentity, handoff.ItemOperationIdentity);
        Assert.Equal(fixture.Item.OperationIdentity, handoff.ItemOperationIdentity);
        Assert.Equal(fixture.Item.GroupIdentity, handoff.GroupIdentity);
        Assert.Equal(fixture.Item.PortableArticleIdentity, handoff.PortableArticleIdentity);
        Assert.Equal(fixture.Item.Local.Source!.Sha256, handoff.ArticleSourceSha256);
        Assert.Equal(fixture.Dependencies.ContentSha256, handoff.DependencyPlanSha256);
        Assert.Equal(fixture.Asset, handoff.Asset);
        Assert.Equal(fixture.Bundle.PlanReference, fixture.Store.LastPlanReference);
        Assert.Equal(fixture.Bundle.PlanSha256, fixture.Store.LastPlanSha256);
        Assert.False(handoff.CanMaterialize);
        Assert.False(handoff.CanCommitBase);
        Assert.False(handoff.CanStartUpload);
        Assert.Contains("native_asset_conditional_materialization_and_recovery", handoff.MissingCapabilities);
        AssertReadOnly(fixture);
    }

    [Fact]
    public async Task WholeOperationIdentityCannotStandInForItemIdentity()
    {
        Fixture fixture = CreateFixture();

        AssertFailure(await fixture.PrepareAsync(itemOperationIdentity: fixture.Operation.OperationIdentity),
            "article_vault_asset_stage_push_item_missing");

        Assert.Empty(fixture.Files.Reads);
        AssertReadOnly(fixture);
    }

    [Theory]
    [InlineData("operation-seal", "article_vault_operation_identity_invalid")]
    [InlineData("site", "article_vault_asset_stage_binding_invalid")]
    [InlineData("plan", "article_vault_asset_stage_plan_missing")]
    [InlineData("principal", "article_vault_asset_stage_principal_or_plan_mismatch")]
    public async Task RejectsGlobalOperationPlanAndPrincipalMismatchBeforeUploadRead(string change, string reason)
    {
        Fixture fixture = CreateFixture();
        ArticleVaultOperationIdentity operation = change switch
        {
            "operation-seal" => fixture.Operation with { OperationIdentity = fixture.Item.OperationIdentity },
            "site" => fixture.Operation with { SiteIdentity = "site-other" },
            "plan" => fixture.Operation with { PlanSha256 = DigestB },
            _ => fixture.Operation
        };
        UploadSessionAccess access = change == "principal" ? s_access with
        {
            OwnerAdminPrincipalId = 8
        } : s_access;

        AssertFailure(await fixture.PrepareAsync(operation: operation, access: access), reason);

        Assert.Empty(fixture.Files.Reads);
        Assert.Equal(change == "site" ? 0 : 1, fixture.Store.LoadCount);
        AssertReadOnly(fixture);
    }

    [Theory]
    [InlineData("group")]
    [InlineData("item")]
    public async Task ResealedDependencyExtensionCannotSubstituteItemOrGroup(string change)
    {
        Fixture fixture = CreateFixture();
        VaultDependencyPlanItem item = Assert.Single(fixture.Dependencies.Items);
        item = change == "group"
            ? item with
            {
                GroupIdentity = "group-other"
            }
            : item with
            {
                OperationIdentity = "operation-other"
            };
        ArticleVaultDependencyPlan altered = fixture.Dependencies with
        {
            Items = [item],
            OperationOrder = [item.OperationIdentity]
        };
        altered = altered with
        {
            ContentSha256 = PortableDependencyCodec.PlanDigest(altered)
        };
        Assert.True(ArticleVaultDependencyPlanner.ValidateStructure(altered).IsValid);

        AssertFailure(await fixture.PrepareAsync(dependencies: altered), "portable_dependency_plan_tamper_or_drift");

        Assert.Empty(fixture.Files.Reads);
        AssertReadOnly(fixture);
    }

    [Fact]
    public async Task UnknownAssetCannotBeSelectedByMatchingContentDigest()
    {
        Fixture fixture = CreateFixture();

        AssertFailure(await fixture.PrepareAsync(assetIdentity: Guid.Parse("33333333-3333-3333-3333-333333333333")),
            "article_vault_asset_stage_asset_not_planned");

        Assert.Empty(fixture.Files.Reads);
        AssertReadOnly(fixture);
    }

    [Theory]
    [InlineData(VaultSyncDecision.NoOp)]
    [InlineData(VaultSyncDecision.PullUpdate)]
    public async Task NoOpAndPullItemsCannotPrepareUploadHandoff(VaultSyncDecision decision)
    {
        Fixture fixture = CreateFixture(decision);

        AssertFailure(await fixture.PrepareAsync(), "article_vault_asset_stage_push_item_missing");

        Assert.Empty(fixture.Files.Reads);
        AssertReadOnly(fixture);
    }

    [Fact]
    public async Task SameDigestRetainsIndependentAssetOwnerAndRightsNodes()
    {
        Fixture fixture = CreateFixture(twoAssets: true);
        VaultAssetDependency[] assets = Assert.Single(fixture.Dependencies.Items).Manifest.Nodes.OfType<VaultAssetDependency>().ToArray();
        Assert.Equal(2, assets.Length);
        Assert.Equal(assets[0].ContentSha256, assets[1].ContentSha256);
        Assert.NotEqual(assets[0].OwnerAdminPrincipalId, assets[1].OwnerAdminPrincipalId);
        Assert.NotEqual(assets[0].Admission.RightsSha256, assets[1].Admission.RightsSha256);
        Assert.NotEqual(PortableDependencyCodec.NodeKey(assets[0]), PortableDependencyCodec.NodeKey(assets[1]));

        ArticleVaultAssetUploadHandoff handoff = RequireHandoff(await fixture.PrepareAsync());

        Assert.Equal(fixture.Asset, handoff.Asset);
        Assert.Equal(7, handoff.Asset.OwnerAdminPrincipalId);
        Assert.Equal(DigestA, handoff.Asset.Admission.RightsSha256);
        VaultAssetDependency other = assets.Single(asset => asset.AssetIdentity != handoff.Asset.AssetIdentity);
        AssertFailure(await fixture.PrepareAsync(assetIdentity: other.AssetIdentity), "article_vault_asset_identity_mismatch");
        Assert.Equal(2, fixture.Files.Reads.Count);
        AssertReadOnly(fixture);
    }

    [Theory]
    [InlineData("source", false, "article_vault_source_bytes_mismatch")]
    [InlineData("source", true, "article_vault_source_bytes_mismatch")]
    [InlineData("rights", false, "portable_dependency_authority_drift")]
    [InlineData("rights", true, "portable_dependency_authority_drift")]
    [InlineData("permission", false, "portable_dependency_permission_or_rights_invalid")]
    [InlineData("permission", true, "portable_dependency_permission_or_rights_invalid")]
    [InlineData("owner", false, "portable_dependency_authority_drift")]
    [InlineData("owner", true, "portable_dependency_authority_drift")]
    [InlineData("identity", false, "portable_dependency_authority_drift")]
    [InlineData("identity", true, "portable_dependency_authority_drift")]
    public async Task CurrentSourceAndAuthorityDriftRejectBeforeAndAfterOriginalRead(string change, bool afterRead, string reason)
    {
        Fixture fixture = CreateFixture();
        if (afterRead)
        {
            fixture.Files.AfterRead = () => ChangeCurrentInput(fixture, change);
        }
        else
        {
            ChangeCurrentInput(fixture, change);
        }

        AssertFailure(await fixture.PrepareAsync(), reason);

        Assert.Equal(afterRead ? 1 : 0, fixture.Files.Reads.Count);
        AssertReadOnly(fixture);
    }

    [Fact]
    public async Task OriginalObservationFailureRetainsCodeDetailsAndTrace()
    {
        Fixture fixture = CreateFixture();
        ErrorDetail original = ErrorDetail.Create(ErrorCode.Forbidden, "original_permission_changed", "authority-details", "authority-trace");
        fixture.Files.Result = Result<UploadAssetObservation>.Failure(original);

        Result<ArticleVaultAssetUploadHandoff> result = await fixture.PrepareAsync();

        Assert.True(result.IsFailure);
        Assert.Null(result.Value);
        Assert.Equal(original, result.Error);
        Assert.Single(fixture.Files.Reads);
        AssertReadOnly(fixture);
    }

    [Fact]
    public async Task OriginalObservationExceptionIsNotReplacedWithSuccessOrAnotherError()
    {
        Fixture fixture = CreateFixture();
        var original = new IOException("synthetic original observation failure");
        fixture.Files.AfterRead = () => throw original;

        IOException observed = await Assert.ThrowsAsync<IOException>(() => fixture.PrepareAsync());

        Assert.Same(original, observed);
        AssertReadOnly(fixture);
    }

    [Theory]
    [InlineData("before")]
    [InlineData("store-read")]
    [InlineData("upload-read")]
    public async Task CancellationAtReadBoundariesReturnsNoHandoffAndPerformsNoWrites(string boundary)
    {
        Fixture fixture = CreateFixture();
        using var cancellation = new CancellationTokenSource();
        if (boundary == "before")
        {
            cancellation.Cancel();
        }
        else if (boundary == "store-read")
        {
            fixture.Store.AfterLoad = cancellation.Cancel;
        }
        else
        {
            fixture.Files.AfterRead = cancellation.Cancel;
        }

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.PrepareAsync(cancellationToken: cancellation.Token));

        Assert.Equal(boundary == "before" ? 0 : 1, fixture.Store.LoadCount);
        Assert.Equal(boundary == "upload-read" ? 1 : 0, fixture.Files.Reads.Count);
        Assert.All(fixture.Files.Reads, read => Assert.Equal(cancellation.Token, read.CancellationToken));
        AssertReadOnly(fixture);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RevalidationCancellationCannotReturnPreviouslySuccessfulHandoff(bool afterRead)
    {
        Fixture fixture = CreateFixture();
        ArticleVaultAssetUploadHandoff handoff = RequireHandoff(await fixture.PrepareAsync());
        using var cancellation = new CancellationTokenSource();
        if (afterRead)
        {
            fixture.Files.AfterRead = cancellation.Cancel;
        }
        else
        {
            cancellation.Cancel();
        }

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Adapter.RevalidateAsync(
            handoff, fixture.Dependencies, fixture.Request, fixture.Inputs, s_access, cancellation.Token));

        Assert.Equal(afterRead ? 2 : 1, fixture.Store.LoadCount);
        Assert.Equal(afterRead ? 2 : 1, fixture.Files.Reads.Count);
        AssertReadOnly(fixture);
    }

    [Fact]
    public async Task CancellationDuringPostReadCurrentVerificationCannotReturnHandoff()
    {
        Fixture fixture = CreateFixture();
        using var cancellation = new CancellationTokenSource();
        fixture.Files.AfterRead = () => fixture.Time.BeforeUtcRead = cancellation.Cancel;

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.PrepareAsync(cancellationToken: cancellation.Token));

        Assert.True(cancellation.IsCancellationRequested);
        Assert.Single(fixture.Files.Reads);
        AssertReadOnly(fixture);
    }

    [Theory]
    [InlineData("preparation")]
    [InlineData("seal")]
    [InlineData("operation")]
    [InlineData("dependency-plan")]
    [InlineData("group")]
    [InlineData("item")]
    [InlineData("article")]
    [InlineData("source")]
    [InlineData("asset")]
    [InlineData("owner")]
    [InlineData("rights")]
    [InlineData("version")]
    [InlineData("ledger")]
    public async Task HandoffSealTamperRejectsBeforeReacquiringOriginalFacts(string field)
    {
        Fixture fixture = CreateFixture();
        ArticleVaultAssetUploadHandoff handoff = RequireHandoff(await fixture.PrepareAsync());
        handoff = field switch
        {
            "preparation" => handoff with { PreparationIdentity = DigestB },
            "seal" => handoff with { ContentSha256 = DigestB },
            "operation" => handoff with { Operation = handoff.Operation with { AgentIdentity = "agent-other" } },
            "dependency-plan" => handoff with { DependencyPlanSha256 = DigestB },
            "group" => handoff with { GroupIdentity = "group-other" },
            "item" => handoff with { ItemOperationIdentity = handoff.Operation.OperationIdentity },
            "article" => handoff with { PortableArticleIdentity = "article:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
            "source" => handoff with { ArticleSourceSha256 = DigestB },
            "asset" => handoff with { Asset = handoff.Asset with { AssetIdentity = Guid.Parse("33333333-3333-3333-3333-333333333333") } },
            "owner" => handoff with { Asset = handoff.Asset with { OwnerAdminPrincipalId = 8 } },
            "rights" => handoff with { Asset = handoff.Asset with { Admission = handoff.Asset.Admission with { RightsSha256 = DigestB } } },
            "version" => handoff with { Observation = handoff.Observation with { AssetVersionSha256 = DigestB } },
            _ => handoff with { Observation = handoff.Observation with { ReferenceLedgerSha256 = DigestB } }
        };

        AssertFailure(await fixture.Adapter.RevalidateAsync(handoff, fixture.Dependencies, fixture.Request, fixture.Inputs, s_access),
            "article_vault_asset_stage_handoff_tampered");

        Assert.Equal(1, fixture.Store.LoadCount);
        Assert.Single(fixture.Files.Reads);
        AssertReadOnly(fixture);
    }

    [Theory]
    [InlineData("group")]
    [InlineData("article")]
    [InlineData("source")]
    [InlineData("asset-revision")]
    public async Task ResealingHandoffCannotReplacePlanBoundFacts(string field)
    {
        Fixture fixture = CreateFixture();
        ArticleVaultAssetUploadHandoff original = RequireHandoff(await fixture.PrepareAsync());
        ArticleVaultAssetUploadHandoff altered = field switch
        {
            "group" => original with { GroupIdentity = "group-other" },
            "article" => original with { PortableArticleIdentity = "article:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
            "source" => original with { ArticleSourceSha256 = DigestB },
            _ => original with { Asset = original.Asset with { ServerRevision = original.Asset.ServerRevision + 1 } }
        };
        altered = altered with
        {
            PreparationIdentity = ArticleVaultAssetUploadHandoffCodec.ComputePreparationIdentity(altered)
        };
        altered = altered with
        {
            ContentSha256 = ArticleVaultAssetUploadHandoffCodec.ComputeContentSha256(altered)
        };

        AssertFailure(await fixture.Adapter.RevalidateAsync(altered, fixture.Dependencies, fixture.Request, fixture.Inputs, s_access),
            "article_vault_asset_stage_observation_drift");

        Assert.Equal(2, fixture.Files.Reads.Count);
        AssertReadOnly(fixture);
    }

    [Theory]
    [InlineData("version")]
    [InlineData("ledger")]
    [InlineData("references")]
    public async Task RevalidationRejectsChangedOriginalObservation(string field)
    {
        Fixture fixture = CreateFixture();
        ArticleVaultAssetUploadHandoff handoff = RequireHandoff(await fixture.PrepareAsync());
        UploadAssetObservation observed = fixture.Files.Result.Value!;
        observed = field switch
        {
            "version" => observed with { AssetVersionSha256 = DigestB },
            "ledger" => observed with { ReferenceLedgerSha256 = DigestB },
            _ => observed with { References = [Assert.Single(observed.References) with { ReferenceCount = 2 }] }
        };
        fixture.Files.Result = Result<UploadAssetObservation>.Success(observed);

        AssertFailure(await fixture.Adapter.RevalidateAsync(handoff, fixture.Dependencies, fixture.Request, fixture.Inputs, s_access),
            "article_vault_asset_stage_observation_drift");

        Assert.Equal(2, fixture.Store.LoadCount);
        Assert.Equal(2, fixture.Files.Reads.Count);
        AssertReadOnly(fixture);
    }

    [Fact]
    public async Task ReturnedReferenceSnapshotSurvivesMutationOfOriginalObserverList()
    {
        Fixture fixture = CreateFixture();
        var originalReferences = Assert.IsType<List<AssetReference>>(fixture.Files.Result.Value!.References);
        AssetReference expected = Assert.Single(originalReferences);

        ArticleVaultAssetUploadHandoff handoff = RequireHandoff(await fixture.PrepareAsync());
        originalReferences.Clear();

        Assert.IsType<ImmutableArray<AssetReference>>(handoff.Observation.References);
        Assert.Equal(expected, Assert.Single(handoff.Observation.References));
        Assert.Equal(handoff.ContentSha256, ArticleVaultAssetUploadHandoffCodec.ComputeContentSha256(handoff));
        AssertReadOnly(fixture);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TrustedTimeRejectsExpiredDeadlineBeforeAndAfterOriginalRead(bool afterRead)
    {
        Fixture fixture = CreateFixture();
        if (afterRead)
        {
            fixture.Files.AfterRead = () => fixture.Time.UnixMs = fixture.Operation.DeadlineUnixMs + 1;
        }
        else
        {
            fixture.Time.UnixMs = fixture.Operation.DeadlineUnixMs + 1;
        }

        AssertFailure(await fixture.PrepareAsync(), "article_vault_asset_stage_deadline_expired");

        Assert.Equal(afterRead ? 1 : 0, fixture.Files.Reads.Count);
        AssertReadOnly(fixture);
    }

    [Fact]
    public async Task ExactDeadlineBoundaryIsWithinTheSealedOperationWindow()
    {
        Fixture fixture = CreateFixture();
        fixture.Time.UnixMs = fixture.Operation.DeadlineUnixMs;

        RequireHandoff(await fixture.PrepareAsync());

        Assert.Single(fixture.Files.Reads);
        AssertReadOnly(fixture);
    }

    private static void ChangeCurrentInput(Fixture fixture, string change)
    {
        if (change == "source")
        {
            fixture.SourceBytes[0] ^= 1;
            return;
        }
        VaultAssetDependency asset = (VaultAssetDependency)fixture.AuthorityNodes[0];
        fixture.AuthorityNodes[0] = change switch
        {
            "rights" => asset with { Admission = asset.Admission with { RightsSha256 = DigestB } },
            "permission" => asset with { Admission = asset.Admission with { Permission = ArticleEmbedPermissionStatus.Denied } },
            "owner" => asset with { OwnerAdminPrincipalId = 8 },
            _ => asset with { AssetIdentity = Guid.Parse("33333333-3333-3333-3333-333333333333") }
        };
    }

    private static ArticleVaultAssetUploadHandoff RequireHandoff(Result<ArticleVaultAssetUploadHandoff> result)
    {
        Assert.True(result.IsSuccess, result.Error.Message);
        return Assert.IsType<ArticleVaultAssetUploadHandoff>(result.Value);
    }

    private static void AssertFailure(Result<ArticleVaultAssetUploadHandoff> result, string reason)
    {
        Assert.True(result.IsFailure);
        Assert.Null(result.Value);
        Assert.Equal(ErrorCode.Conflict, result.Error.Code);
        Assert.Equal(reason, result.Error.Message);
    }

    private static void AssertReadOnly(Fixture fixture)
    {
        Assert.Equal(0, fixture.Files.NonObservationCalls);
        Assert.Equal(0, fixture.Store.WriteCount);
        Assert.Equal(0, fixture.Store.OtherReadCount);
    }

    internal static Fixture CreateFixture(VaultSyncDecision decision = VaultSyncDecision.PushUpdate, bool twoAssets = false,
        byte[]? assetBytes = null)
    {
        var time = new MutableTimeProvider(CreatedAtUnixMs + 1);
        var binding = new VaultDependencyBinding(SiteIdentity, VaultIdentity, ArticleIdentity);
        const VaultDependencyRights Rights = VaultDependencyRights.Read | VaultDependencyRights.Reference
            | VaultDependencyRights.Materialize | VaultDependencyRights.Upload;
        var admission = new VaultDependencyAdmission(ArticleEmbedPermissionStatus.Allowed, Rights, Rights, DigestA, DigestA, DigestA);
        var asset = new VaultAssetDependency(binding, admission, Guid.Parse("11111111-1111-1111-1111-111111111111"),
            assetBytes is null ? DigestA : Convert.ToHexStringLower(SHA256.HashData(assetBytes)),
            "image/png", ".png", assetBytes?.LongLength ?? 24, 1, 1, 7, 4);
        var nodes = new List<VaultDependencyNode> { asset };
        if (twoAssets)
        {
            nodes.Add(asset with
            {
                AssetIdentity = Guid.Parse("22222222-2222-2222-2222-222222222222"),
                OwnerAdminPrincipalId = 8,
                Admission = admission with
                {
                    RightsSha256 = DigestB
                }
            });
        }
        byte[] unchangedBytes = Encoding.UTF8.GetBytes(decision == VaultSyncDecision.NoOp ? "content\n" : "base\n");
        byte[] updatedBytes = Encoding.UTF8.GetBytes("content\n");
        byte[] sourceBytes = decision == VaultSyncDecision.PullUpdate ? updatedBytes : decision == VaultSyncDecision.NoOp ? unchangedBytes : updatedBytes;
        VaultSourceByteIdentity unchangedSource = ArticleVaultManifestCodec.CaptureSourceBytes(unchangedBytes);
        VaultSourceByteIdentity updatedSource = ArticleVaultManifestCodec.CaptureSourceBytes(updatedBytes);
        VaultArticleCoordinate baseCoordinate = Coordinate(unchangedSource);
        VaultArticleCoordinate local = decision == VaultSyncDecision.PushUpdate ? Coordinate(updatedSource) : baseCoordinate;
        VaultArticleCoordinate server = decision == VaultSyncDecision.PullUpdate ? Coordinate(updatedSource) : baseCoordinate;
        var coordinates = new VaultArticleCoordinates(baseCoordinate, local, server);
        var graph = new PortableDependencyManifest(PortableDependencySchemas.Manifest, PortableDependencySchemas.Version,
            binding, "042", coordinates,
            decision == VaultSyncDecision.PullUpdate ? VaultDependencySourceSide.Server : VaultDependencySourceSide.Local,
            ArticleVaultManifestCodec.CaptureSourceBytes(sourceBytes), DigestA, nodes.ToArray(), [], string.Empty, string.Empty);
        graph = graph with
        {
            GraphSha256 = PortableDependencyCodec.GraphDigest(graph)
        };
        graph = PortableDependencyCodec.Deserialize(PortableDependencyCodec.Serialize(PortableDependencyCodec.Seal(graph)));
        const string RelativePath = "articles/source.md";
        var article = new ArticleVaultArticleManifest(ArticleVaultSchemas.ArticleManifest, ArticleVaultSchemas.Version,
            SiteIdentity, VaultIdentity, "device-primary", ArticleIdentity, "042",
            new(RelativePath, ArticleVaultManifestCodec.ComputeProjectionSha256(RelativePath)), coordinates,
            new(0, null, null, null, null, null, null),
            decision == VaultSyncDecision.PushUpdate ? VaultArticleState.LocalModified
                : decision == VaultSyncDecision.PullUpdate ? VaultArticleState.ServerModified : VaultArticleState.Clean,
            string.Empty);
        article = article with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(article)
        };
        var root = new ArticleVaultRootManifest(ArticleVaultSchemas.RootManifest, ArticleVaultSchemas.Version,
            ArticleVaultSchemas.ControlTreeVersion,
            new(ArticleVaultSchemas.RootManifestPath, ArticleVaultSchemas.ArticleManifestDirectory, ArticleVaultSchemas.ReceiptDirectory),
            SiteIdentity, VaultIdentity, "device-primary",
            [new(ArticleIdentity, $"{ArticleVaultSchemas.ArticleManifestDirectory}/{ArticleIdentity}.json", article.ContentSha256, RelativePath)], [], string.Empty);
        root = root with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
        };
        var observation = new ArticleVaultServerObservation(ArticleVaultPlanSchemas.ServerObservation, ArticleVaultPlanSchemas.Version,
            SiteIdentity, VaultIdentity, "device-primary", ArticleIdentity, "042", server, string.Empty);
        observation = observation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
        };
        var request = new ArticleVaultPlanRequest(root, [article], [observation], [new("group-primary", [ArticleIdentity], [])],
            VaultSyncDirection.Sync, CreatedAtUnixMs, CreatedAtUnixMs + 60_000, false);
        ArticleVaultPlanBuildResult built = ArticleVaultSyncPlanner.Build(request);
        Assert.True(built.IsSuccess, string.Join(",", built.Errors));
        ArticleVaultSyncPlan plan = Assert.IsType<ArticleVaultSyncPlan>(built.Plan);
        VaultSyncPlanItem item = Assert.Single(Assert.Single(plan.Groups).Items);
        Assert.Equal(decision, item.Decision);
        var inputs = new List<VaultDependencyPlanInput> { new(graph, sourceBytes, nodes, [], DigestA) };
        var budgets = new ArticleEmbedResolutionBudgetLimits(8, 100, 1_000_000, 10_000, 100);
        VaultDependencyPlanBuildResult extension = ArticleVaultDependencyPlanner.Build(plan, request,
            new(time.UnixMs, plan.Direction, false), inputs, budgets, time);
        Assert.Null(extension.ReasonCode);
        ArticleVaultDependencyPlan dependencies = PortableDependencyCodec.DeserializePlan(
            PortableDependencyCodec.Serialize(Assert.IsType<ArticleVaultDependencyPlan>(extension.Plan)));
        ArticleVaultExecutionPayloadItem[] payloadItems = [];
        if (decision == VaultSyncDecision.PushUpdate)
        {
            var payloadItem = new ArticleVaultExecutionPayloadItem(item.OperationIdentity, ArticleIdentity, "042", "Updated article",
                "content\n", null, null, 1, [1], local.Source!.Sha256, local.MetadataManifestSha256!, string.Empty);
            payloadItems = [payloadItem with { ContentSha256 = ArticleVaultExecutionIntegrity.SealPayloadItem(payloadItem) }];
        }
        var payload = new ArticleVaultExecutionPayload(ArticleVaultExecutionSchemas.Payload, ArticleVaultExecutionSchemas.Version,
            payloadItems, string.Empty);
        payload = payload with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealPayload(payload)
        };
        var bundle = new ArticleVaultSealedExecutionBundle(ArticleVaultExecutionSchemas.Bundle, ArticleVaultExecutionSchemas.Version,
            plan.PlanCandidateIdentity, plan.ContentSha256, 7, plan, root, [article], [observation], payload, string.Empty);
        bundle = bundle with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealBundle(bundle)
        };
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        ArticleVaultOperationIdentity operation = ArticleVaultOperationVerifier.Bind(plan, "agent-primary", DigestA, DigestB, CreatedAtUnixMs + 30_000);
        return new(bundle, operation, dependencies, request, inputs, sourceBytes, nodes, time);

        VaultArticleCoordinate Coordinate(VaultSourceByteIdentity source)
        {
            var coordinate = new VaultArticleCoordinate(ArticleVaultSchemas.Coordinate, ArticleVaultSchemas.Version,
                true, false, 4, source, DigestB, DigestA, "draft", DigestA, string.Empty);
            var manifest = new PortableDependencyManifest(PortableDependencySchemas.Manifest, PortableDependencySchemas.Version,
                binding, "042", new(coordinate, coordinate, coordinate), VaultDependencySourceSide.Local,
                source, DigestA, nodes, [], string.Empty, string.Empty);
            coordinate = coordinate with
            {
                DependencySha256 = PortableDependencyCodec.GraphDigest(manifest)
            };
            return coordinate with
            {
                ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(coordinate)
            };
        }
    }

    internal sealed class Fixture
    {
        public Fixture(ArticleVaultSealedExecutionBundle bundle, ArticleVaultOperationIdentity operation,
            ArticleVaultDependencyPlan dependencies, ArticleVaultPlanRequest request, List<VaultDependencyPlanInput> inputs,
            byte[] sourceBytes, List<VaultDependencyNode> authorityNodes, MutableTimeProvider time)
        {
            Bundle = bundle;
            Operation = operation;
            Dependencies = dependencies;
            Request = request;
            Inputs = inputs;
            SourceBytes = sourceBytes;
            AuthorityNodes = authorityNodes;
            Time = time;
            Store = new(bundle);
            var record = new AssetRecord(AssetId.FromGuid(Asset.AssetIdentity), "public", AssetStorageKey.Parse("illustration/source.png"),
                Asset.MimeType, Asset.Extension, Asset.SizeBytes, Asset.ContentSha256, Asset.WidthPixels, Asset.HeightPixels,
                Asset.OwnerAdminPrincipalId, ContentAssetState.Active, DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch);
            List<AssetReference> references = [new(record.Id, ContentAssetSourceKinds.Article, "42", 42, 1, null, DateTimeOffset.UnixEpoch)];
            Files = new(new("fsusblog.upload-asset-observation.v1", s_access.UploadId, record,
                "/uploads/illustration/source.png", references, DigestA, DigestA));
            Adapter = new(Store, Files, time, SiteIdentity);
        }

        public ArticleVaultSealedExecutionBundle Bundle
        {
            get;
        }
        public ArticleVaultOperationIdentity Operation
        {
            get;
        }
        public ArticleVaultDependencyPlan Dependencies
        {
            get;
        }
        public ArticleVaultPlanRequest Request
        {
            get;
        }
        public List<VaultDependencyPlanInput> Inputs
        {
            get;
        }
        public byte[] SourceBytes
        {
            get;
        }
        public List<VaultDependencyNode> AuthorityNodes
        {
            get;
        }
        public MutableTimeProvider Time
        {
            get;
        }
        public SyntheticExecutionStore Store
        {
            get;
        }
        public SyntheticFiles Files
        {
            get;
        }
        public ArticleVaultAssetStagingAdapter Adapter
        {
            get;
        }
        public VaultSyncPlanItem Item => Assert.Single(Assert.Single(Bundle.Plan.Groups).Items);
        public VaultAssetDependency Asset => Assert.Single(Dependencies.Items).Manifest.Nodes.OfType<VaultAssetDependency>()
            .Single(static asset => asset.AssetIdentity == Guid.Parse("11111111-1111-1111-1111-111111111111"));

        public Task<Result<ArticleVaultAssetUploadHandoff>> PrepareAsync(
            ArticleVaultOperationIdentity? operation = null, ArticleVaultDependencyPlan? dependencies = null,
            string? itemOperationIdentity = null, Guid? assetIdentity = null, UploadSessionAccess? access = null,
            CancellationToken cancellationToken = default)
            => Adapter.PrepareCommittedUploadAsync(operation ?? Operation, dependencies ?? Dependencies, Request, Inputs,
                itemOperationIdentity ?? Item.OperationIdentity, assetIdentity ?? Asset.AssetIdentity, access ?? s_access, cancellationToken);
    }

    internal sealed class SyntheticFiles(UploadAssetObservation observation) : IFileService
    {
        public Result<UploadAssetObservation> Result { get; set; } = Result<UploadAssetObservation>.Success(observation);
        public List<(UploadSessionAccess Access, string Sha256, CancellationToken CancellationToken)> Reads { get; } = [];
        public Action? AfterRead
        {
            get; set;
        }
        public int NonObservationCalls
        {
            get; private set;
        }

        public async Task<Result<UploadAssetObservation>> ObserveCommittedUploadAsync(UploadSessionAccess access, string sha256,
            CancellationToken cancellationToken = default)
        {
            Reads.Add((access, sha256, cancellationToken));
            await Task.Yield();
            AfterRead?.Invoke();
            return Result;
        }

        public Task<Result<UploadInitDto>> InitUploadSessionAsync(long ownerAdminPrincipalId, UploadInitRequestDto dto, CancellationToken cancellationToken = default)
            => Forbidden<UploadInitDto>();
        public Task<Result<UploadStatusDto>> GetUploadStatusAsync(UploadSessionAccess access, CancellationToken cancellationToken = default)
            => Forbidden<UploadStatusDto>();
        public Task<Result<UploadPartMapDto>> GetUploadPartMapAsync(UploadSessionAccess access, CancellationToken cancellationToken = default)
            => Forbidden<UploadPartMapDto>();
        public Task<Result<UploadPartAckDto>> UploadPartAsync(UploadSessionAccess access, int partNumber, long offset, IFormFile part, string? payloadHash,
            CancellationToken cancellationToken = default)
            => Forbidden<UploadPartAckDto>();
        public Task<Result<UploadCompleteDto>> CompleteUploadAsync(UploadSessionAccess access, string? sha256, CancellationToken cancellationToken = default)
            => Forbidden<UploadCompleteDto>();
        public Task<Result<bool>> AbortUploadAsync(UploadSessionAccess access, CancellationToken cancellationToken = default)
            => Forbidden<bool>();

        private Task<Result<T>> Forbidden<T>()
        {
            NonObservationCalls++;
            return Task.FromException<Result<T>>(new InvalidOperationException("Staging must use only the original observation read."));
        }
    }

    internal sealed class SyntheticExecutionStore(ArticleVaultSealedExecutionBundle bundle) : IArticleVaultExecutionStore
    {
        public int LoadCount
        {
            get; private set;
        }
        public int WriteCount
        {
            get; private set;
        }
        public int OtherReadCount
        {
            get; private set;
        }
        public string? LastPlanReference
        {
            get; private set;
        }
        public string? LastPlanSha256
        {
            get; private set;
        }
        public Action? AfterLoad
        {
            get; set;
        }

        public async Task<ArticleVaultSealedExecutionBundle?> LoadSealedAsync(string planReference, string planSha256,
            CancellationToken cancellationToken = default)
        {
            LoadCount++;
            LastPlanReference = planReference;
            LastPlanSha256 = planSha256;
            await Task.Yield();
            AfterLoad?.Invoke();
            return planReference == bundle.PlanReference && planSha256 == bundle.PlanSha256 ? bundle : null;
        }

        public Task SealAsync(ArticleVaultSealedExecutionBundle value, CancellationToken cancellationToken = default)
        {
            WriteCount++;
            return Task.FromException(new InvalidOperationException("Staging cannot persist a bundle."));
        }

        public Task SaveResultAsync(ArticleVaultExecutionResult result, CancellationToken cancellationToken = default)
        {
            WriteCount++;
            return Task.FromException(new InvalidOperationException("Staging cannot persist a result."));
        }

        public Task<ArticleVaultGroupResultReceipt?> LoadGroupResultAsync(string siteIdentity, string vaultIdentity, string planSha256,
            string groupIdentity, string idempotencySha256, CancellationToken cancellationToken = default)
        {
            OtherReadCount++;
            return Task.FromException<ArticleVaultGroupResultReceipt?>(new InvalidOperationException("Staging cannot consume execution receipts."));
        }

        public Task<ArticleVaultExecutionResult?> LoadResultAsync(string resultReference, CancellationToken cancellationToken = default)
        {
            OtherReadCount++;
            return Task.FromException<ArticleVaultExecutionResult?>(new InvalidOperationException("Staging cannot consume execution results."));
        }
    }

    internal sealed class MutableTimeProvider(long unixMs) : TimeProvider
    {
        public long UnixMs { get; set; } = unixMs;
        public Action? BeforeUtcRead
        {
            get; set;
        }

        public override DateTimeOffset GetUtcNow()
        {
            BeforeUtcRead?.Invoke();
            return DateTimeOffset.FromUnixTimeMilliseconds(UnixMs);
        }
    }
}
