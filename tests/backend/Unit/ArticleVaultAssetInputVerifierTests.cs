using System.Security.Claims;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.ArticleVault.Assets;
using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault.Dependencies;

using Fixture = FsusBlog.Server.Tests.Unit.ArticleVaultAssetStagingAdapterTests.Fixture;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Ordinary input controls using real canonical plans, asset records and PNG bytes.
/// Synthetic fixture services are never invoked; passing does not prove asset acquisition,
/// live ledger rights, native grants, materialization or synchronized-base acceptance.
/// </summary>
[Trait("Category", "Unit")]
public sealed class ArticleVaultAssetInputVerifierTests
{
    private const string OtherDigest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static readonly Guid s_otherAssetId = Guid.Parse("33333333-3333-3333-3333-333333333333");

    [Theory]
    [InlineData(VaultSyncDecision.PullUpdate)]
    [InlineData(VaultSyncDecision.PushUpdate)]
    public void CurrentPullAndPushInputsValidateDeterministicallyWithoutIO(VaultSyncDecision decision)
    {
        byte[] bytes = PngBytes();
        Fixture fixture = CreateFixture(bytes, decision);

        AssertValid(Verify(fixture, bytes));
        AssertValid(Verify(fixture, bytes));
        Assert.Equal(bytes.LongLength, fixture.Asset.SizeBytes);
        AssertNoIO(fixture);
    }

    [Theory]
    [InlineData("site", "article_vault_asset_input_binding_invalid")]
    [InlineData("empty-site", "article_vault_asset_input_binding_invalid")]
    [InlineData("empty-item", "article_vault_asset_input_binding_invalid")]
    [InlineData("unknown-item", "article_vault_asset_input_content_item_missing")]
    [InlineData("empty-asset", "article_vault_asset_input_binding_invalid")]
    [InlineData("unknown-asset", "article_vault_asset_input_asset_not_planned")]
    [InlineData("global-operation", "article_vault_operation_identity_invalid")]
    [InlineData("plan-reference", "article_vault_operation_identity_invalid")]
    [InlineData("plan-sha", "article_vault_operation_identity_invalid")]
    [InlineData("vault", "article_vault_operation_identity_invalid")]
    [InlineData("device", "article_vault_operation_identity_invalid")]
    public void ExactScopeItemAssetAndGlobalOperationAreRequired(string change, string reason)
    {
        byte[] bytes = PngBytes();
        Fixture fixture = CreateFixture(bytes);
        ArticleVaultOperationIdentity operation = change switch
        {
            "global-operation" => fixture.Operation with { OperationIdentity = "operation-other" },
            "plan-reference" => fixture.Operation with { PlanReference = "plan-other" },
            "plan-sha" => fixture.Operation with { PlanSha256 = OtherDigest },
            "vault" => fixture.Operation with { VaultIdentity = "vault-other" },
            "device" => fixture.Operation with { DeviceIdentity = "device-other" },
            _ => fixture.Operation
        };
        string site = change switch
        {
            "site" => "site-other",
            "empty-site" => "",
            _ => fixture.Bundle.Plan.SiteIdentity
        };
        string item = change switch
        {
            "empty-item" => "",
            "unknown-item" => "item-other",
            _ => fixture.Item.OperationIdentity
        };
        Guid asset = change switch
        {
            "empty-asset" => Guid.Empty,
            "unknown-asset" => s_otherAssetId,
            _ => fixture.Asset.AssetIdentity
        };

        AssertRejected(Verify(fixture, bytes, operation: operation, site: site, item: item, asset: asset), reason);
        AssertNoIO(fixture);
    }

    [Theory]
    [InlineData("other-admin")]
    [InlineData("unauthenticated")]
    [InlineData("ordinary-user")]
    [InlineData("missing-admin-id")]
    [InlineData("invalid-admin-id")]
    public void AuthenticatedOriginalAdminPrincipalIsRequired(string change)
    {
        byte[] bytes = PngBytes();
        Fixture fixture = CreateFixture(bytes);
        string? id = change switch
        {
            "other-admin" => "8",
            "missing-admin-id" => null,
            "invalid-admin-id" => "0",
            _ => "7"
        };
        ClaimsPrincipal principal = Principal(id, change != "unauthenticated", change != "ordinary-user");

        AssertRejected(Verify(fixture, bytes, principal: principal), "article_vault_asset_input_principal_mismatch");
        AssertNoIO(fixture);
    }

