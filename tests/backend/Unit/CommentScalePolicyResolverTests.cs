using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Synthetic unit-only envelopes and evidence references test policy composition.
/// They authenticate no actor or proof and produce no canonical artifact or receipt.
/// </summary>
public sealed class CommentScalePolicyResolverTests
{
    private const string SyntheticDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DifferentSyntheticDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static readonly DateTime s_createdAtUtc = new(2024, 3, 1, 0, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void Resolve_PublicWithoutExplicitOptInStopsAllDownstreamDecisions()
    {
        CommentScalePolicyResolution result = Resolve(Request(), Facts() with
        {
            PublicSendExplicitlySelected = false
        });

        Assert.False(result.AuthorMode.Allowed);
        Assert.Equal("public_opt_in_required", result.AuthorMode.Status);
        Assert.Null(result.ArticleWrite);
        Assert.Null(result.BaseInitialModerationDecision);
        Assert.Null(result.CandidateReplyRecipientId);
    }

    [Theory]
    [InlineData("unknown", "author_mode_invalid")]
    [InlineData("anonymous", "anonymous_author_mode_retired")]
    [InlineData("legacy_server_visible_pseudonymous", "anonymous_author_mode_retired")]
    public void Resolve_UnsupportedAuthorModesKeepProductionRefusal(string mode, string expectedCode)
    {
        CommentScalePolicyResolution result = Resolve(Request() with
        {
            ActorMode = mode,
            CredentialValidity = CommentScaleCredentialValidity.ScaleSyntheticTestOnly
        }, Facts());

        Assert.False(result.AuthorMode.Allowed);
        Assert.Equal(expectedCode, result.AuthorMode.Status);
        Assert.Null(result.ArticleWrite);
        Assert.Null(result.BaseInitialModerationDecision);
        Assert.Null(result.CandidateReplyRecipientId);
    }

    [Fact]
    public void Resolve_AllowedModeRejectsAMismatchedResolvedActor()
    {
        CommentScalePolicyFacts facts = Facts();

        Assert.Throws<InvalidOperationException>(() => Resolve(Request(), facts with
        {
            Actor = facts.Actor with
            {
                AuthorMode = CommentAuthorModes.ZkAnonymous
            }
        }));
    }

    [Fact]
    public void Resolve_RegionRefusalStopsBaseModerationAndReplyRecipient()
    {
        (CommentScaleCommentRequest request, CommentScalePolicyFacts facts) = Reply();
        CommentScalePolicyResolution result = Resolve(request, facts with
        {
            Region = Region(canPublish: false, hidden: true),
            ModelEnabled = true,
            ModelProviderAvailable = true
        });

        Assert.True(result.AuthorMode.Allowed);
        Assert.True(result.ArticleWrite!.Allowed);
        Assert.False(result.RegionCanPublish);
        Assert.Null(result.BaseInitialModerationDecision);
        Assert.Null(result.CandidateReplyRecipientId);
    }

    [Theory]
    [InlineData("before", true)]
    [InlineData("created", false)]
    [InlineData("after", false)]
    public void Resolve_ArticleClosureUsesTheExactResolvedInstant(string role, bool expectedAllowed)
    {
        CommentScalePolicyFacts facts = Facts();
        facts.ArticlePolicy!.ClosedAtUtc = s_createdAtUtc;

        CommentScalePolicyResolution result = Resolve(Request() with
        {
            CreatedAtRole = role
        }, facts);

        Assert.Equal(Temporal().RequireInstant(role).UtcDateTime, result.CreatedAtUtc);
        Assert.Equal(DateTimeKind.Utc, result.CreatedAtUtc.Kind);
        Assert.Equal(expectedAllowed, result.ArticleWrite!.Allowed);
        Assert.Equal(expectedAllowed ? "allowed" : "comment_policy_closed", result.ArticleWrite.Status);
        Assert.Equal(expectedAllowed, result.BaseInitialModerationDecision.HasValue);
    }

    [Theory]
    [InlineData("actor-request")]
    [InlineData("actor-facts")]
    [InlineData("region-request")]
    [InlineData("region-facts")]
    [InlineData("temporal")]
    [InlineData("schema")]
    public void Resolve_RejectsFactAndTemporalIngressMismatch(string mutation)
    {
        CommentScaleCommentRequest request = Request();
        CommentScalePolicyFacts facts = Facts();
        CommentScaleArtifactReference artifact = TemporalReference();
        switch (mutation)
        {
            case "actor-request":
                request = request with
                {
                    ActorEvidenceDigest = DifferentSyntheticDigest
                };
                break;
            case "actor-facts":
                facts = facts with
                {
                    ActorEvidenceDigest = DifferentSyntheticDigest
                };
                break;
            case "region-request":
                request = request with
                {
                    RegionEvidenceDigest = DifferentSyntheticDigest
                };
                break;
            case "region-facts":
                facts = facts with
                {
                    RegionEvidenceDigest = DifferentSyntheticDigest
                };
                break;
            case "temporal":
                artifact = artifact with
                {
                    ContentDigest = DifferentSyntheticDigest
                };
                break;
            case "schema":
                artifact = artifact with
                {
                    Schema = "unowned.v2"
                };
                break;
            default:
                throw new InvalidOperationException(mutation);
        }

        Assert.Throws<InvalidOperationException>(
            () => CommentScalePolicyResolver.Resolve(request, facts, artifact, Temporal()));
    }

    [Fact]
    public void Resolve_DoesNotInventAMissingTemporalRole()
    {
        Assert.Throws<InvalidOperationException>(() => Resolve(Request() with
        {
            CreatedAtRole = "not-resolved"
        }, Facts()));
    }

    [Theory]
    [InlineData("empty-mode")]
    [InlineData("null-mode")]
    [InlineData("unknown-credential")]
    [InlineData("public-synthetic-credential")]
    [InlineData("anonymous-public-credential")]
    [InlineData("half-parent")]
    [InlineData("half-reply")]
    [InlineData("invalid-role")]
    [InlineData("invalid-time-role")]
    [InlineData("invalid-evidence-digest")]
    public void Resolve_RejectsMalformedRequestsBeforePolicyDecisions(string mutation)
    {
        CommentScaleCommentRequest request = Request();
        CommentScalePolicyFacts facts = Facts();
        switch (mutation)
        {
            case "empty-mode":
                request = request with
                {
                    ActorMode = ""
                };
                break;
            case "null-mode":
                request = request with
                {
                    ActorMode = null!
                };
                break;
            case "unknown-credential":
                request = request with
                {
                    CredentialValidity = (CommentScaleCredentialValidity)999
                };
                break;
            case "public-synthetic-credential":
                request = request with
                {
                    CredentialValidity = CommentScaleCredentialValidity.ScaleSyntheticTestOnly
                };
                break;
            case "anonymous-public-credential":
                request = request with
                {
                    ActorMode = CommentAuthorModes.ZkAnonymous
                };
                break;
            case "half-parent":
                request = request with
                {
                    ParentRole = "parent"
                };
                break;
            case "half-reply":
                request = request with
                {
                    ReplyTargetRole = "parent"
                };
                break;
            case "invalid-role":
                request = request with
                {
                    Role = "invalid role"
                };
                break;
            case "invalid-time-role":
                request = request with
                {
                    CreatedAtRole = "invalid role"
                };
                break;
            case "invalid-evidence-digest":
                request = request with
                {
                    ActorEvidenceDigest = "matching-but-not-a-digest"
                };
                facts = facts with
                {
                    ActorEvidenceDigest = request.ActorEvidenceDigest
                };
                break;
            default:
                throw new InvalidOperationException(mutation);
        }

        Assert.Throws<InvalidOperationException>(() => Resolve(request, facts));
    }

    [Theory]
    [InlineData("article-id")]
    [InlineData("article-snapshot")]
    [InlineData("root-id")]
    [InlineData("thread-article")]
    [InlineData("thread-root")]
    [InlineData("parent-without-root")]
    [InlineData("root-without-parent")]
    public void Resolve_RejectsCrossBoundArticleThreadAndParentInputs(string mutation)
    {
        (CommentScaleCommentRequest request, CommentScalePolicyFacts facts) = Reply();
        switch (mutation)
        {
            case "article-id":
                facts = facts with
                {
                    ArticleId = 0
                };
                break;
            case "article-snapshot":
                facts.ArticlePolicy!.ArticleId = 99;
                break;
            case "root-id":
                facts = facts with
                {
                    RootCommentId = 0
                };
                break;
            case "thread-article":
                facts.ThreadPolicy!.ArticleId = 99;
                break;
            case "thread-root":
                facts.ThreadPolicy!.RootCommentId = 901;
                break;
            case "parent-without-root":
                facts = facts with
                {
                    RootCommentId = null,
                    ThreadPolicy = null
                };
                break;
            case "root-without-parent":
                request = request with
                {
                    ParentRole = null
                };
                break;
            default:
                throw new InvalidOperationException(mutation);
        }

        Assert.Throws<InvalidOperationException>(() => Resolve(request, facts));
    }

    [Fact]
    public void Resolve_RootRequestRejectsAnInventedReplyRecipient()
    {
        Assert.Throws<InvalidOperationException>(() => Resolve(Request(), Facts() with
        {
            ReplyTargetAuthorAccountId = 8
        }));
    }

    [Theory]
    [InlineData(true, true, true, true, true, CommentModerationStatus.Hidden, "hidden_region_review")]
    [InlineData(false, true, true, true, true, CommentModerationStatus.Pending, "pending_region_review")]
    [InlineData(false, false, true, true, true, CommentModerationStatus.Pending, "pending_anonymous_policy")]
    [InlineData(false, false, false, true, false, CommentModerationStatus.Pending, "pending_model_provider_unavailable")]
    [InlineData(false, false, false, true, true, CommentModerationStatus.Pending, "pending_model_review")]
    [InlineData(false, false, false, false, false, CommentModerationStatus.Approved, "approved_deterministic_low_risk")]
    [InlineData(false, false, false, false, true, CommentModerationStatus.Approved, "approved_deterministic_low_risk")]
    public void Resolve_BaseModerationPreservesProductionPriority(
        bool hidden,
        bool manualReview,
        bool actorReview,
        bool modelEnabled,
        bool providerAvailable,
        CommentModerationStatus expectedStatus,
        string expectedReason)
    {
        CommentScalePolicyFacts facts = Facts();
        CommentScalePolicyResolution result = Resolve(Request(), facts with
        {
            Actor = facts.Actor with
            {
                RequiresModeration = actorReview
            },
            Region = Region(hidden: hidden, manualReview: manualReview),
            ModelEnabled = modelEnabled,
            ModelProviderAvailable = providerAvailable
        });

        Assert.Equal(expectedStatus, result.BaseInitialModerationDecision!.Value.Status);
        Assert.Equal(expectedReason, result.BaseInitialModerationDecision.Value.ReasonCode);
    }

    [Fact]
    public void Resolve_PremoderationRemainsAPolicyRequirementRatherThanFinalStatus()
    {
        CommentScalePolicyFacts facts = Facts();
        facts.ArticlePolicy!.ModerationMode = ArticleCommentModerationModes.Premoderated;

        CommentScalePolicyResolution result = Resolve(Request(), facts);

        Assert.True(result.ArticleWrite!.Allowed);
        Assert.Equal(ArticleCommentModerationModes.Premoderated, result.ArticleWrite.Policy.ModerationMode);
        Assert.Equal(CommentModerationStatus.Approved, result.BaseInitialModerationDecision!.Value.Status);
        Assert.Equal("approved_deterministic_low_risk", result.BaseInitialModerationDecision.Value.ReasonCode);
    }

    [Fact]
    public void Resolve_SlowModeRetainsTheRequirementWithoutReservingOrReturningAToken()
    {
        CommentScalePolicyFacts facts = Facts();
        facts.ArticlePolicy!.SlowModeSeconds = 120;

        CommentScalePolicyResolution first = Resolve(Request(), facts);
        CommentScalePolicyResolution second = Resolve(Request(), facts);

        Assert.Equal(120, first.ArticleWrite!.Policy.SlowModeSeconds);
        Assert.Equal(first, second);
        Assert.Equal(120, facts.ArticlePolicy.SlowModeSeconds);
        Assert.DoesNotContain(typeof(CommentScalePolicyResolution).GetProperties(), property =>
            property.PropertyType == typeof(CommentSlowModeState));
    }

    [Theory]
    [InlineData("article-disabled", "comment_policy_closed")]
    [InlineData("article-public-disabled", "public_comments_disabled")]
    [InlineData("thread-locked", "comment_thread_locked")]
    public void Resolve_ArticleWriteRefusalStopsModerationAndRecipient(string mutation, string expectedCode)
    {
        (CommentScaleCommentRequest request, CommentScalePolicyFacts facts) = Reply();
        switch (mutation)
        {
            case "article-disabled":
                facts.ArticlePolicy!.Enabled = false;
                break;
            case "article-public-disabled":
                facts.ArticlePolicy!.PublicCommentsEnabled = false;
                break;
            case "thread-locked":
                facts.ThreadPolicy!.LockedAtUtc = s_createdAtUtc;
                break;
            default:
                throw new InvalidOperationException(mutation);
        }

        CommentScalePolicyResolution result = Resolve(request, facts);

        Assert.True(result.AuthorMode.Allowed);
        Assert.False(result.ArticleWrite!.Allowed);
        Assert.Equal(expectedCode, result.ArticleWrite.Status);
        Assert.Null(result.BaseInitialModerationDecision);
        Assert.Null(result.CandidateReplyRecipientId);
    }

    [Theory]
    [InlineData(7, null)]
    [InlineData(8, 8)]
    [InlineData(0, null)]
    [InlineData(-1, null)]
    [InlineData(null, null)]
    public void Resolve_ReplyRecipientUsesObservedTargetAndSuppressesSelfAndInvalidAccounts(int? target, int? expected)
    {
        (CommentScaleCommentRequest request, CommentScalePolicyFacts facts) = Reply();

        CommentScalePolicyResolution result = Resolve(request, facts with
        {
            ReplyTargetAuthorAccountId = target
        });

        Assert.True(result.ArticleWrite!.Allowed);
        Assert.Equal(expected, result.CandidateReplyRecipientId);
    }

    [Theory]
    [InlineData(CommentScaleCredentialValidity.VerifiedTestCredential)]
    [InlineData(CommentScaleCredentialValidity.ScaleSyntheticTestOnly)]
    public void Resolve_PreservesAnonymousCredentialClassWithoutPromotingProofValidity(CommentScaleCredentialValidity validity)
    {
        CommentScalePolicyFacts facts = Facts();
        CommentScaleCommentRequest request = Request() with
        {
            ActorMode = CommentAuthorModes.ZkAnonymous,
            CredentialValidity = validity
        };
        facts = facts with
        {
            Actor = facts.Actor with
            {
                UserId = null,
                AuthorMode = CommentAuthorModes.ZkAnonymous,
                PublicHandle = null
            }
        };

        CommentScalePolicyResolution result = Resolve(request, facts);

        Assert.True(result.AuthorMode.Allowed);
        Assert.Equal(validity, result.CredentialValidity);
        Assert.Equal(s_createdAtUtc, result.CreatedAtUtc);
    }

    private static CommentScalePolicyResolution Resolve(
        CommentScaleCommentRequest request,
        CommentScalePolicyFacts facts)
        => CommentScalePolicyResolver.Resolve(request, facts, TemporalReference(), Temporal());

    private static CommentScaleArtifactReference TemporalReference()
        => new("fsusblog.resolved-temporal-roles.v1", SyntheticDigest);

    private static CommentScaleCommentRequest Request()
        => new(
            "root", null, null, CommentAuthorModes.Public,
            CommentScaleCredentialValidity.PublicAuthenticated, SyntheticDigest,
            "content.root", new("fsusblog.generated-content-shape.v1", SyntheticDigest),
            SyntheticDigest, "created",
            [new(null, CommentModerationStatus.Approved, "initial", "created")]);

    private static CommentScalePolicyFacts Facts()
    {
        var site = new AnonymousCommentPolicySnapshot(true, true, true, CommentAuthorModes.ZkAnonymous, ["en"])
        {
            UpdatedAtUtc = s_createdAtUtc,
            SnapshotHash = SyntheticDigest
        };
        var article = new ArticleCommentPolicy
        {
            ArticleId = 42,
            UpdatedAtUtc = s_createdAtUtc,
            PolicyVersion = 2,
            ModerationMode = ArticleCommentModerationModes.RiskBased
        };
        var actor = new CommentActor(7, CommentAuthorModes.Public, "unit-handle", null,
            "unit-handle", "en", null, null, "unit-subject", "common", false);
        return new CommentScalePolicyFacts(42, null, site, article, null, actor,
            SyntheticDigest, Region(), SyntheticDigest, true, false, false, null);
    }

    private static (CommentScaleCommentRequest Request, CommentScalePolicyFacts Facts) Reply()
    {
        CommentScaleCommentRequest request = Request() with
        {
            Role = "reply",
            ParentRole = "parent",
            ReplyTargetRole = "parent"
        };
        CommentScalePolicyFacts facts = Facts() with
        {
            RootCommentId = 900,
            ThreadPolicy = new CommentThreadPolicy
            {
                ArticleId = 42,
                RootCommentId = 900,
                PolicyVersion = 3
            },
            ReplyTargetAuthorAccountId = 8
        };
        return (request, facts);
    }

    private static RegionModerationDecision Region(
        bool canPublish = true,
        bool hidden = false,
        bool manualReview = false)
        => new(canPublish, "GLOBAL", 1d, "synthetic-unit-only", null, [], [], [],
            "synthetic-unit-policy", "unit-reason", "unit-reason", manualReview, hidden);

    private static ResolvedTemporalRoleContext Temporal()
    {
        // This in-memory envelope exercises adapter consumption only; no producer
        // is run and the reference digest is not a canonical verification receipt.
        string json = JsonSerializer.Serialize(new
        {
            schema = "fsusblog.resolved-temporal-roles.v1",
            contextIdentity = new
            {
                producerId = "synthetic-unit-only",
                schedulerRunId = "synthetic-unit-only"
            },
            contentDigest = SyntheticDigest,
            roles = new[]
            {
                (Role: "before", Instant: "2024-02-29T23:59:59.999Z"),
                (Role: "created", Instant: "2024-03-01T00:00:00.000Z"),
                (Role: "after", Instant: "2024-03-01T00:00:00.001Z")
            }.Select(role => new
            {
                roleId = role.Role,
                clockKind = "business-wall",
                semanticEffect = "included",
                precision = "millisecond",
                instantUtc = role.Instant
            })
        });
        return ResolvedTemporalRoleContext.Parse(json, SyntheticDigest);
    }
}
