using System.Collections;
using System.Globalization;
using System.IO.Compression;
using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleRelations;

using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Controlled server observations exercise the original finite pipeline. These unit contexts
/// neither implement the production canonical site port nor grant persisted permission authority.
/// </summary>
[Trait("Category", "Unit")]
public sealed class ArticlePackageImportCandidateReviewProducerTests
{
    private static readonly DateTime s_created = new(2026, 10, 9, 1, 2, 3, DateTimeKind.Utc);
    private static readonly ArticleRelationActorContext s_context =
        new("admin_principal:73", "site:controlled-unit", new string('a', 64));

    [Theory]
    [InlineData(1, 0, 1)]
    [InlineData(1000, 19, 50)]
    public async Task ServerContext_ComposesOriginalZipPlanAndBoundedDisabledProjection(int count, int pageIndex, int pageSize)
    {
        byte[] zip = Archive(count);
        HttpContextAccessor accessor = Accessor();
        var producer = Producer(accessor);
        ArticlePackageImportCandidateRequest request = Request();
        int observations = 0;

        ArticlePackageImportCandidateReviewProduction output = await producer.ProduceAsync(zip, request, pageIndex, pageSize,
            _ =>
            {
                observations++;
                return ValueTask.FromResult<ArticleRelationActorContext?>(s_context);
            });

        Assert.True(output.Result.IsValid, output.Result.ReasonCode);
        ArticlePackageCandidateReview review = Assert.IsType<ArticlePackageCandidateReview>(output.Review);
        Assert.Equal(2, observations);
        Assert.Equal(count, review.Summary.ArticleCount);
        Assert.Equal(pageSize, review.Targets.Count);
        Assert.Equal(pageIndex, review.PageIndex);
        Assert.True(review.ExecuteDisabled);
        Assert.Equal("article_package_import_authority_unavailable", review.ExecutionReasonCode);
        Assert.True(ArticlePackageImportZipCandidateReader.TryReadCandidate(zip, out var candidate).IsValid);
        Assert.True(ArticlePackageImportCandidatePlanner.TryCreatePlan(candidate!.Candidate, request, out var plan).IsValid);
        Assert.Equal(plan!.PlanDigest, review.PlanDigest);
        Assert.Equal(plan.Candidate.PackageBytesDigest, review.Summary.PackageBytesDigest);
        Assert.Equal(plan.RequiredAuthorities, review.RequiredAuthorities);
    }

    [Theory]
    [InlineData("anonymous")]
    [InlineData("non-admin")]
    [InlineData("id-invalid")]
    [InlineData("session-missing")]
    [InlineData("permission-missing")]
    public async Task MissingAuthentication_RefusesBeforeObserverOrArchive(string change)
    {
        HttpContextAccessor accessor = Accessor();
        ClaimsIdentity identity = Assert.IsType<ClaimsIdentity>(accessor.HttpContext!.User.Identity);
        if (change == "anonymous")
        {
            accessor.HttpContext.User = new ClaimsPrincipal();
        }
        else
        {
            string claimType = change switch
            {
                "non-admin" => "identity_kind",
                "id-invalid" => "admin_id",
                "session-missing" => "admin_sid",
                _ => AdminPermissions.PermissionClaimType
            };
            identity.RemoveClaim(identity.FindFirst(claimType)!);
            if (change == "id-invalid")
            {
                identity.AddClaim(new("admin_id", "0"));
            }
        }
        int observations = 0;
        ArticlePackageImportCandidateReviewProduction output = await Producer(accessor).ProduceAsync(
            new byte[] { 0 }, Request(), 0, 1, _ =>
            {
                observations++;
                return ValueTask.FromResult<ArticleRelationActorContext?>(s_context);
            });
        Refused(output, "article_package_candidate_review_access_denied");
        Assert.Equal(0, observations);
    }

    [Theory]
    [InlineData("actor")]
    [InlineData("site")]
    [InlineData("permission-context")]
    public async Task RequestContext_CannotSelectDifferentServerBinding(string change)
    {
        ArticleRelationActorContext claimed = ChangedContext(change);
        ArticlePackageImportCandidateReviewProduction output = await Producer(Accessor()).ProduceAsync(
            new byte[] { 0 }, Request() with
            {
                Actor = claimed
            }, 0, 1, Observe);
        Refused(output, "article_package_candidate_review_context_mismatch");
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("url")]
    public async Task MissingOrUrlSite_ProducesNoDefaultIdentity(string change)
    {
        ArticleRelationActorContext? observed = change == "missing" ? null : s_context with
        {
            SiteIdentity = "https://fsus.blog"
        };
        ArticlePackageImportCandidateReviewProduction output = await Producer(Accessor()).ProduceAsync(
            new byte[] { 0 }, Request(), 0, 1, _ => ValueTask.FromResult(observed));
        Refused(output, change == "missing" ? "article_package_candidate_review_context_unavailable"
            : "article_package_candidate_review_context_invalid");
    }

