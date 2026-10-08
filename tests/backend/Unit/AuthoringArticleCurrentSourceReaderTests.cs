using System.Collections.Immutable;
using System.Reflection;
using System.Text;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.AuthoringCanvas;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthoringArticleCurrentSourceReaderTests
{
    private const int ArticleId = 37;
    private const long RevisionId = 901;
    private const int RevisionNo = 7;
    private const string Markdown = " \t# 标题 😀\r\n\r\n原始 e\u0301\t  \n末尾\u2028 \r\n";
    private static readonly AuthoringCanvasOwner s_owner = new(61, "primary-site");
    private static readonly Guid s_requestId = Guid.Parse("4d343eb7-ab57-4853-a2a7-43c92d7efc95");
    private static readonly string[] s_readOrder =
        ["authority-before", "article-before", "package", "article-after", "authority-after"];

    [Fact]
    public async Task ReadCurrentAuthorizedAsync_PreservesSealedRawSourceAndActualRequestCoordinates()
    {
        var fixture = new ReaderFixture();
        using var cancellation = new CancellationTokenSource();

        AuthoringArticleCurrentSourceReadResult result = await fixture.Reader.ReadCurrentAuthorizedAsync(
            s_owner, ArticleId, s_requestId, cancellation.Token);

        Assert.Equal(RevisionComparePackageReadStatus.Available, result.Status);
        Assert.Equal("accepted", result.ReasonCode);
        AuthoringArticleCurrentSource source = Assert.IsType<AuthoringArticleCurrentSource>(result.Source);
        Assert.Equal(s_owner, source.Owner);
        Assert.Equal(s_requestId, source.RequestId);
        Assert.Equal(fixture.AfterAuthority, source.Authority);
        Assert.Equal(ArticleId, source.Article.ArticleId);
        Assert.Equal(RevisionId, source.Article.CurrentRevision);
        Assert.Same(fixture.PackageResult.Package, source.Package);
        Assert.True(RevisionComparePackageSeal.Verify(source.Package));
        Assert.Equal(RevisionId, source.Package.RevisionId);
        Assert.Equal(RevisionNo, source.Package.RevisionNo);
        Assert.NotEqual(source.Package.RevisionId!.Value, (long)source.Package.RevisionNo!.Value);
        Assert.Equal(Encoding.UTF8.GetBytes(Markdown), source.Package.RawMarkdown.ToArray());
        Assert.Equal("作者", source.Package.Metadata.Single(item => item.FieldId == "title").CanonicalValue);
        Assert.Equal(3, source.Package.Snapshots.Length);
        Assert.Equal("{\"holder\":\"作者\"}", Encoding.UTF8.GetString(
            source.Package.Snapshots.Single(item => item.Kind == RevisionCompareSnapshotKind.Rights).Payload.AsSpan()));
        Assert.Equal(s_readOrder, fixture.Calls);
        Assert.All(fixture.Tokens, token => Assert.Equal(cancellation.Token, token));
        Assert.All(fixture.ArticleOwners, owner => Assert.Equal(s_owner, owner));
        Assert.All(fixture.Permissions, permission =>
            Assert.Equal(AuthoringCanvasReferencePermission.ArticleRead, permission));
        Assert.All(fixture.ArticleIds, id => Assert.Equal(ArticleId, id));
        Assert.Equal(new RevisionCompareReadContext(61,
            AuthoringRevisionCompareDraftContextProvider.PrimarySiteScope, s_requestId), fixture.PackageContext);
        Assert.Equal("primary", fixture.PackageContext!.SiteScope);
        Assert.Equal(new RevisionCompareSourceSelector(
            RevisionCompareSourceKind.CurrentRevision, RevisionId: RevisionId), fixture.PackageSelector);
        Assert.Equal(ArticleId, fixture.PackageArticleId);
    }

    [Fact]
    public async Task ReadCurrentAuthorizedAsync_FreezesAnEmptyMutablePinsCollection()
    {
        var pins = new Dictionary<long, AuthoringCanvasArticleRevisionDisplayFact>();
        var fixture = new ReaderFixture
        {
            BeforeArticle = Current() with { PinnedDisplays = pins },
            AfterArticle = Current() with { PinnedDisplays = pins }
        };

        AuthoringArticleCurrentSourceReadResult result = await fixture.ReadAsync();
        AuthoringArticleCurrentSource source = Assert.IsType<AuthoringArticleCurrentSource>(result.Source);
        pins.Add(12, new(12, "Later mutable projection", "Must stay outside the source result"));

        Assert.Empty(source.Article.PinnedDisplays);
        Assert.Single(pins);
        Assert.NotSame(pins, source.Article.PinnedDisplays);
        Assert.Equal(RevisionId, source.Article.CurrentRevision);
        Assert.True(RevisionComparePackageSeal.Verify(source.Package));
    }

    [Theory]
    [InlineData("package")]
    [InlineData("authority-after")]
    public async Task ReadCurrentAuthorizedAsync_LatePinsMutationCannotChangeCapturedScalarSource(string stage)
    {
        var beforePins = new Dictionary<long, AuthoringCanvasArticleRevisionDisplayFact>();
        var afterPins = new Dictionary<long, AuthoringCanvasArticleRevisionDisplayFact>();
        AuthoringCanvasArticleReferenceRecord before = Current() with
        {
            PinnedDisplays = beforePins
        };
        AuthoringCanvasArticleReferenceRecord after = Current() with
        {
            PinnedDisplays = afterPins
        };
        var entered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var fixture = new ReaderFixture
        {
            BeforeArticle = before,
            AfterArticle = after,
            BeforeReturn = async (name, _) =>
            {
                if (name == stage)
                {
                    entered.SetResult(true);
                    await release.Task.ConfigureAwait(false);
                }
            }
        };
        Task<AuthoringArticleCurrentSourceReadResult> read = fixture.ReadAsync();
        Assert.Same(entered.Task, await Task.WhenAny(entered.Task, read));
        Dictionary<long, AuthoringCanvasArticleRevisionDisplayFact> latePins
            = stage == "package" ? beforePins : afterPins;
        Assert.Empty(latePins);

        // This read was valid when returned; its owner's later cache mutation is not a new source fact.
        latePins.Add(12, new(12, "Late pinned revision", "Outside the captured scalar read"));
        release.SetResult(true);
        AuthoringArticleCurrentSourceReadResult result = await read;

        Assert.Equal(RevisionComparePackageReadStatus.Available, result.Status);
        AuthoringArticleCurrentSource source = Assert.IsType<AuthoringArticleCurrentSource>(result.Source);
        Assert.Equal(s_owner, source.Owner);
        Assert.Equal(s_requestId, source.RequestId);
        Assert.Equal(ArticleId, source.Article.ArticleId);
        Assert.Equal(AuthoringCanvasArticleState.Current, source.Article.State);
        Assert.Equal(RevisionId, source.Article.CurrentRevision);
        Assert.Equal(after.CurrentDisplay, source.Article.CurrentDisplay);
        Assert.Equal(fixture.AfterAuthority, source.Authority);
        Assert.Empty(source.Article.PinnedDisplays);
        Assert.NotSame(beforePins, source.Article.PinnedDisplays);
        Assert.NotSame(afterPins, source.Article.PinnedDisplays);
        Assert.Single(latePins);
        Assert.Same(fixture.PackageResult.Package, source.Package);
        Assert.True(RevisionComparePackageSeal.Verify(source.Package));
        Assert.Equal(Encoding.UTF8.GetBytes(Markdown), source.Package.RawMarkdown.ToArray());
        Assert.Equal(RevisionId, fixture.PackageSelector!.RevisionId);
        Assert.Equal(s_readOrder, fixture.Calls);

        latePins.Clear();
        latePins.Add(13, new(13, "Another cache mutation", null));
        Assert.Empty(source.Article.PinnedDisplays);
        Assert.Equal(after.CurrentDisplay, source.Article.CurrentDisplay);
    }

    [Theory]
    [InlineData("primary", ArticleId, false)]
    [InlineData("other-site", ArticleId, false)]
    [InlineData("primary-site", 0, false)]
    [InlineData("primary-site", -1, false)]
    [InlineData("primary-site", ArticleId, true)]
    public async Task ReadCurrentAuthorizedAsync_InvalidRequestNeverTouchesAuthorities(
        string site, int articleId, bool emptyRequest)
    {
        var fixture = new ReaderFixture();

        AuthoringArticleCurrentSourceReadResult result = await fixture.Reader.ReadCurrentAuthorizedAsync(
            new(61, site), articleId, emptyRequest ? Guid.Empty : s_requestId);

        AssertRefused(result, RevisionComparePackageReadStatus.Invalid);
        Assert.Empty(fixture.Calls);
    }

    [Fact]
    public async Task ReadCurrentAuthorizedAsync_InvalidPrincipalKeepsOriginalOwnerValidation()
    {
        var fixture = new ReaderFixture();

        await Assert.ThrowsAsync<AuthoringCanvasValidationException>(() =>
            fixture.Reader.ReadCurrentAuthorizedAsync(new(0, "primary-site"), ArticleId, s_requestId));

        Assert.Empty(fixture.Calls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ReadCurrentAuthorizedAsync_RevokedAuthorityExposesNoSource(bool after)
    {
        var fixture = new ReaderFixture();
        if (after)
        {
            fixture.AfterAuthority = Authority() with
            {
                Authorized = false
            };
        }
        else
        {
            fixture.BeforeAuthority = Authority() with
            {
                Authorized = false
            };
        }

        AuthoringArticleCurrentSourceReadResult result = await fixture.ReadAsync();

        AssertRefused(result, RevisionComparePackageReadStatus.Unavailable);
        Assert.Equal(after ? s_readOrder : ["authority-before"], fixture.Calls);
        Assert.Equal(after ? 1 : 0, fixture.PackageReadCount);
    }

    [Theory]
    [InlineData("null", false)]
    [InlineData("null", true)]
    [InlineData("missing", false)]
    [InlineData("missing", true)]
    [InlineData("deleted", false)]
    [InlineData("deleted", true)]
    [InlineData("archived", false)]
    [InlineData("archived", true)]
    [InlineData("denied", false)]
    [InlineData("denied", true)]
    public async Task ReadCurrentAuthorizedAsync_LifecycleUnavailableBeforeOrAfterNeverLeaksBody(
        string lifecycle, bool after)
    {
        var fixture = new ReaderFixture();
        AuthoringCanvasArticleReferenceRecord? article = lifecycle switch
        {
            "null" => null,
            "missing" => Current() with { State = AuthoringCanvasArticleState.Missing },
            "deleted" => Current() with { State = AuthoringCanvasArticleState.Deleted },
            "archived" => Current() with { State = AuthoringCanvasArticleState.Archived },
            "denied" => Current() with { State = AuthoringCanvasArticleState.PermissionDeniedOrUnknown },
            _ => throw new ArgumentOutOfRangeException(nameof(lifecycle))
        };
        if (after)
        {
            fixture.AfterArticle = article;
        }
        else
        {
            fixture.BeforeArticle = article;
        }

        AuthoringArticleCurrentSourceReadResult result = await fixture.ReadAsync();

        AssertRefused(result, RevisionComparePackageReadStatus.Unavailable);
        Assert.Equal(after ? s_readOrder[..4] : s_readOrder[..2], fixture.Calls);
        Assert.Equal(after ? 1 : 0, fixture.PackageReadCount);
    }

    [Theory]
    [InlineData("principal")]
    [InlineData("content")]
    [InlineData("articles")]
    [InlineData("revisions")]
    [InlineData("fingerprint")]
    [InlineData("authorized")]
    public async Task ReadCurrentAuthorizedAsync_EachAuthorityDriftFieldRefusesOriginalPackage(string field)
    {
        var fixture = new ReaderFixture
        {
            AfterAuthority = field switch
            {
                "principal" => Authority() with { PrincipalGeneration = 12 },
                "content" => Authority() with { ContentGeneration = 22 },
                "articles" => Authority() with { ArticleCount = 33 },
                "revisions" => Authority() with { RevisionCount = 44 },
                "fingerprint" => Authority() with { PermissionFingerprint = new('b', 64) },
                "authorized" => Authority() with { Authorized = false },
                _ => throw new ArgumentOutOfRangeException(nameof(field))
            }
        };

        AuthoringArticleCurrentSourceReadResult result = await fixture.ReadAsync();

        AssertRefused(result, field == "authorized"
            ? RevisionComparePackageReadStatus.Unavailable : RevisionComparePackageReadStatus.Stale);
        Assert.Equal(s_readOrder, fixture.Calls);
        Assert.Equal(1, fixture.PackageReadCount);
    }

    [Theory]
    [InlineData("principal", false)]
    [InlineData("principal", true)]
    [InlineData("content", false)]
    [InlineData("content", true)]
    [InlineData("articles", false)]
    [InlineData("articles", true)]
    [InlineData("revisions", false)]
    [InlineData("revisions", true)]
    [InlineData("short-fingerprint", false)]
    [InlineData("short-fingerprint", true)]
    [InlineData("uppercase-fingerprint", false)]
    [InlineData("uppercase-fingerprint", true)]
    [InlineData("null-fingerprint", false)]
    [InlineData("null-fingerprint", true)]
    public async Task ReadCurrentAuthorizedAsync_MalformedAuthorityCannotBecomeSource(string field, bool after)
    {
        var fixture = new ReaderFixture();
        AuthoringCanvasArticleReadAuthority malformed = field switch
        {
            "principal" => Authority() with { PrincipalGeneration = 0 },
            "content" => Authority() with { ContentGeneration = 0 },
            "articles" => Authority() with { ArticleCount = -1 },
            "revisions" => Authority() with { RevisionCount = -1 },
            "short-fingerprint" => Authority() with { PermissionFingerprint = "a" },
            "uppercase-fingerprint" => Authority() with { PermissionFingerprint = new('A', 64) },
            "null-fingerprint" => Authority() with { PermissionFingerprint = null! },
            _ => throw new ArgumentOutOfRangeException(nameof(field))
        };
        if (after)
        {
            fixture.AfterAuthority = malformed;
        }
        else
        {
            fixture.BeforeAuthority = malformed;
        }

        AuthoringArticleCurrentSourceReadResult result = await fixture.ReadAsync();

        AssertRefused(result, RevisionComparePackageReadStatus.Invalid);
        Assert.Equal(after ? s_readOrder : ["authority-before"], fixture.Calls);
        Assert.Equal(after ? 1 : 0, fixture.PackageReadCount);
    }

    [Theory]
    [InlineData("head")]
    [InlineData("title")]
    [InlineData("snippet")]
    public async Task ReadCurrentAuthorizedAsync_HeadOrDisplayRaceNeverRefreshesTheOriginalSource(string drift)
    {
        var fixture = new ReaderFixture
        {
            AfterArticle = drift switch
            {
                "head" => Current(RevisionId + 1),
                "title" => Current() with { CurrentDisplay = Current().CurrentDisplay with { Title = "Changed" } },
                "snippet" => Current() with { CurrentDisplay = Current().CurrentDisplay with { ContextSnippet = "Changed" } },
                _ => throw new ArgumentOutOfRangeException(nameof(drift))
            }
        };

        AuthoringArticleCurrentSourceReadResult result = await fixture.ReadAsync();

        AssertRefused(result, RevisionComparePackageReadStatus.Stale);
        Assert.Equal(s_readOrder, fixture.Calls);
        Assert.Equal(1, fixture.PackageReadCount);
        Assert.Equal(RevisionId, fixture.PackageSelector!.RevisionId);
    }

    [Theory]
    [InlineData("wrong-article", false)]
    [InlineData("wrong-article", true)]
    [InlineData("zero-revision", false)]
    [InlineData("zero-revision", true)]
    [InlineData("display-revision", false)]
    [InlineData("display-revision", true)]
    [InlineData("null-display", false)]
    [InlineData("null-display", true)]
    [InlineData("nonempty-pins", false)]
    [InlineData("nonempty-pins", true)]
    [InlineData("null-pins", false)]
    [InlineData("null-pins", true)]
    [InlineData("unknown-state", false)]
    [InlineData("unknown-state", true)]
    public async Task ReadCurrentAuthorizedAsync_InvalidArticleFactsNeverBecomeSource(string defect, bool after)
    {
        var fixture = new ReaderFixture();
        AuthoringCanvasArticleReferenceRecord invalid = defect switch
        {
            "wrong-article" => Current() with { ArticleId = ArticleId + 1 },
            "zero-revision" => Current(0),
            "display-revision" => Current() with { CurrentDisplay = new(RevisionId + 1, "Other", null) },
            "null-display" => Current() with { CurrentDisplay = null! },
            "nonempty-pins" => Current() with
            {
                PinnedDisplays = new Dictionary<long, AuthoringCanvasArticleRevisionDisplayFact>
                {
                    [12] = new(12, "Pinned", null)
                }
            },
            "null-pins" => Current() with { PinnedDisplays = null! },
            "unknown-state" => Current() with { State = (AuthoringCanvasArticleState)999 },
            _ => throw new ArgumentOutOfRangeException(nameof(defect))
        };
        if (after)
        {
            fixture.AfterArticle = invalid;
        }
        else
        {
            fixture.BeforeArticle = invalid;
        }

        AuthoringArticleCurrentSourceReadResult result = await fixture.ReadAsync();

        AssertRefused(result, RevisionComparePackageReadStatus.Invalid);
        Assert.Equal(after ? s_readOrder[..4] : s_readOrder[..2], fixture.Calls);
        Assert.Equal(after ? 1 : 0, fixture.PackageReadCount);
    }

    [Theory]
    [InlineData("wrong-article")]
    [InlineData("historical")]
    [InlineData("draft")]
    [InlineData("wrong-revision")]
    [InlineData("null")]
    [InlineData("tampered-bytes")]
    [InlineData("tampered-seal")]
    [InlineData("zero-revision-number")]
    public async Task ReadCurrentAuthorizedAsync_InvalidAvailablePackageStopsBeforeFurtherReads(string defect)
    {
        RevisionComparePackage original = Package();
        RevisionComparePackage? invalid = defect switch
        {
            "wrong-article" => Package(articleId: ArticleId + 1),
            "historical" => Package(kind: RevisionCompareSourceKind.HistoricalRevision),
            "draft" => RevisionComparePackageSeal.Create(
                ArticleId, RevisionCompareSourceKind.CurrentDraft, "draft:61:4:epoch-a", null, null,
                4, "epoch-a", Encoding.UTF8.GetBytes(Markdown), original.Metadata, original.Snapshots),
            "wrong-revision" => Package(revisionId: RevisionId + 1),
            "null" => null,
            "tampered-bytes" => CopyPackage(original,
                rawMarkdown: ImmutableArray.CreateRange(Encoding.UTF8.GetBytes("replacement"))),
            "tampered-seal" => CopyPackage(original, digest: new('0', 64)),
            "zero-revision-number" => CopyPackage(original, revisionNo: 0),
            _ => throw new ArgumentOutOfRangeException(nameof(defect))
        };
        var fixture = new ReaderFixture
        {
            PackageResult = new(RevisionComparePackageReadStatus.Available, invalid, "private-source-details")
        };

        AuthoringArticleCurrentSourceReadResult result = await fixture.ReadAsync();

        AssertRefused(result, RevisionComparePackageReadStatus.Invalid);
        Assert.Equal(s_readOrder[..3], fixture.Calls);
    }

    [Theory]
    [InlineData("default-raw")]
    [InlineData("default-metadata")]
    [InlineData("default-snapshots")]
    [InlineData("null-metadata-item")]
    [InlineData("null-canonical-value")]
    [InlineData("null-snapshot-item")]
    [InlineData("default-snapshot-payload")]
    public async Task ReadCurrentAuthorizedAsync_UninitializedBoundaryPackageRefusesWithoutThrowing(string defect)
    {
        RevisionComparePackage original = Package();
        RevisionComparePackage malformed = defect switch
        {
            "default-raw" => CopyPackage(original, rawMarkdown: default(ImmutableArray<byte>)),
            "default-metadata" => CopyPackage(original, metadata: default(ImmutableArray<RevisionCompareMetadataValue>)),
            "default-snapshots" => CopyPackage(original, snapshots: default(ImmutableArray<RevisionCompareSnapshot>)),
            "null-metadata-item" => CopyPackage(original, metadata: original.Metadata.SetItem(0, null!)),
            "null-canonical-value" => CopyPackage(original,
                metadata: original.Metadata.SetItem(0, original.Metadata[0] with
                {
                    CanonicalValue = null!
                })),
            "null-snapshot-item" => CopyPackage(original, snapshots: original.Snapshots.SetItem(0, null!)),
            "default-snapshot-payload" => CopyPackage(original, snapshots: original.Snapshots.SetItem(
                2, SnapshotWithDefaultPayload(original.Snapshots[2]))),
            _ => throw new ArgumentOutOfRangeException(nameof(defect))
        };
        var fixture = new ReaderFixture
        {
            PackageResult = new(RevisionComparePackageReadStatus.Available, malformed, "private-boundary-detail")
        };

        AuthoringArticleCurrentSourceReadResult result = await fixture.ReadAsync();

        AssertRefused(result, RevisionComparePackageReadStatus.Invalid);
        Assert.Equal(s_readOrder[..3], fixture.Calls);
        Assert.Equal(1, fixture.PackageReadCount);
    }

    [Fact]
    public async Task ReadCurrentAuthorizedAsync_CorrectlySealedOversizedSourceIsBudgetExceededBeforeRereads()
    {
        RevisionComparePackage original = Package();
        byte[] raw = new byte[RevisionCompareContract.AbsoluteMaxSourceBytes + 1];
        Array.Fill(raw, (byte)'a');
        ImmutableArray<byte> oversizedBytes = ImmutableArray.CreateRange(raw);
        string sourceDigest = RevisionCompareCanonical.Sha256(oversizedBytes.AsSpan());
        string packageDigest = RevisionCompareCanonical.PackageDigest(
            original.ArticleId, original.SourceKind, original.SourceIdentity, original.RevisionId,
            original.RevisionNo, original.ServerRevision, original.DocumentEpoch, sourceDigest,
            oversizedBytes.Length, original.Metadata, original.Snapshots);
        // Only the boundary fixture bypasses Create's budget, with authentic digests rather than a tampered seal.
        var oversized = new RevisionComparePackage(
            original.ArticleId, original.SourceKind, original.SourceIdentity, original.RevisionId,
            original.RevisionNo, original.ServerRevision, original.DocumentEpoch, oversizedBytes,
            sourceDigest, original.Metadata, original.Snapshots, packageDigest);
        Assert.True(RevisionComparePackageSeal.Verify(oversized));
        var fixture = new ReaderFixture
        {
            PackageResult = RevisionComparePackageReadResult.Available(oversized)
        };

        AuthoringArticleCurrentSourceReadResult result = await fixture.ReadAsync();

        AssertRefused(result, RevisionComparePackageReadStatus.BudgetExceeded);
        Assert.Equal(s_readOrder[..3], fixture.Calls);
        Assert.Equal(1, fixture.PackageReadCount);
    }

    [Fact]
    public async Task ReadCurrentAuthorizedAsync_NullTitleAndSnippetRemainValidWithoutInventedDisplayText()
    {
        AuthoringCanvasArticleReferenceRecord article = Current() with
        {
            CurrentDisplay = new(RevisionId, null, null)
        };
        var fixture = new ReaderFixture
        {
            BeforeArticle = article,
            AfterArticle = article
        };

        AuthoringArticleCurrentSourceReadResult result = await fixture.ReadAsync();

        Assert.Equal(RevisionComparePackageReadStatus.Available, result.Status);
        AuthoringArticleCurrentSource source = Assert.IsType<AuthoringArticleCurrentSource>(result.Source);
        Assert.Null(source.Article.CurrentDisplay.Title);
        Assert.Null(source.Article.CurrentDisplay.ContextSnippet);
        Assert.Equal(RevisionId, source.Article.CurrentRevision);
        Assert.Equal("作者", source.Package.Metadata.Single(item => item.FieldId == "title").CanonicalValue);
        Assert.Equal(Encoding.UTF8.GetBytes(Markdown), source.Package.RawMarkdown.ToArray());
        Assert.True(RevisionComparePackageSeal.Verify(source.Package));
        Assert.Equal(s_readOrder, fixture.Calls);
    }

    [Theory]
    [InlineData(RevisionComparePackageReadStatus.Unavailable)]
    [InlineData(RevisionComparePackageReadStatus.Stale)]
    [InlineData(RevisionComparePackageReadStatus.Invalid)]
    [InlineData(RevisionComparePackageReadStatus.BudgetExceeded)]
    [InlineData((RevisionComparePackageReadStatus)999)]
    public async Task ReadCurrentAuthorizedAsync_NonAvailableOrUnknownStatusCannotLeakAnAttachedPackage(
        RevisionComparePackageReadStatus status)
    {
        var fixture = new ReaderFixture
        {
            PackageResult = new(status, Package(), "private-title-and-error-detail")
        };

        AuthoringArticleCurrentSourceReadResult result = await fixture.ReadAsync();

        AssertRefused(result, status == (RevisionComparePackageReadStatus)999
            ? RevisionComparePackageReadStatus.Invalid : status);
        Assert.Equal(s_readOrder[..3], fixture.Calls);
    }

    [Theory]
    [InlineData("authority-before")]
    [InlineData("article-before")]
    [InlineData("package")]
    [InlineData("article-after")]
    [InlineData("authority-after")]
    public async Task ReadCurrentAuthorizedAsync_CallerCancellationAtEveryAwaitStopsFurtherObservations(string stage)
    {
        using var cancellation = new CancellationTokenSource();
        var entered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var fixture = new ReaderFixture
        {
            BeforeReturn = async (name, _) =>
            {
                if (name == stage)
                {
                    entered.SetResult(true);
                    await release.Task.ConfigureAwait(false);
                }
            }
        };
        Task<AuthoringArticleCurrentSourceReadResult> read = fixture.Reader.ReadCurrentAuthorizedAsync(
            s_owner, ArticleId, s_requestId, cancellation.Token);
        Assert.Same(entered.Task, await Task.WhenAny(entered.Task, read));

        cancellation.Cancel();
        release.SetResult(true);

        OperationCanceledException error = await Assert.ThrowsAnyAsync<OperationCanceledException>(() => read);
        Assert.Equal(cancellation.Token, error.CancellationToken);
        Assert.Equal(s_readOrder[..(Array.IndexOf(s_readOrder, stage) + 1)], fixture.Calls);
        Assert.All(fixture.Tokens, token => Assert.Equal(cancellation.Token, token));
    }

    [Fact]
    public async Task ReadCurrentAuthorizedAsync_PreCancelledCallerDoesNoIo()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var fixture = new ReaderFixture();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            fixture.Reader.ReadCurrentAuthorizedAsync(s_owner, ArticleId, s_requestId, cancellation.Token));

        Assert.Empty(fixture.Calls);
    }

    private static void AssertRefused(
        AuthoringArticleCurrentSourceReadResult result, RevisionComparePackageReadStatus status)
    {
        Assert.Equal(status, result.Status);
        Assert.Null(result.Source);
        Assert.Equal(status switch
        {
            RevisionComparePackageReadStatus.Unavailable => "authoring_current_source_unavailable",
            RevisionComparePackageReadStatus.Stale => "authoring_current_source_stale",
            RevisionComparePackageReadStatus.BudgetExceeded => "authoring_current_source_budget_exceeded",
            _ => "authoring_current_source_invalid"
        }, result.ReasonCode);
    }

    private static AuthoringCanvasArticleReadAuthority Authority()
        => new(11, 21, 32, 43, new('a', 64), true);

    private static AuthoringCanvasArticleReferenceRecord Current(long revisionId = RevisionId)
        => new(ArticleId, AuthoringCanvasArticleState.Current, revisionId,
            new(revisionId, "Current title", "Display context"),
            new Dictionary<long, AuthoringCanvasArticleRevisionDisplayFact>());

    private static RevisionComparePackage Package(
        int articleId = ArticleId,
        long revisionId = RevisionId,
        RevisionCompareSourceKind kind = RevisionCompareSourceKind.CurrentRevision)
        => RevisionComparePackageSeal.Create(
            articleId, kind, $"revision:{revisionId}", revisionId, RevisionNo, null, null,
            Encoding.UTF8.GetBytes(Markdown), [RevisionCompareMetadataRegistry.String("title", "作者")],
            [
                RevisionCompareSnapshot.Present(RevisionCompareSnapshotKind.Rights,
                    "rights:37:901", 1, Encoding.UTF8.GetBytes("{\"holder\":\"作者\"}")),
                RevisionCompareSnapshot.Present(RevisionCompareSnapshotKind.Responsibility,
                    "responsibility:37:901", 1, Encoding.UTF8.GetBytes("{\"author\":\"原作者\"}")),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)
            ]);

    private static RevisionComparePackage CopyPackage(
        RevisionComparePackage package,
        ImmutableArray<byte>? rawMarkdown = null,
        string? digest = null,
        int? revisionNo = null,
        ImmutableArray<RevisionCompareMetadataValue>? metadata = null,
        ImmutableArray<RevisionCompareSnapshot>? snapshots = null)
        => new(package.ArticleId, package.SourceKind, package.SourceIdentity, package.RevisionId,
            revisionNo ?? package.RevisionNo, package.ServerRevision, package.DocumentEpoch,
            rawMarkdown ?? package.RawMarkdown, package.SourceDigest,
            metadata ?? package.Metadata, snapshots ?? package.Snapshots,
            digest ?? package.PackageDigest);

    private static RevisionCompareSnapshot SnapshotWithDefaultPayload(RevisionCompareSnapshot original)
    {
        // Preserve all other fields of the legitimate absent snapshot; only its array becomes uninitialized.
        ConstructorInfo constructor = typeof(RevisionCompareSnapshot)
            .GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic).Single();
        return Assert.IsType<RevisionCompareSnapshot>(constructor.Invoke(
            [original.Kind, original.State, original.Reference, original.SchemaVersion,
                default(ImmutableArray<byte>), original.PayloadDigest]));
    }

    private sealed class ReaderFixture : IAuthoringCanvasArticleReferenceReader, IRevisionComparePackageReader
    {
        private int _authorityReads;
        private int _articleReads;

        public ReaderFixture()
        {
            Reader = new(this, this);
        }

        public AuthoringArticleCurrentSourceReader Reader
        {
            get;
        }
        public AuthoringCanvasArticleReadAuthority BeforeAuthority { get; set; } = Authority();
        public AuthoringCanvasArticleReadAuthority AfterAuthority { get; set; } = Authority();
        public AuthoringCanvasArticleReferenceRecord? BeforeArticle { get; set; } = Current();
        public AuthoringCanvasArticleReferenceRecord? AfterArticle { get; set; } = Current();
        public RevisionComparePackageReadResult PackageResult
        {
            get; set;
        }
            = RevisionComparePackageReadResult.Available(Package());
        public Func<string, CancellationToken, Task> BeforeReturn { get; set; } = (_, _) => Task.CompletedTask;
        public List<string> Calls { get; } = [];
        public List<CancellationToken> Tokens { get; } = [];
        public List<AuthoringCanvasOwner> ArticleOwners { get; } = [];
        public List<AuthoringCanvasReferencePermission> Permissions { get; } = [];
        public List<int> ArticleIds { get; } = [];
        public int PackageReadCount
        {
            get; private set;
        }
        public RevisionCompareReadContext? PackageContext
        {
            get; private set;
        }
        public RevisionCompareSourceSelector? PackageSelector
        {
            get; private set;
        }
        public int PackageArticleId
        {
            get; private set;
        }

        public Task<AuthoringArticleCurrentSourceReadResult> ReadAsync()
            => Reader.ReadCurrentAuthorizedAsync(s_owner, ArticleId, s_requestId);

        public async Task<AuthoringCanvasArticleReadAuthority> ReadAuthorityAsync(
            AuthoringCanvasOwner owner, AuthoringCanvasReferencePermission permission,
            CancellationToken cancellationToken = default)
        {
            ArticleOwners.Add(owner);
            Permissions.Add(permission);
            bool before = _authorityReads++ == 0;
            await ObserveAsync(before ? "authority-before" : "authority-after", cancellationToken);
            return before ? BeforeAuthority : AfterAuthority;
        }

        public async Task<AuthoringCanvasArticleReferenceRecord?> ReadCurrentArticleAsync(
            AuthoringCanvasOwner owner, AuthoringCanvasReferencePermission permission, int articleId,
            CancellationToken cancellationToken = default)
        {
            ArticleOwners.Add(owner);
            Permissions.Add(permission);
            ArticleIds.Add(articleId);
            bool before = _articleReads++ == 0;
            await ObserveAsync(before ? "article-before" : "article-after", cancellationToken);
            return before ? BeforeArticle : AfterArticle;
        }

        public Task<IReadOnlyDictionary<int, AuthoringCanvasArticleReferenceRecord>> ReadBatchAsync(
            AuthoringCanvasOwner owner, AuthoringCanvasReferencePermission permission,
            IReadOnlyList<AuthoringCanvasReferenceTarget> targets, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("Current source must use scalar article IDs, not synthetic Canvas nodes.");

        public async Task<RevisionComparePackageReadResult> ReadAuthorizedAsync(
            RevisionCompareReadContext context, int articleId, RevisionCompareSourceSelector selector,
            CancellationToken cancellationToken = default)
        {
            PackageReadCount++;
            PackageContext = context;
            PackageSelector = selector;
            PackageArticleId = articleId;
            await ObserveAsync("package", cancellationToken);
            return PackageResult;
        }

        private async Task ObserveAsync(string stage, CancellationToken cancellationToken)
        {
            Calls.Add(stage);
            Tokens.Add(cancellationToken);
            await BeforeReturn(stage, cancellationToken);
        }
    }
}
