using System.Security.Cryptography;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Services.ArticleVault.Assets;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleVaultAssetValidationTests
{
    private static readonly AssetId s_assetId = AssetId.Parse("5a2cc092-4c38-46b7-9371-cd2f40d3470a");
    private static readonly DateTimeOffset s_utcNow = new(2026, 10, 8, 12, 0, 0, TimeSpan.Zero);
    private static readonly byte[] s_pngBytes = Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZWkAAAAASUVORK5CYII=");

    [Fact]
    public void ValidateBytes_AcceptsActualBytesAndCanonicalRecord()
    {
        AssetRecord record = Record();

        ArticleVaultAssetValidationResult result = ArticleVaultAssetValidator.ValidateBytes(s_assetId, record, s_pngBytes);

        Assert.True(result.IsValid);
        Assert.Null(result.ReasonCode);
        Assert.Equal(record.Sha256, result.ObservedSha256);
    }

    [Fact]
    public void ValidateBytes_AcceptsCanonicalContractDigestCase()
    {
        AssetRecord record = Record() with
        {
            Sha256 = Record().Sha256!.ToUpperInvariant()
        };

        ArticleVaultAssetValidationResult result = ArticleVaultAssetValidator.ValidateBytes(s_assetId, record, s_pngBytes);

        Assert.True(result.IsValid);
        Assert.Equal(record.Sha256.ToLowerInvariant(), result.ObservedSha256);
    }

    [Fact]
    public void ValidateBytes_RejectsMissingRecord()
    {
        AssertReason("article_vault_asset_missing", ArticleVaultAssetValidator.ValidateBytes(s_assetId, null, s_pngBytes));
    }

    [Fact]
    public void ValidateBytes_DoesNotIdentifyAnotherAssetBySameStorageKeyOrDigest()
    {
        AssetRecord record = Record() with
        {
            Id = AssetId.Parse("ed76c42f-23f7-42bb-ad99-f2cb9a209e90")
        };

        AssertReason("article_vault_asset_identity_mismatch", ArticleVaultAssetValidator.ValidateBytes(s_assetId, record, s_pngBytes));
    }

    [Fact]
    public void ValidateBytes_RejectsEmptyTypedIdentity()
    {
        AssetRecord record = Record() with
        {
            Id = default
        };

        AssertReason("article_vault_asset_identity_invalid", ArticleVaultAssetValidator.ValidateBytes(default, record, s_pngBytes));
    }

    [Theory]
    [InlineData("storage-key")]
    [InlineData("mime")]
    [InlineData("extension")]
    [InlineData("digest")]
    [InlineData("dimensions")]
    [InlineData("owner")]
    [InlineData("state")]
    [InlineData("storage-class")]
    [InlineData("negative-size")]
    [InlineData("timestamp")]
    public void ValidateBytes_RejectsInvalidCanonicalMetadata(string field)
    {
        AssetRecord record = Record();
        record = field switch
        {
            "storage-key" => record with { StorageKey = default },
            "mime" => record with { MimeType = "png" },
            "extension" => record with { Extension = "../png" },
            "digest" => record with { Sha256 = new string('z', 64) },
            "dimensions" => record with { WidthPixels = 0 },
            "owner" => record with { OwnerAdminPrincipalId = 0 },
            "state" => record with { State = (ContentAssetState)999 },
            "storage-class" => record with { StorageClass = "unknown" },
            "negative-size" => record with { SizeBytes = -1 },
            "timestamp" => record with { UpdatedAtUtc = s_utcNow.AddSeconds(-1) },
            _ => throw new ArgumentOutOfRangeException(nameof(field))
        };

        AssertReason("article_vault_asset_metadata_invalid", ArticleVaultAssetValidator.ValidateBytes(s_assetId, record, s_pngBytes));
    }

    [Fact]
    public void ValidateBytes_RequiresDigestEvenWhenCanonicalRecordAllowsNull()
    {
        AssetRecord record = Record() with
        {
            Sha256 = null
        };
        ContentAssetSchemaValidator.Validate(record);

        AssertReason("article_vault_asset_digest_missing", ArticleVaultAssetValidator.ValidateBytes(s_assetId, record, s_pngBytes));
    }

    [Fact]
    public void ValidateBytes_RejectsPendingDeleteRecord()
    {
        AssetRecord record = Record() with
        {
            State = ContentAssetState.PendingDelete
        };

        AssertReason("article_vault_asset_inactive", ArticleVaultAssetValidator.ValidateBytes(s_assetId, record, s_pngBytes));
    }

    [Fact]
    public void ValidateBytes_RejectsZeroLengthRecord()
    {
        AssetRecord record = Record() with
        {
            SizeBytes = 0,
            Sha256 = Convert.ToHexStringLower(SHA256.HashData([]))
        };

        AssertReason("article_vault_asset_size_invalid", ArticleVaultAssetValidator.ValidateBytes(s_assetId, record, []));
    }

    [Fact]
    public void ValidateBytes_RejectsMissingOrTruncatedBytes()
    {
        AssertReason("article_vault_asset_size_mismatch", ArticleVaultAssetValidator.ValidateBytes(s_assetId, Record(), []));
        AssertReason("article_vault_asset_size_mismatch", ArticleVaultAssetValidator.ValidateBytes(s_assetId, Record(), s_pngBytes.AsSpan(0, 24)));
    }

    [Fact]
    public void ValidateBytes_RejectsSameSizeByteCorruption()
    {
        byte[] corrupt = s_pngBytes.ToArray();
        corrupt[^1] ^= 1;

        ArticleVaultAssetValidationResult result = ArticleVaultAssetValidator.ValidateBytes(s_assetId, Record(), corrupt);

        AssertReason("article_vault_asset_digest_mismatch", result);
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(corrupt)), result.ObservedSha256);
    }

    [Fact]
    public void ValidateBytes_RejectsInvalidMagicEvenWithMatchingDigestAndLength()
    {
        byte[] corrupt = s_pngBytes.ToArray();
        corrupt[0] = 0;
        AssetRecord record = Record() with
        {
            Sha256 = Convert.ToHexStringLower(SHA256.HashData(corrupt))
        };

        AssertReason("article_vault_asset_media_invalid_or_unsupported", ArticleVaultAssetValidator.ValidateBytes(s_assetId, record, corrupt));
    }

    [Theory]
    [InlineData("mime")]
    [InlineData("dimensions")]
    public void ValidateBytes_RejectsMetadataThatDisagreesWithInspectedBytes(string field)
    {
        AssetRecord record = field == "mime"
            ? Record() with
            {
                MimeType = "image/jpeg"
            }
            : Record() with
            {
                WidthPixels = 2
            };

        AssertReason("article_vault_asset_media_metadata_mismatch", ArticleVaultAssetValidator.ValidateBytes(s_assetId, record, s_pngBytes));
    }

    [Theory]
    [InlineData(".jpg")]
    [InlineData(".txt")]
    public void ValidateBytes_RejectsMismatchingOrUnsupportedExtension(string extension)
    {
        AssetRecord record = Record() with
        {
            Extension = extension
        };

        AssertReason("article_vault_asset_media_invalid_or_unsupported", ArticleVaultAssetValidator.ValidateBytes(s_assetId, record, s_pngBytes));
    }

    [Fact]
    public void ValidateBytes_UsesCanonicalAssetIdWhenStorageMappingChanges()
    {
        AssetRecord record = Record() with
        {
            StorageKey = AssetStorageKey.Parse("other/renamed.png")
        };

        Assert.True(ArticleVaultAssetValidator.ValidateBytes(s_assetId, record, s_pngBytes).IsValid);
    }

    [Theory]
    [InlineData('a', 'a', 'a', "Unchanged")]
    [InlineData('a', 'b', 'a', "LocalChanged")]
    [InlineData('a', 'a', 'b', "ServerChanged")]
    [InlineData('a', 'b', 'b', "ConvergedChange")]
    [InlineData('a', 'b', 'c', "DivergedChange")]
    public void Diagnose_UsesExactThreeWayDigestsWithoutSelectingWinner(
        char baseDigest,
        char localDigest,
        char serverDigest,
        string expectedRelation)
    {
        ArticleVaultAssetConflictDiagnostic result = ArticleVaultAssetConflictDiagnostics.Diagnose(
            s_assetId,
            Record() with
            {
                Sha256 = new string(baseDigest, 64)
            },
            Record() with
            {
                Sha256 = new string(localDigest, 64)
            },
            Record() with
            {
                Sha256 = new string(serverDigest, 64)
            });

        Assert.Equal(expectedRelation, result.ContentRelation.ToString());
        Assert.Equal(new string(baseDigest, 64), result.BaseSha256);
        Assert.Equal(new string(localDigest, 64), result.LocalSha256);
        Assert.Equal(new string(serverDigest, 64), result.ServerSha256);
        Assert.Empty(result.Issues);
    }

    [Fact]
    public void Diagnose_UsesDigestBytesRatherThanHexCase()
    {
        AssetRecord record = Record();

        ArticleVaultAssetConflictDiagnostic result = ArticleVaultAssetConflictDiagnostics.Diagnose(
            s_assetId,
            record,
            record with
            {
                Sha256 = record.Sha256!.ToUpperInvariant()
            },
            record);

        Assert.Equal(ArticleVaultAssetContentRelation.Unchanged, result.ContentRelation);
        Assert.Equal(record.Sha256, result.LocalSha256);
        Assert.Empty(result.Issues);
    }

    [Fact]
    public void Diagnose_SameContentKeepsOwnerFactsIndependent()
    {
        AssetRecord record = Record();

        ArticleVaultAssetConflictDiagnostic result = ArticleVaultAssetConflictDiagnostics.Diagnose(
            s_assetId,
            record,
            record with
            {
                OwnerAdminPrincipalId = 8
            },
            record with
            {
                OwnerAdminPrincipalId = 9
            });

        Assert.Equal(ArticleVaultAssetContentRelation.Unchanged, result.ContentRelation);
        Assert.Contains(result.Issues, issue => issue.Side == ArticleVaultAssetObservationSide.Local && issue.ReasonCode == "article_vault_asset_owner_drift");
        Assert.Contains(result.Issues, issue => issue.Side == ArticleVaultAssetObservationSide.Server && issue.ReasonCode == "article_vault_asset_owner_drift");
        Assert.Equal(7, record.OwnerAdminPrincipalId);
    }

    [Fact]
    public void Diagnose_DetectsStorageClassChangeEvenWithEqualDigest()
    {
        AssetRecord record = Record();

        ArticleVaultAssetConflictDiagnostic result = ArticleVaultAssetConflictDiagnostics.Diagnose(
            s_assetId,
            record,
            record,
            record with
            {
                StorageClass = "private"
            });

        Assert.Contains(result.Issues, issue => issue.Side == ArticleVaultAssetObservationSide.Server && issue.ReasonCode == "article_vault_asset_storage_class_drift");
    }

    [Fact]
    public void Diagnose_ReportsMediaMetadataDriftForSameContent()
    {
        AssetRecord record = Record();

        ArticleVaultAssetConflictDiagnostic result = ArticleVaultAssetConflictDiagnostics.Diagnose(
            s_assetId,
            record,
            record with
            {
                WidthPixels = 2
            },
            record);

        Assert.Contains(result.Issues, issue => issue.Side == ArticleVaultAssetObservationSide.Local && issue.ReasonCode == "article_vault_asset_media_metadata_drift");
    }

    [Fact]
    public void Diagnose_ReportsConvergedDigestWithDisagreeingMetadata()
    {
        AssetRecord record = Record();

        ArticleVaultAssetConflictDiagnostic result = ArticleVaultAssetConflictDiagnostics.Diagnose(
            s_assetId,
            record,
            record with
            {
                Sha256 = new string('a', 64),
                WidthPixels = 2
            },
            record with
            {
                Sha256 = new string('a', 64),
                WidthPixels = 3
            });

        Assert.Equal(ArticleVaultAssetContentRelation.ConvergedChange, result.ContentRelation);
        Assert.Contains(result.Issues, issue => issue.ReasonCode == "article_vault_asset_media_metadata_drift");
    }

    [Fact]
    public void Diagnose_PathAndTimestampDoNotDetermineContentRelation()
    {
        AssetRecord record = Record();

        ArticleVaultAssetConflictDiagnostic result = ArticleVaultAssetConflictDiagnostics.Diagnose(
            s_assetId,
            record,
            record with
            {
                StorageKey = AssetStorageKey.Parse("renamed/other.png"),
                UpdatedAtUtc = s_utcNow.AddDays(1)
            },
            record with
            {
                StorageKey = AssetStorageKey.Parse("server/another.png"),
                UpdatedAtUtc = s_utcNow.AddDays(2)
            });

        Assert.Equal(ArticleVaultAssetContentRelation.Unchanged, result.ContentRelation);
        Assert.Empty(result.Issues);
    }

    [Theory]
    [InlineData("Base")]
    [InlineData("Local")]
    [InlineData("Server")]
    public void Diagnose_MissingObservationIsIncompleteAndCannotRequestDeletion(string side)
    {
        AssetRecord record = Record();

        ArticleVaultAssetConflictDiagnostic result = ArticleVaultAssetConflictDiagnostics.Diagnose(
            s_assetId,
            side == "Base" ? null : record,
            side == "Local" ? null : record,
            side == "Server" ? null : record);

        Assert.Equal(ArticleVaultAssetContentRelation.Incomplete, result.ContentRelation);
        ArticleVaultAssetDiagnosticIssue issue = Assert.Single(result.Issues);
        Assert.Equal(side, issue.Side.ToString());
        Assert.Equal("article_vault_asset_missing", issue.ReasonCode);
    }

    [Fact]
    public void Diagnose_DifferentAssetIdDoesNotConvergeBySameDigestOrStorageKey()
    {
        AssetRecord record = Record();

        ArticleVaultAssetConflictDiagnostic result = ArticleVaultAssetConflictDiagnostics.Diagnose(
            s_assetId,
            record,
            record with
            {
                Id = AssetId.Parse("ed76c42f-23f7-42bb-ad99-f2cb9a209e90")
            },
            record);

        Assert.Equal(ArticleVaultAssetContentRelation.Incomplete, result.ContentRelation);
        Assert.Equal("article_vault_asset_identity_mismatch", Assert.Single(result.Issues).ReasonCode);
    }

    [Fact]
    public void Diagnose_DoesNotCompareMissingDigestAsContentEquality()
    {
        AssetRecord record = Record() with
        {
            Sha256 = null
        };

        ArticleVaultAssetConflictDiagnostic result = ArticleVaultAssetConflictDiagnostics.Diagnose(s_assetId, record, record, record);

        Assert.Equal(ArticleVaultAssetContentRelation.Incomplete, result.ContentRelation);
        Assert.Equal(3, result.Issues.Count);
        Assert.All(result.Issues, issue => Assert.Equal("article_vault_asset_digest_missing", issue.ReasonCode));
    }

    private static AssetRecord Record()
        => new(
            s_assetId,
            "public",
            AssetStorageKey.Parse("assets/example.png"),
            "image/png",
            ".png",
            s_pngBytes.Length,
            Convert.ToHexStringLower(SHA256.HashData(s_pngBytes)),
            1,
            1,
            7,
            ContentAssetState.Active,
            s_utcNow,
            s_utcNow);

    private static void AssertReason(string expectedReason, ArticleVaultAssetValidationResult result)
    {
        Assert.False(result.IsValid);
        Assert.Equal(expectedReason, result.ReasonCode);
    }
}