    [Theory]
    [InlineData("actor")]
    [InlineData("site")]
    [InlineData("permission-context")]
    [InlineData("missing")]
    public async Task ChangedFinalObservation_RefusesCompleteCandidate(string change)
    {
        int observations = 0;
        ArticlePackageImportCandidateReviewProduction output = await Producer(Accessor()).ProduceAsync(
            Archive(), Request(), 0, 1, _ => ValueTask.FromResult<ArticleRelationActorContext?>(
                ++observations == 1 ? s_context : change == "missing" ? null : ChangedContext(change)));
        Refused(output, "article_package_candidate_review_context_drift");
        Assert.Equal(2, observations);
    }

    [Theory]
    [InlineData("zip", "article_package_zip_byte_budget_exceeded")]
    [InlineData("policy", "article_package_import_request_invalid")]
    [InlineData("interval", "article_package_import_request_invalid")]
    [InlineData("page", "article_package_candidate_review_invalid")]
    public async Task OriginalRefusals_ReturnNoPartialProjection(string change, string reason)
    {
        ArticlePackageImportCandidateRequest request = Request();
        if (change == "policy")
        {
            request = request with
            {
                PolicyDigest = "not-a-digest"
            };
        }
        else if (change == "interval")
        {
            request = request with
            {
                ExpiresAtUtc = s_created
            };
        }
        ArticlePackageImportCandidateReviewProduction output = await Producer(Accessor()).ProduceAsync(
            change == "zip" ? new byte[] { 0 } : Archive(), request, change == "page" ? 1 : 0, 1, Observe);
        Refused(output, reason);
    }

    [Fact]
    public async Task RequestRevokedDuringTargetCopy_RefusesBeforeFinalObserver()
    {
        byte[] zip = Archive();
        Assert.True(ArticlePackageImportZipCandidateReader.TryReadCandidate(zip, out var candidate).IsValid);
        HttpContextAccessor accessor = Accessor();
        var target = new ArticlePackageImportRequestedTarget(candidate!.Candidate.Manifest.Articles[0].PortableArticle,
            41, 9_007_199_254_740_993L);
        var targets = new MovingTargets(target, () => accessor.HttpContext!.User = new ClaimsPrincipal());
        ArticlePackageImportCandidateRequest request = Request() with
        {
            Mode = ArticlePackageImportCandidateMode.UpdateRequested,
            RequestedTargets = targets
        };
        int observations = 0;
        ArticlePackageImportCandidateReviewProduction output = await Producer(accessor).ProduceAsync(zip, request, 0, 1,
            _ =>
            {
                observations++;
                return ValueTask.FromResult<ArticleRelationActorContext?>(s_context);
            });
        Refused(output, "article_package_candidate_review_context_drift");
        Assert.True(targets.WasRead);
        Assert.Equal(1, observations);
    }

    [Theory]
    [InlineData("session")]
    [InlineData("request")]
    public async Task FinalRequestMovement_RefusesEvenWhenContextValueIsUnchanged(string change)
    {
        HttpContextAccessor accessor = Accessor();
        int observations = 0;
        ArticlePackageImportCandidateReviewProduction output = await Producer(accessor).ProduceAsync(Archive(), Request(), 0, 1,
            _ =>
            {
                if (++observations == 2)
                {
                    if (change == "request")
                    {
                        accessor.HttpContext = new DefaultHttpContext { User = accessor.HttpContext!.User };
                    }
                    else
                    {
                        ClaimsIdentity identity = Assert.IsType<ClaimsIdentity>(accessor.HttpContext!.User.Identity);
                        identity.RemoveClaim(identity.FindFirst("admin_sid")!);
                        identity.AddClaim(new("admin_sid", "changed-session"));
                    }
                }
                return ValueTask.FromResult<ArticleRelationActorContext?>(s_context);
            });
        Refused(output, "article_package_candidate_review_context_drift");
    }

