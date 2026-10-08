using FsusBlog.Shared.Contracts.AuthorTypography;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorTypographyRequestReplayPolicyTests
{
    private static readonly AuthorTypographyScope s_scope = new(42, "site:primary");
    private static readonly AuthorTypographyProfile s_profile = new(1, "system-sans", "standard", "standard", "standard", "standard");
    private static readonly Guid s_requestId = Guid.Parse("cc74dc20-0acb-45a7-a59c-af3fcd319f6a");

    [Fact]
    public void MatchingRetry_ReplaysOriginalObservationBeforeCurrentRevisionCas()
    {
        AuthorTypographyMutationRequest request = Request();
        AuthorTypographyRecordedRequest record = Record(request);
        AuthorTypographyRequestReplayDecision result = AuthorTypographyRequestReplayPolicy.Evaluate(s_scope, request, record);
        Assert.Equal(AuthorTypographyRequestReplayStatus.Replayable, result.Status);
        Assert.Same(record.CommittedSnapshot, result.OriginalSnapshot);
        Assert.Equal(9, result.OriginalSnapshot!.Revision);
        Assert.Equal(AuthorTypographyCommandStatus.RevisionConflict,
            AuthorTypographyCommandPolicy.Prepare(s_scope, Snapshot(12, s_profile), request.Command, null).Status);
    }

    [Fact]
    public void MissingRecord_IsNotAReplayOrAnAcceptedMutation()
    {
        AssertRefusal(AuthorTypographyRequestReplayStatus.NotRecorded, Request(), null);
    }

    [Fact]
    public void ReusedRequestIdWithDifferentValidPayloadOrAction_Refuses()
    {
        AuthorTypographyMutationRequest original = Request();
        AuthorTypographyRecordedRequest record = Record(original);
        AuthorTypographyMutationRequest[] conflicts =
        [
            original with { Command = original.Command with { ExpectedRevision = 9 } },
            original with { Command = original.Command with { Profile = s_profile with { FontSize = "large" } } },
            original with { Command = new(8, AuthorTypographyMutation.Reset, null) }
        ];
        foreach (AuthorTypographyMutationRequest conflict in conflicts)
        {
            AssertRefusal(AuthorTypographyRequestReplayStatus.RequestIdentityConflict, conflict, record);
        }
    }

    [Fact]
    public void WrongLookupIdentity_RefusesRatherThanTreatingAnotherRequestAsMissing()
    {
        AssertRefusal(AuthorTypographyRequestReplayStatus.InvalidRecord,
            Request() with
            {
                RequestId = Guid.Parse("cc74dc20-0acb-45a7-a59c-af3fcd319f6b")
            }, Record(Request()));
    }

    [Fact]
    public void EmptyIdentityInvalidCommandAndInvalidScope_Refuse()
    {
        AssertRefusal(AuthorTypographyRequestReplayStatus.InvalidRequest, null, null);
        AssertRefusal(AuthorTypographyRequestReplayStatus.InvalidRequest, Request() with
        {
            RequestId = Guid.Empty
        }, null);
        AssertRefusal(AuthorTypographyRequestReplayStatus.InvalidRequest,
            Request() with
            {
                Command = new(8, AuthorTypographyMutation.Reset, s_profile)
            }, null);
        Assert.Equal(AuthorTypographyRequestReplayStatus.InvalidRequest,
            AuthorTypographyRequestReplayPolicy.Evaluate(null, Request(), null).Status);
    }

    [Fact]
    public void AnotherAccountOrSite_CannotReplayAValidRecordedRequest()
    {
        foreach (AuthorTypographyScope scope in new[] { s_scope with { AccountId = 43 }, s_scope with { SiteIdentity = "site:other" } })
        {
            AuthorTypographyRequestReplayDecision result = AuthorTypographyRequestReplayPolicy.Evaluate(scope, Request(), Record(Request()));
            Assert.Equal(AuthorTypographyRequestReplayStatus.InvalidRecord, result.Status);
            Assert.Null(result.OriginalSnapshot);
        }
    }

    [Fact]
    public void StoredCommandSnapshotOrRecordDigestTamper_Refuses()
    {
        AuthorTypographyMutationRequest request = Request();
        AuthorTypographyRecordedRequest original = Record(request);
        AuthorTypographyRecordedRequest[] corrupt =
        [
            original with { ContentDigest = string.Empty },
            original with { Request = request with { RequestId = Guid.Empty } },
            original with { Request = request with { Command = request.Command with { ExpectedRevision = 7 } } },
            original with { CommittedSnapshot = original.CommittedSnapshot with { ContentDigest = string.Empty } },
            original with { CommittedSnapshot = Snapshot(10, s_profile) },
            original with { CommittedSnapshot = Snapshot(9, s_profile with { CanvasWidth = "wide" }) }
        ];
        foreach (AuthorTypographyRecordedRequest record in corrupt)
        {
            AssertRefusal(AuthorTypographyRequestReplayStatus.InvalidRecord, request, record);
        }
    }

    [Fact]
    public void ResetRecord_BindsServerResultWithoutAddingAClientDefault()
    {
        var request = new AuthorTypographyMutationRequest(s_requestId, new(8, AuthorTypographyMutation.Reset, null));
        AuthorTypographyRecordedRequest record = Record(request);
        Assert.Equal(AuthorTypographyRequestReplayStatus.Replayable,
            AuthorTypographyRequestReplayPolicy.Evaluate(s_scope, request, record).Status);
        Assert.Null(record.Request.Command.Profile);
    }

    [Fact]
    public void ContentAddress_BindsRequestIdScopeRevisionActionAndEachDimension()
    {
        AuthorTypographyMutationRequest request = Request();
        string digest = AuthorTypographyContractValidator.ComputeRequestDigest(s_scope, request);
        Assert.Equal(64, digest.Length);
        Assert.NotEqual(digest, AuthorTypographyContractValidator.ComputeRequestDigest(s_scope with
        {
            SiteIdentity = "site:other"
        }, request));
        Assert.NotEqual(digest, AuthorTypographyContractValidator.ComputeRequestDigest(s_scope with
        {
            AccountId = 43
        }, request));
        AuthorTypographyProfile[] profiles =
        [
            s_profile with { FontFamily = "cjk-sans" },
            s_profile with { FontSize = "large" },
            s_profile with { LineHeight = "relaxed" },
            s_profile with { CanvasWidth = "wide" },
            s_profile with { ParagraphSpacing = "relaxed" }
        ];
        foreach (AuthorTypographyProfile profile in profiles)
        {
            Assert.NotEqual(digest, AuthorTypographyContractValidator.ComputeRequestDigest(s_scope,
                request with
                {
                    Command = request.Command with
                    {
                        Profile = profile
                    }
                }));
        }
        Assert.NotEqual(digest, AuthorTypographyContractValidator.ComputeRequestDigest(s_scope,
            request with
            {
                RequestId = Guid.Parse("cc74dc20-0acb-45a7-a59c-af3fcd319f6b")
            }));
        Assert.NotEqual(digest, AuthorTypographyContractValidator.ComputeRequestDigest(s_scope,
            request with
            {
                Command = request.Command with
                {
                    ExpectedRevision = 9
                }
            }));
        Assert.NotEqual(digest, AuthorTypographyContractValidator.ComputeRequestDigest(s_scope,
            request with
            {
                Command = new(8, AuthorTypographyMutation.Reset, null)
            }));
    }

    [Fact]
    public void MalformedOrOverflowingRecords_CannotBeSealed()
    {
        AuthorTypographyRecordedRequest recordedRequest = Record(Request());
        Assert.Throws<ArgumentException>(() => AuthorTypographyContractValidator.ComputeRequestDigest(s_scope,
            Request() with
            {
                RequestId = Guid.Empty
            }));
        Assert.Throws<ArgumentException>(() => AuthorTypographyContractValidator.ComputeRecordedRequestDigest(
            recordedRequest with
            {
                Request = new(s_requestId, new(long.MaxValue, AuthorTypographyMutation.SetProfile, s_profile))
            }, s_scope));
        Assert.Throws<ArgumentException>(() => AuthorTypographyContractValidator.ComputeRecordedRequestDigest(
            recordedRequest with
            {
                CommittedSnapshot = Snapshot(9, s_profile with
                {
                    FontSize = "large"
                })
            }, s_scope));
    }

    private static void AssertRefusal(AuthorTypographyRequestReplayStatus status, AuthorTypographyMutationRequest? request, AuthorTypographyRecordedRequest? record)
    {
        AuthorTypographyRequestReplayDecision result = AuthorTypographyRequestReplayPolicy.Evaluate(s_scope, request, record);
        Assert.Equal(status, result.Status);
        Assert.Null(result.OriginalSnapshot);
    }

    private static AuthorTypographyMutationRequest Request()
    {
        return new(s_requestId, new(8, AuthorTypographyMutation.SetProfile, s_profile));
    }

    // Synthetic records exercise domain verification; they are not database acceptance receipts.
    private static AuthorTypographyRecordedRequest Record(AuthorTypographyMutationRequest request)
    {
        var record = new AuthorTypographyRecordedRequest(request, Snapshot(9, s_profile), string.Empty);
        return record with
        {
            ContentDigest = AuthorTypographyContractValidator.ComputeRecordedRequestDigest(record, s_scope)
        };
    }

    private static AuthorTypographySnapshot Snapshot(long revision, AuthorTypographyProfile profile)
    {
        var snapshot = new AuthorTypographySnapshot(s_scope, revision, profile, string.Empty);
        return snapshot with
        {
            ContentDigest = AuthorTypographyContractValidator.ComputeSnapshotDigest(snapshot)
        };
    }
}
