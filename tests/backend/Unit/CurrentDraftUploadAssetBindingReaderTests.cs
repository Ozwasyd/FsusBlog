using System.Security.Claims;
using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CurrentDraftUploadAssetBindingReaderTests
{
    [Theory]
    [InlineData(null, "\uFEFF# draft\r\n正文😀  \r\n \t")]
    [InlineData(42, "source\n")]
    [InlineData(null, "")]
    public async Task SavedDraft_ReadsOriginalOwnerAndExactLedgerWithoutWrites(int? articleId, string source)
    {
        var fixture = new Fixture(articleId, source);
        CurrentDraftUploadAssetReadResult first = await fixture.ReadAsync();
        CurrentDraftUploadAssetReadResult second = await fixture.ReadAsync();

        Assert.Equal(CurrentDraftUploadAssetReadStatus.Available, first.Status);
        Assert.Null(first.ReasonCode);
        CurrentDraftUploadAssetObservation observed = Assert.IsType<CurrentDraftUploadAssetObservation>(first.Observation);
        Assert.Equal(fixture.Reference, observed.Reference);
        Assert.Equal(fixture.Draft!.Content, observed.SavedDraft.Content);
        Assert.Equal(7, observed.OwnerAdminPrincipalId);
        Assert.Equal(ArticleVaultManifestCodec.CaptureSourceBytes(Encoding.UTF8.GetBytes(source)), observed.Source);
        Assert.NotEqual(fixture.Context.ContentDigest, observed.Source.Sha256);
        Assert.Equal(fixture.Upload.Asset, observed.Upload.Asset);
        Assert.Equal(fixture.Upload.AssetVersionSha256, observed.Upload.AssetVersionSha256);
        Assert.Equal(fixture.Upload.ReferenceLedgerSha256, observed.Upload.ReferenceLedgerSha256);
        Assert.Equal("7:real-draft-key", observed.DraftReference.SourceKey);
        Assert.Equal(ContentAssetSourceKinds.Draft, observed.DraftReference.SourceKind);
        Assert.Equal(articleId, observed.DraftReference.ArticleId);
        Assert.Equal(observed.Upload.Asset, second.Observation!.Upload.Asset);
        Assert.Equal(observed.Upload.ReferenceLedgerSha256, second.Observation.Upload.ReferenceLedgerSha256);
        Assert.Equal(observed.Upload.References.ToArray(), second.Observation.Upload.References.ToArray());
        await fixture.Drafts.Received(4).GetDraftAsync(7, "real-draft-key", Arg.Any<CancellationToken>());
        await fixture.Files.Received(4).ObserveCommittedUploadAsync(fixture.Session, fixture.Sha256, Arg.Any<CancellationToken>());
        Assert.Equal(4, fixture.Drafts.ReceivedCalls().Count());
        Assert.Equal(4, fixture.Files.ReceivedCalls().Count());
    }

    [Theory]
    [InlineData("never-saved")]
    [InlineData("missing-draft")]
    [InlineData("missing-edge")]
    [InlineData("upload-unavailable")]
    public async Task UnsavedOrUnavailable_ReturnsNoObservationAndNeverSaves(string scenario)
    {
        var fixture = new Fixture();
        if (scenario == "never-saved")
        {
            fixture.Context = fixture.Context with { DraftRevision = null };
            fixture.Reference = fixture.Reference with { ServerRevision = null, Context = fixture.Context };
        }
        else if (scenario == "missing-draft")
        {
            fixture.Draft = null;
        }
        else if (scenario == "missing-edge")
        {
            fixture.Upload = fixture.Upload with { References = [] };
        }
        else
        {
            fixture.UploadFailure = true;
        }
        CurrentDraftUploadAssetReadResult result = await fixture.ReadAsync();
        Assert.Equal(CurrentDraftUploadAssetReadStatus.Unavailable, result.Status);
        Assert.Null(result.Observation);
        Assert.Equal(scenario is "missing-edge" or "upload-unavailable"
            ? "upload_or_draft_reference_unavailable" : "saved_draft_reference_unavailable", result.ReasonCode);
        await fixture.Drafts.DidNotReceiveWithAnyArgs().SaveDraftAsync(default, default!, default);
        Assert.All(fixture.Drafts.ReceivedCalls(), call => Assert.Equal("GetDraftAsync", call.GetMethodInfo().Name));
        if (scenario is "never-saved" or "missing-draft")
        {
            Assert.Empty(fixture.Files.ReceivedCalls());
        }
    }

    [Fact]
    public async Task CasConflict_CurrentWinnerCannotConfirmLosingSavedRevision()
    {
        var fixture = new Fixture();
        var conflict = new ServerDraftConflictException(new(4, fixture.Draft!.UpdatedAt, "winner"));
        fixture.Draft = fixture.Draft with { ServerRevision = conflict.Conflict.CurrentServerRevision!.Value };

        CurrentDraftUploadAssetReadResult result = await fixture.ReadAsync();
        Assert.Equal(CurrentDraftUploadAssetReadStatus.Unconfirmed, result.Status);
        Assert.Equal("saved_draft_source_changed", result.ReasonCode);
        Assert.Null(result.Observation);
        Assert.Empty(fixture.Files.ReceivedCalls());
        await fixture.Drafts.DidNotReceiveWithAnyArgs().SaveDraftAsync(default, default!, default);
    }

    [Theory]
    [InlineData("context")]
    [InlineData("revision-coordinate")]
    [InlineData("owner")]
    [InlineData("draft-key")]
    public async Task InvalidOrStaleRequest_RefusesBeforeEitherAuthorityRead(string scenario)
    {
        var fixture = new Fixture();
        if (scenario == "context")
        {
            fixture.Context = fixture.Context with { RequestId = Guid.NewGuid().ToString("N") };
        }
        else if (scenario == "revision-coordinate")
        {
            fixture.Reference = fixture.Reference with { ServerRevision = fixture.Context.SourceRevision };
        }
        else if (scenario == "owner")
        {
            ((ClaimsIdentity)fixture.Principal.Identity!).RemoveClaim(fixture.Principal.FindFirst("admin_id")!);
        }
        else
        {
            fixture.Reference = fixture.Reference with { DraftKey = " real-draft-key " };
        }
        CurrentDraftUploadAssetReadResult result = await fixture.ReadAsync();
        Assert.Equal(scenario is "owner" or "draft-key" ? CurrentDraftUploadAssetReadStatus.Unavailable
            : CurrentDraftUploadAssetReadStatus.Unconfirmed, result.Status);
        Assert.Equal(scenario switch
        {
            "context" => "current_context_changed",
            "revision-coordinate" => "saved_draft_revision_changed",
            _ => "input_or_owner_invalid"
        }, result.ReasonCode);
        Assert.Null(result.Observation);
        Assert.Empty(fixture.Drafts.ReceivedCalls());
        Assert.Empty(fixture.Files.ReceivedCalls());
    }

    [Theory]
    [InlineData("source")]
    [InlineData("server-revision")]
    [InlineData("article")]
    [InlineData("draft-key")]
    [InlineData("json-is-not-source-sha")]
    public async Task SavedSourceMismatch_IsUnconfirmedBeforeUpload(string scenario)
    {
        var fixture = new Fixture();
        fixture.Draft = scenario switch
        {
            "source" => fixture.Draft! with { Content = "edited source" },
            "server-revision" => fixture.Draft! with { ServerRevision = 4 },
            "article" => fixture.Draft! with { ArticleId = 99 },
            "draft-key" => fixture.Draft! with { DraftKey = fixture.Context.DraftId },
            _ => fixture.Draft
        };
        if (scenario == "json-is-not-source-sha")
        {
            fixture.Context = fixture.Context with { SourceSha256 = fixture.Context.ContentDigest };
            fixture.Reference = fixture.Reference with { Context = fixture.Context };
        }
        CurrentDraftUploadAssetReadResult result = await fixture.ReadAsync();
        Assert.Equal(CurrentDraftUploadAssetReadStatus.Unconfirmed, result.Status);
        Assert.Equal("saved_draft_source_changed", result.ReasonCode);
        Assert.Null(result.Observation);
        Assert.Empty(fixture.Files.ReceivedCalls());
    }

    [Theory]
    [InlineData("revision-edge")]
    [InlineData("opaque-draft-id")]
    [InlineData("foreign-owner-key")]
    [InlineData("foreign-article")]
    [InlineData("foreign-asset")]
    [InlineData("zero-count")]
    [InlineData("duplicate-edge")]
    [InlineData("asset-owner")]
    [InlineData("asset-state")]
    [InlineData("upload-session")]
    public async Task WrongLedgerEdgeOrUpload_CannotConfirmSavedDraft(string scenario)
    {
        var fixture = new Fixture();
        AssetReference edge = fixture.Upload.References[0];
        edge = scenario switch
        {
            "revision-edge" => edge with { SourceKind = ContentAssetSourceKinds.Revision, SourceKey = "3" },
            "opaque-draft-id" => edge with { SourceKey = "7:" + fixture.Context.DraftId },
            "foreign-owner-key" => edge with { SourceKey = "8:real-draft-key" },
            "foreign-article" => edge with { ArticleId = 99 },
            "foreign-asset" => edge with { AssetId = AssetId.FromGuid(Guid.NewGuid()) },
            "zero-count" => edge with { ReferenceCount = 0 },
            _ => edge
        };
        fixture.Upload = fixture.Upload with { References = scenario == "duplicate-edge" ? [edge, edge] : [edge] };
        if (scenario == "asset-owner")
        {
            fixture.Upload = fixture.Upload with { Asset = fixture.Upload.Asset with { OwnerAdminPrincipalId = 8 } };
        }
        if (scenario == "asset-state")
        {
            fixture.Upload = fixture.Upload with { Asset = fixture.Upload.Asset with { State = ContentAssetState.PendingDelete } };
        }
        if (scenario == "upload-session")
        {
            fixture.Upload = fixture.Upload with { UploadId = Guid.NewGuid().ToString("N") };
        }
        CurrentDraftUploadAssetReadResult result = await fixture.ReadAsync();
        Assert.Equal(CurrentDraftUploadAssetReadStatus.Unavailable, result.Status);
        Assert.Equal("upload_or_draft_reference_unavailable", result.ReasonCode);
        Assert.Null(result.Observation);
    }

    [Theory]
    [InlineData("request")]
    [InlineData("document")]
    [InlineData("epoch")]
    [InlineData("editor-revision")]
    [InlineData("saved-revision")]
    [InlineData("content-digest")]
    [InlineData("context-digest")]
    [InlineData("source-sha")]
    [InlineData("principal")]
    public async Task ContextChangesDuringRead_WithdrawFactsEvenWithSameSource(string scenario)
    {
        var fixture = new Fixture();
        fixture.BeforeUpload = _ =>
        {
            fixture.Context = scenario switch
            {
                "request" => fixture.Context with { RequestId = Guid.NewGuid().ToString("N") },
                "document" => fixture.Context with { DocumentId = "different-document" },
                "epoch" => fixture.Context with { DocumentEpoch = 2 },
                "editor-revision" => fixture.Context with { SourceRevision = 24 },
                "saved-revision" => fixture.Context with { DraftRevision = "server:4" },
                "content-digest" => fixture.Context with { ContentDigest = new('b', 64) },
                "context-digest" => fixture.Context with { ContextDigest = new('b', 64) },
                "source-sha" => fixture.Context with { SourceSha256 = new('c', 64) },
                _ => fixture.Context
            };
            if (scenario == "principal")
            {
                ((ClaimsIdentity)fixture.Principal.Identity!).RemoveClaim(fixture.Principal.FindFirst("admin_id")!);
            }
        };
        CurrentDraftUploadAssetReadResult result = await fixture.ReadAsync();
        Assert.Equal(CurrentDraftUploadAssetReadStatus.Unconfirmed, result.Status);
        Assert.Equal("current_context_changed", result.ReasonCode);
        Assert.Null(result.Observation);
    }

    [Theory]
    [InlineData("source")]
    [InlineData("server-revision")]
    [InlineData("title")]
    [InlineData("rights")]
    [InlineData("tags")]
    [InlineData("ledger-digest")]
    [InlineData("asset-version")]
    [InlineData("asset-record")]
    [InlineData("edge-count")]
    [InlineData("removed-edge")]
    public async Task Rereads_RejectChangedSavedContentAndReferenceFacts(string scenario)
    {
        var fixture = new Fixture();
        fixture.BeforeUpload = count =>
        {
            if (count != 2)
            {
                return;
            }
            fixture.Draft = scenario switch
            {
                "source" => fixture.Draft! with { Content = "changed" },
                "server-revision" => fixture.Draft! with { ServerRevision = 4 },
                "title" => fixture.Draft! with { Title = "changed title" },
                "rights" => fixture.Draft! with { Rights = fixture.Draft.Rights with { CopyrightHolder = "changed" } },
                "tags" => fixture.Draft! with { TagIds = [2] },
                _ => fixture.Draft
            };
            fixture.Upload = scenario switch
            {
                "ledger-digest" => fixture.Upload with { ReferenceLedgerSha256 = new('c', 64) },
                "asset-version" => fixture.Upload with { AssetVersionSha256 = new('d', 64) },
                "asset-record" => fixture.Upload with { Asset = fixture.Upload.Asset with { SizeBytes = 999 } },
                "edge-count" => fixture.Upload with { References = [fixture.Upload.References[0] with { ReferenceCount = 2 }] },
                "removed-edge" => fixture.Upload with { References = [] },
                _ => fixture.Upload
            };
        };
        CurrentDraftUploadAssetReadResult result = await fixture.ReadAsync();
        Assert.Equal(CurrentDraftUploadAssetReadStatus.Unconfirmed, result.Status);
        Assert.Equal(scenario == "removed-edge" ? "upload_or_draft_reference_changed" : "current_facts_changed", result.ReasonCode);
        Assert.Null(result.Observation);
    }

    [Theory]
    [InlineData("entry")]
    [InlineData("draft")]
    [InlineData("first-upload")]
    [InlineData("second-upload")]
    [InlineData("last-draft")]
    public async Task Cancellation_PropagatesAtEveryAsyncBoundary(string boundary)
    {
        var fixture = new Fixture();
        using var cancellation = new CancellationTokenSource();
        if (boundary == "entry")
        {
            cancellation.Cancel();
        }
        fixture.BeforeDraft = count =>
        {
            if ((boundary == "draft" && count == 1) || (boundary == "last-draft" && count == 2))
            {
                cancellation.Cancel();
            }
        };
        fixture.BeforeUpload = count =>
        {
            if ((boundary == "first-upload" && count == 1) || (boundary == "second-upload" && count == 2))
            {
                cancellation.Cancel();
            }
        };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.ReadAsync(cancellation.Token));
        await fixture.Drafts.DidNotReceiveWithAnyArgs().SaveDraftAsync(default, default!, default);
        if (boundary == "entry")
        {
            Assert.Empty(fixture.Drafts.ReceivedCalls());
            Assert.Empty(fixture.Files.ReceivedCalls());
        }
    }

    private sealed class Fixture
    {
        internal Fixture(int? articleId = 42, string source = "source\n")
        {
            DateTime updatedAt = new(2026, 10, 9, 0, 0, 0, DateTimeKind.Utc);
            Draft = new("real-draft-key", articleId, "draft", source, null, null, 1, [1],
                "client-write-8", 0, null, updatedAt, new ArticleRightsRequest(), null, 3);
            Context = new(Guid.NewGuid().ToString("N"), articleId, "document-1", "opaque-draft-id", 1, 23,
                "server:3", new('2', 64), new('a', 64),
                ArticleVaultManifestCodec.CaptureSourceBytes(Encoding.UTF8.GetBytes(source)).Sha256);
            Guid assetId = Guid.Parse("11111111-2222-3333-4444-555555555555");
            Session = new(assetId.ToString("N"), 7, "controlled-unit-session-token");
            var id = AssetId.FromGuid(assetId);
            Reference = new(Draft.DraftKey, articleId, Draft.ServerRevision, id, Context);
            var time = new DateTimeOffset(updatedAt);
            Upload = new("fsusblog.upload-asset-observation.v1", Session.UploadId,
                new(id, "public", AssetStorageKey.Parse($"illustration/{Session.UploadId}.png"), "image/png",
                    ".png", 67, Sha256, 1, 1, 7, ContentAssetState.Active, time, time),
                $"/assets/illustration/{Session.UploadId}.png",
                [new(id, ContentAssetSourceKinds.Draft, "7:real-draft-key", articleId, 1, "alt", time)],
                new('e', 64), new('f', 64));
            int draftCalls = 0;
            Drafts.GetDraftAsync(7, "real-draft-key", Arg.Any<CancellationToken>()).Returns(_ =>
            {
                BeforeDraft?.Invoke(++draftCalls);
                return Draft;
            });
            int uploadCalls = 0;
            Files.ObserveCommittedUploadAsync(Session, Sha256, Arg.Any<CancellationToken>()).Returns(_ =>
            {
                BeforeUpload?.Invoke(++uploadCalls);
                return UploadFailure ? Result<UploadAssetObservation>.Failure(ErrorCode.Conflict, "controlled-unavailable")
                    : Result<UploadAssetObservation>.Success(Upload);
            });
            Reader = new(Drafts, Files);
        }

        internal IAuthoringDraftLifecycle Drafts { get; } = Substitute.For<IAuthoringDraftLifecycle>();
        internal IFileService Files { get; } = Substitute.For<IFileService>();
        internal ClaimsPrincipal Principal
        {
            get;
        } = new(new ClaimsIdentity(
            [new("admin_id", "7"), new("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind)], "controlled-unit-identity"));
        internal UploadSessionAccess Session { get; }
        internal string Sha256 { get; } = new('1', 64);
        internal CurrentDraftUploadAssetBindingReader Reader { get; }
        internal CurrentDraftUploadAssetReference Reference { get; set; }
        internal CurrentDraftUploadAssetContext Context { get; set; }
        internal ServerDraftResponse? Draft { get; set; }
        internal UploadAssetObservation Upload { get; set; }
        internal bool UploadFailure { get; set; }
        internal Action<int>? BeforeDraft { get; set; }
        internal Action<int>? BeforeUpload { get; set; }

        internal Task<CurrentDraftUploadAssetReadResult> ReadAsync(CancellationToken cancellationToken = default)
            => Reader.ObserveSavedDraftAsync(Reference, Principal, Session, Sha256, () => Context, cancellationToken);
    }
}