    [Theory]
    [InlineData("identity", "article_vault_asset_identity_mismatch")]
    [InlineData("pending-delete", "article_vault_asset_inactive")]
    [InlineData("undefined-state", "article_vault_asset_metadata_invalid")]
    [InlineData("missing-hash", "article_vault_asset_digest_missing")]
    [InlineData("invalid-hash", "article_vault_asset_metadata_invalid")]
    [InlineData("owner", "article_vault_asset_input_asset_metadata_drift")]
    [InlineData("missing-owner", "article_vault_asset_input_asset_metadata_drift")]
    [InlineData("width", "article_vault_asset_input_asset_metadata_drift")]
    [InlineData("height", "article_vault_asset_input_asset_metadata_drift")]
    [InlineData("hash", "article_vault_asset_input_asset_metadata_drift")]
    [InlineData("mime", "article_vault_asset_input_asset_metadata_drift")]
    [InlineData("extension", "article_vault_asset_input_asset_metadata_drift")]
    [InlineData("size", "article_vault_asset_input_asset_metadata_drift")]
    [InlineData("zero-size", "article_vault_asset_size_invalid")]
    [InlineData("storage-key", "article_vault_asset_metadata_invalid")]
    public void CanonicalRecordAndPlannedMetadataRemainRequired(string change, string reason)
    {
        byte[] bytes = PngBytes();
        Fixture fixture = CreateFixture(bytes);
        AssetRecord record = Record(fixture);
        record = change switch
        {
            "identity" => record with { Id = AssetId.FromGuid(s_otherAssetId) },
            "pending-delete" => record with { State = ContentAssetState.PendingDelete },
            "undefined-state" => record with { State = (ContentAssetState)99 },
            "missing-hash" => record with { Sha256 = null },
            "invalid-hash" => record with { Sha256 = "invalid" },
            "owner" => record with { OwnerAdminPrincipalId = 8 },
            "missing-owner" => record with { OwnerAdminPrincipalId = null },
            "width" => record with { WidthPixels = 2 },
            "height" => record with { HeightPixels = 2 },
            "hash" => record with { Sha256 = OtherDigest },
            "mime" => record with { MimeType = "image/jpeg" },
            "extension" => record with { Extension = ".jpg" },
            "size" => record with { SizeBytes = bytes.LongLength + 1 },
            "zero-size" => record with { SizeBytes = 0 },
            _ => record with { StorageKey = default }
        };

        AssertRejected(Verify(fixture, bytes, record: record), reason);
        AssertNoIO(fixture);
    }

    [Fact]
    public void MissingCanonicalRecordCannotBeInferredFromPlannedMetadata()
    {
        byte[] bytes = PngBytes();
        Fixture fixture = CreateFixture(bytes);

        AssertRejected(ArticleVaultAssetInputVerifier.VerifyCurrent(fixture.Operation, fixture.Bundle, fixture.Dependencies,
            fixture.Request, fixture.Inputs, Principal(), fixture.Bundle.Plan.SiteIdentity, fixture.Item.OperationIdentity,
            fixture.Asset.AssetIdentity, null, bytes, fixture.Time), "article_vault_asset_missing");
        AssertNoIO(fixture);
    }

    [Theory]
    [InlineData("empty", "article_vault_asset_size_mismatch")]
    [InlineData("truncated", "article_vault_asset_size_mismatch")]
    [InlineData("corrupt", "article_vault_asset_digest_mismatch")]
    public void SuppliedBytesMustMatchPlannedSizeAndCanonicalDigest(string change, string reason)
    {
        byte[] bytes = PngBytes();
        Fixture fixture = CreateFixture(bytes);
        byte[] supplied = change switch
        {
            "empty" => [],
            "truncated" => bytes[..^1],
            _ => bytes.ToArray()
        };
        if (change == "corrupt")
        {
            supplied[0] ^= 1;
        }

        AssertRejected(Verify(fixture, supplied), reason);
        AssertNoIO(fixture);
    }

