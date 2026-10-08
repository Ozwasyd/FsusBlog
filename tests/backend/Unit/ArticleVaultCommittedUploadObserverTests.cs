using System.Reflection;

using FsusBlog.Core.Common;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.ArticleVault.Assets;
using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleVault.Dependencies;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Adapter controls only; synthetic authority responses do not qualify a live ledger or native bytes.</summary>
[Trait("Category", "Unit")]
public sealed class ArticleVaultCommittedUploadObserverTests
{
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly AssetId s_id = AssetId.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly UploadSessionAccess s_access = new("11111111111111111111111111111111", 7, "existing-session-grant");

    [Fact]
    public async Task UsesOnlyCanonicalObservationCallAndReturnsItsUnmodifiedFacts()
    {
        UploadAssetObservation observation = Observation();
        IFileService files = Service(Result<UploadAssetObservation>.Success(observation), out ObservationProxy calls);
        Result<UploadAssetObservation> result = await new ArticleVaultCommittedUploadObserver(files).ObserveAsync(s_access, Dependency());
        Assert.True(result.IsSuccess, result.Error.Message);
        Assert.Same(observation, result.Value);
        Assert.Equal(1, calls.Count);
        Assert.Equal(s_access, calls.Access);
        Assert.Equal(Digest, calls.Digest);
    }

    [Fact]
    public async Task ObservationDoesNotQualifyVaultRightsOrRevision()
    {
        VaultAssetDependency expected = Dependency();
        expected = expected with
        {
            Admission = expected.Admission with
            {
                Permission = ArticleEmbedPermissionStatus.Denied,
                GrantedRights = 0
            },
            ServerRevision = 900
        };
        UploadAssetObservation observation = Observation();
        IFileService files = Service(Result<UploadAssetObservation>.Success(observation), out _);
        Result<UploadAssetObservation> result = await new ArticleVaultCommittedUploadObserver(files).ObserveAsync(s_access, expected);
        Assert.True(result.IsSuccess);
        Assert.Same(observation, result.Value);
    }

    [Theory]
    [InlineData("identity")]
    [InlineData("digest")]
    [InlineData("mime")]
    [InlineData("extension")]
    [InlineData("size")]
    [InlineData("width")]
    [InlineData("height")]
    [InlineData("owner")]
    [InlineData("inactive")]
    [InlineData("missing")]
    [InlineData("version")]
    [InlineData("references-digest")]
    [InlineData("references")]
    public async Task CurrentAuthorityDriftFailsClosed(string change)
    {
        UploadAssetObservation observed = Observation();
        observed = change switch
        {
            "identity" => observed with { Asset = observed.Asset with { Id = AssetId.FromGuid(Guid.NewGuid()) } },
            "digest" => observed with { Asset = observed.Asset with { Sha256 = new string('b', 64) } },
            "mime" => observed with { Asset = observed.Asset with { MimeType = "image/jpeg", Extension = ".jpg" } },
            "extension" => observed with { Asset = observed.Asset with { Extension = ".apng" } },
            "size" => observed with { Asset = observed.Asset with { SizeBytes = 25 } },
            "width" => observed with { Asset = observed.Asset with { WidthPixels = 2 } },
            "height" => observed with { Asset = observed.Asset with { HeightPixels = 2 } },
            "owner" => observed with { Asset = observed.Asset with { OwnerAdminPrincipalId = 8 } },
            "inactive" => observed with { Asset = observed.Asset with { State = ContentAssetState.PendingDelete } },
            "missing" => observed with { Asset = null! },
            "version" => observed with { AssetVersionSha256 = "" },
            "references-digest" => observed with { ReferenceLedgerSha256 = "" },
            "references" => observed with { References = null! },
            _ => throw new InvalidOperationException()
        };
        IFileService files = Service(Result<UploadAssetObservation>.Success(observed), out _);
        Result<UploadAssetObservation> result = await new ArticleVaultCommittedUploadObserver(files).ObserveAsync(s_access, Dependency());
        Assert.True(result.IsFailure);
        Assert.Null(result.Value);
    }

    [Fact]
    public async Task OriginalFailureReasonAndCodeArePreserved()
    {
        Result<UploadAssetObservation> failure = Result<UploadAssetObservation>.Failure(ErrorCode.NotFound, "UPLOAD_SESSION_NOT_FOUND");
        IFileService files = Service(failure, out _);
        Result<UploadAssetObservation> result = await new ArticleVaultCommittedUploadObserver(files).ObserveAsync(s_access, Dependency());
        Assert.True(result.IsFailure);
        Assert.Equal(failure.Error, result.Error);
    }

    [Theory]
    [InlineData("null")]
    [InlineData("identity")]
    [InlineData("digest")]
    public async Task InvalidDependencyNeverInvokesUploadAuthority(string change)
    {
        VaultAssetDependency? expected = change switch
        {
            "null" => null,
            "identity" => Dependency() with { AssetIdentity = Guid.Empty },
            _ => Dependency() with { ContentSha256 = "invalid" }
        };
        IFileService files = Service(Result<UploadAssetObservation>.Success(Observation()), out ObservationProxy calls);
        Assert.True((await new ArticleVaultCommittedUploadObserver(files).ObserveAsync(s_access, expected)).IsFailure);
        Assert.Equal(0, calls.Count);
    }

    [Fact]
    public async Task CancellationPrecedesAuthorityCall()
    {
        IFileService files = Service(Result<UploadAssetObservation>.Success(Observation()), out ObservationProxy calls);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => new ArticleVaultCommittedUploadObserver(files).ObserveAsync(
            s_access, Dependency(), cancellation.Token));
        Assert.Equal(0, calls.Count);
    }

    private static UploadAssetObservation Observation()
        => new("fsusblog.upload-asset-observation.v1", s_access.UploadId,
            new(s_id, "public", AssetStorageKey.Parse("illustration/source.png"), "image/png", ".png",
                24, Digest, 1, 1, 7, ContentAssetState.Active, DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch),
            "/uploads/illustration/source.png", [], Digest, Digest);

    private static VaultAssetDependency Dependency()
        => new(new("site-primary", "vault-primary", "article:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
            new(ArticleEmbedPermissionStatus.Allowed, VaultDependencyRights.Read | VaultDependencyRights.Upload,
                VaultDependencyRights.Read | VaultDependencyRights.Upload, Digest, Digest, Digest),
            s_id.Value, Digest, "image/png", ".png", 24, 1, 1, 7, 4);

    private static IFileService Service(Result<UploadAssetObservation> result, out ObservationProxy calls)
    {
        IFileService files = DispatchProxy.Create<IFileService, ObservationProxy>();
        calls = (ObservationProxy)files;
        calls.Result = result;
        return files;
    }

    public class ObservationProxy : DispatchProxy
    {
        internal Result<UploadAssetObservation> Result
        {
            get; set;
        }
        internal int Count
        {
            get; private set;
        }
        internal UploadSessionAccess Access
        {
            get; private set;
        }
        internal string? Digest
        {
            get; private set;
        }

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            Assert.Equal(nameof(IFileService.ObserveCommittedUploadAsync), targetMethod!.Name);
            Count++;
            Access = (UploadSessionAccess)args![0]!;
            Digest = (string)args[1]!;
            return Task.FromResult(Result);
        }
    }
}