    [Fact]
    public async Task CancelledAndRepeatedCalls_RefuseWithoutPartialOutputThenRecover()
    {
        HttpContextAccessor accessor = Accessor();
        ArticlePackageImportCandidateReviewProducer producer = Producer(accessor);
        byte[] zip = Archive();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Refused(await producer.ProduceAsync(zip, Request(), 0, 1, Observe, cancellation.Token),
            "article_package_import_cancelled");
        using var duringRead = new CancellationTokenSource();
        Refused(await producer.ProduceAsync(zip, Request(), 0, 1, _ =>
        {
            duringRead.Cancel();
            return ValueTask.FromResult<ArticleRelationActorContext?>(s_context);
        }, duringRead.Token), "article_package_import_cancelled");
        ArticlePackageImportCandidateReviewProduction first = await producer.ProduceAsync(zip, Request(), 0, 1, Observe);
        ArticlePackageImportCandidateReviewProduction second = await producer.ProduceAsync(zip, Request(), 0, 1, Observe);
        Assert.True(first.Result.IsValid);
        Assert.True(second.Result.IsValid);
        Assert.Equal(first.Review!.PlanDigest, second.Review!.PlanDigest);
        Assert.True(first.Review.ExecuteDisabled);
        Assert.True(second.Review.ExecuteDisabled);
    }

    [Fact]
    public async Task AuthenticationMovementAtProjectionTime_IsCheckedBeforeReturn()
    {
        HttpContextAccessor accessor = Accessor();
        var clock = new ControlledClock(() => accessor.HttpContext!.User = new ClaimsPrincipal());
        ArticlePackageImportCandidateReviewProduction output = await new ArticlePackageImportCandidateReviewProducer(accessor, clock)
            .ProduceAsync(Archive(), Request(), 0, 1, Observe);
        Refused(output, "article_package_candidate_review_context_drift");
    }

    [Fact]
    public async Task CanonicalReaderFailure_IsNotConvertedToAContextOrSuccessfulReview()
    {
        await Assert.ThrowsAsync<InvalidOperationException>(() => Producer(Accessor()).ProduceAsync(
            Archive(), Request(), 0, 1, _ => throw new InvalidOperationException("controlled-owner-failure")));
    }

    private static ArticleRelationActorContext ChangedContext(string change)
        => change switch
        {
            "actor" => s_context with { ActorIdentity = "admin_principal:74" },
            "site" => s_context with { SiteIdentity = "site:other-controlled-unit" },
            _ => s_context with { PermissionContextDigest = new string('c', 64) }
        };

    private static ValueTask<ArticleRelationActorContext?> Observe(CancellationToken cancellationToken)
        => ValueTask.FromResult<ArticleRelationActorContext?>(s_context);

    private static ArticlePackageImportCandidateRequest Request()
        => new(s_context, ArticlePackageImportCandidateMode.CreateNew, new string('b', 64),
            s_created, s_created.AddMinutes(30), null);

    private static ArticlePackageImportCandidateReviewProducer Producer(HttpContextAccessor accessor)
        => new(accessor, new ControlledClock());

    private static HttpContextAccessor Accessor()
    {
        var identity = new ClaimsIdentity(new[]
        {
            new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
            new Claim("admin_id", 73.ToString(CultureInfo.InvariantCulture)),
            new Claim("admin_sid", "controlled-session"),
            new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
        }, "controlled-unit");
        return new()
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(identity)
            }
        };
    }

    private static byte[] Archive(int count = 1)
    {
        ArticlePackageImportCandidateByteTests.PackageCase package = ArticlePackageImportCandidateByteTests.CreatePackage(count);
        using var memory = new MemoryStream();
        using (var archive = new ZipArchive(memory, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (ArticlePackageFileBytes file in package.Files)
            {
                ZipArchiveEntry entry = archive.CreateEntry(file.Path, CompressionLevel.NoCompression);
                entry.LastWriteTime = new(2026, 10, 9, 0, 0, 0, TimeSpan.Zero);
                using Stream output = entry.Open();
                output.Write(file.Bytes.Span);
            }
        }
        return memory.ToArray();
    }

    private static void Refused(ArticlePackageImportCandidateReviewProduction output, string reason)
    {
        Assert.False(output.Result.IsValid);
        Assert.Equal(reason, output.Result.ReasonCode);
        Assert.Null(output.Review);
    }

    private sealed class ControlledClock(Action? whenRead = null) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow()
        {
            whenRead?.Invoke();
            return new(s_created.AddMinutes(1));
        }
    }

    private sealed class MovingTargets(ArticlePackageImportRequestedTarget target, Action whenRead)
        : IReadOnlyList<ArticlePackageImportRequestedTarget>
    {
        public bool WasRead
        {
            get; private set;
        }
        public int Count => 1;

        public ArticlePackageImportRequestedTarget this[int index]
        {
            get
            {
                if (index != 0)
                {
                    throw new ArgumentOutOfRangeException(nameof(index));
                }
                WasRead = true;
                whenRead();
                return target;
            }
        }

        public IEnumerator<ArticlePackageImportRequestedTarget> GetEnumerator()
        {
            yield return this[0];
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
