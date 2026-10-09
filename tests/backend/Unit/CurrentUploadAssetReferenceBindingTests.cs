using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Controlled ledger observations test binding, not native acquisition or grants.</summary>
public sealed class CurrentUploadAssetReferenceBindingTests
{
    [Theory]
    [InlineData(ContentAssetSourceKinds.Draft, "7:draft-key", null)]
    [InlineData(ContentAssetSourceKinds.Revision, "4", 42)]
    public void ExistingReference_BindsOnlyOneExactCanonicalSourceEdge(string kind, string key, int? articleId)
    {
        var (upload, session) = Input(kind, key, articleId);
        Assert.Equal(upload.References[0], CurrentUploadAssetReferenceBinding.FindReference(
            upload, session, upload.Asset.Id, upload.Asset.Sha256, kind, key, articleId));
        var duplicated = upload with
        {
            References = [upload.References[0], upload.References[0]]
        };
        Assert.Null(CurrentUploadAssetReferenceBinding.FindReference(duplicated, session,
            upload.Asset.Id, upload.Asset.Sha256, kind, key, articleId));
        Assert.Null(CurrentUploadAssetReferenceBinding.FindReference(upload, session,
            upload.Asset.Id, upload.Asset.Sha256, kind, "other-source", articleId));
    }

    [Fact]
    public void FrozenObservation_RetainsTheOriginalEdgeWhenProviderArrayChanges()
    {
        var (upload, _) = Input(ContentAssetSourceKinds.Revision, "4", 42);
        var original = (AssetReference[])upload.References;
        var frozen = CurrentUploadAssetReferenceBinding.Freeze(upload);
        original[0] = original[0] with
        {
            SourceKey = "5"
        };
        Assert.Equal("4", frozen.References[0].SourceKey);
        Assert.Equal("5", upload.References[0].SourceKey);
    }

    private static (UploadAssetObservation Upload, UploadSessionAccess Session) Input(string kind, string key, int? articleId)
    {
        var assetId = AssetId.New();
        var session = new UploadSessionAccess(assetId.Value.ToString("N"), 7, "controlled-session-token");
        var asset = new AssetRecord(assetId, "public", AssetStorageKey.Parse("illustration/" + session.UploadId + ".png"),
            "image/png", ".png", 68, new('a', 64), 1, 1, 7, ContentAssetState.Active,
            DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch);
        AssetReference[] references = [new(assetId, kind, key, articleId, 1, null, DateTimeOffset.UnixEpoch)];
        return (new("fsusblog.upload-asset-observation.v1", session.UploadId, asset, "/display-only",
            references, new('b', 64), new('c', 64)), session);
    }
}