    [Theory]
    [InlineData("header", "article_vault_asset_media_invalid_or_unsupported")]
    [InlineData("truncated-header", "article_vault_asset_media_invalid_or_unsupported")]
    [InlineData("width", "article_vault_asset_media_metadata_mismatch")]
    public void MatchingDigestDoesNotBypassOriginalMediaInspection(string change, string reason)
    {
        byte[] bytes = PngBytes();
        if (change == "header")
        {
            bytes[0] ^= 1;
        }
        else if (change == "truncated-header")
        {
            bytes = bytes[..20];
        }
        else
        {
            bytes[19] = 2;
        }
        Fixture fixture = CreateFixture(bytes);

        AssertRejected(Verify(fixture, bytes), reason);
        AssertNoIO(fixture);
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
    public void CurrentGraphIsRevalidatedBeforeAndAfterBytes(string change, bool afterBytes, string reason)
    {
        byte[] bytes = PngBytes();
        Fixture fixture = CreateFixture(bytes);
        if (afterBytes)
        {
            int reads = 0;
            fixture.Time.BeforeUtcRead = () =>
            {
                if (++reads == 2)
                {
                    ChangeCurrentInput(fixture, change);
                }
            };
        }
        else
        {
            ChangeCurrentInput(fixture, change);
        }

        AssertRejected(Verify(fixture, bytes), reason);
        AssertNoIO(fixture);
    }

    [Fact]
    public void NoOpDoesNotAdmitAssetContentInputs()
    {
        byte[] bytes = PngBytes();
        Fixture fixture = CreateFixture(bytes, VaultSyncDecision.NoOp);

        AssertRejected(Verify(fixture, bytes), "article_vault_asset_input_content_item_missing");
        AssertNoIO(fixture);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public void CancellationBeforeEntryAndDuringBothCurrentChecksThrowsWithoutIO(int cancelOnRead)
    {
        byte[] bytes = PngBytes();
        Fixture fixture = CreateFixture(bytes);
        using var cancellation = new CancellationTokenSource();
        if (cancelOnRead == 0)
        {
            cancellation.Cancel();
        }
        else
        {
            int reads = 0;
            fixture.Time.BeforeUtcRead = () =>
            {
                if (++reads == cancelOnRead)
                {
                    cancellation.Cancel();
                }
            };
        }

        Assert.Throws<OperationCanceledException>(() => Verify(fixture, bytes, cancellationToken: cancellation.Token));
        AssertNoIO(fixture);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void TrustedTimeRejectsDeadlineBeforeAndAfterByteVerification(bool afterBytes)
    {
        byte[] bytes = PngBytes();
        Fixture fixture = CreateFixture(bytes);
        if (afterBytes)
        {
            int reads = 0;
            fixture.Time.BeforeUtcRead = () =>
            {
                if (++reads == 2)
                {
                    fixture.Time.UnixMs = fixture.Operation.DeadlineUnixMs + 1;
                }
            };
        }
        else
        {
            fixture.Time.UnixMs = fixture.Operation.DeadlineUnixMs + 1;
        }

        AssertRejected(Verify(fixture, bytes), "article_vault_asset_input_deadline_expired");
        AssertNoIO(fixture);
    }

    [Fact]
    public void ExactDeadlineAndCanonicalUppercaseDigestRemainValid()
    {
        byte[] bytes = PngBytes();
        Fixture fixture = CreateFixture(bytes);
        fixture.Time.UnixMs = fixture.Operation.DeadlineUnixMs;
        AssetRecord record = Record(fixture) with
        {
            Sha256 = fixture.Asset.ContentSha256.ToUpperInvariant()
        };

        AssertValid(Verify(fixture, bytes, record: record));
        AssertNoIO(fixture);
    }

    [Fact]
    public void EqualBytesPreserveDistinctAssetOwnersRightsAndIdentities()
    {
        byte[] bytes = PngBytes();
        Fixture fixture = CreateFixture(bytes, twoAssets: true);
        VaultAssetDependency[] assets = Assert.Single(fixture.Dependencies.Items).Manifest.Nodes.OfType<VaultAssetDependency>().ToArray();
        Assert.Equal(2, assets.Length);
        VaultAssetDependency other = Assert.Single(assets, asset => asset.AssetIdentity != fixture.Asset.AssetIdentity);
        Assert.Equal(fixture.Asset.ContentSha256, other.ContentSha256);
        Assert.NotEqual(fixture.Asset.OwnerAdminPrincipalId, other.OwnerAdminPrincipalId);
        Assert.NotEqual(fixture.Asset.Admission.RightsSha256, other.Admission.RightsSha256);
        AssetRecord otherRecord = Record(fixture) with
        {
            Id = AssetId.FromGuid(other.AssetIdentity),
            OwnerAdminPrincipalId = other.OwnerAdminPrincipalId
        };

        AssertValid(Verify(fixture, bytes));
        AssertValid(Verify(fixture, bytes, asset: other.AssetIdentity, record: otherRecord));
        AssertRejected(Verify(fixture, bytes, asset: other.AssetIdentity), "article_vault_asset_identity_mismatch");
        AssertRejected(Verify(fixture, bytes, asset: other.AssetIdentity,
            record: otherRecord with
            {
                OwnerAdminPrincipalId = fixture.Asset.OwnerAdminPrincipalId
            }),
            "article_vault_asset_input_asset_metadata_drift");
        AssertNoIO(fixture);
    }

    private static Fixture CreateFixture(byte[] bytes, VaultSyncDecision decision = VaultSyncDecision.PushUpdate, bool twoAssets = false)
        => ArticleVaultAssetStagingAdapterTests.CreateFixture(decision, twoAssets, bytes);

    private static byte[] PngBytes()
        => Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZWkAAAAASUVORK5CYII=");

    private static AssetRecord Record(Fixture fixture) => fixture.Files.Result.Value!.Asset;

    private static ClaimsPrincipal Principal(string? adminId = "7", bool authenticated = true, bool admin = true)
    {
        var claims = new List<Claim>
        {
            new("identity_kind", admin ? AnonymousIdentityRuntime.AdminPrincipalKind : "user")
        };
        if (adminId is not null)
        {
            claims.Add(new("admin_id", adminId));
        }
        return new(new ClaimsIdentity(claims, authenticated ? "unit-control" : null));
    }

    private static ArticleVaultValidationResult Verify(Fixture fixture, byte[] bytes,
        AssetRecord? record = null, ClaimsPrincipal? principal = null, ArticleVaultOperationIdentity? operation = null,
        string? site = null, string? item = null, Guid? asset = null, CancellationToken cancellationToken = default)
        => ArticleVaultAssetInputVerifier.VerifyCurrent(operation ?? fixture.Operation, fixture.Bundle,
            fixture.Dependencies, fixture.Request, fixture.Inputs, principal ?? Principal(),
            site ?? fixture.Bundle.Plan.SiteIdentity, item ?? fixture.Item.OperationIdentity,
            asset ?? fixture.Asset.AssetIdentity, record ?? Record(fixture), bytes, fixture.Time, cancellationToken);

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
            "rights" => asset with { Admission = asset.Admission with { RightsSha256 = OtherDigest } },
            "permission" => asset with { Admission = asset.Admission with { Permission = ArticleEmbedPermissionStatus.Denied } },
            "owner" => asset with { OwnerAdminPrincipalId = 8 },
            _ => asset with { AssetIdentity = s_otherAssetId }
        };
    }

    private static void AssertValid(ArticleVaultValidationResult result)
    {
        Assert.True(result.IsValid, result.ReasonCode);
        Assert.Null(result.ReasonCode);
    }

    private static void AssertRejected(ArticleVaultValidationResult result, string reason)
    {
        Assert.False(result.IsValid);
        Assert.Equal(reason, result.ReasonCode);
    }

    private static void AssertNoIO(Fixture fixture)
    {
        Assert.Empty(fixture.Files.Reads);
        Assert.Equal(0, fixture.Files.NonObservationCalls);
        Assert.Equal(0, fixture.Store.LoadCount);
        Assert.Equal(0, fixture.Store.OtherReadCount);
        Assert.Equal(0, fixture.Store.WriteCount);
    }
}
