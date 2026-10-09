using System.Data;

using NSubstitute;
using SqlSugar;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class SqlArticleGraphPersistedMetadataReaderTests
{
    private static readonly AuthorArticlePinOwner s_owner = new(41, "primary-site");

    [Theory]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(false, false)]
    public async Task NeighborRequiresBothPermissionsBeforeMetadata(bool canProject, bool canOpen)
    {
        var fixture = new Fixture();
        fixture.Decision = id => new(id, id == 1 || canProject, id == 1 || canOpen, $"permission:{id}");
        ArticleGraphPersistedMetadataResult result = Assert.IsType<ArticleGraphPersistedMetadataResult>(
            await fixture.Reader.ReadAsync(Request([1, 2])));
        Assert.Equal(1, Assert.Single(result.Facts).ArticleId);
        Assert.All(fixture.MetadataBatches, ids => Assert.Equal(new[] { 1 }, ids));
        Assert.Equal(new[] { "permission:context", "permission:1,2", "rows", "coordinates", "permission:1,2",
            "rows", "coordinates", "permission:1,2" }, fixture.Events);
    }

    [Theory]
    [InlineData(0, 101, 7, "9,11")]
    [InlineData(1, 51, 3, "2,4")]
    public async Task CurrentAndPublicationUseIndependentExactRevisionAndMemberships(
        int selectionValue, long revisionId, int categoryId, string tagIds)
    {
        var selection = (ArticleGraphMetadataSelection)selectionValue;
        var fixture = new Fixture();
        ArticleGraphPersistedMetadataResult result = Assert.IsType<ArticleGraphPersistedMetadataResult>(
            await fixture.Reader.ReadAsync(Request([1], selection)));
        ArticleGraphPersistedMetadataFact fact = Assert.Single(result.Facts);
        Assert.Equal(101, fact.CurrentRevisionId);
        Assert.Equal(501, fact.CurrentPublicationId);
        Assert.Equal(5, fact.PublicationNo);
        Assert.Equal(51, fact.PublicationRevisionId);
        Assert.Equal(5, fact.PublicationRevisionNo);
        Assert.Equal(revisionId, fact.Source.RevisionId);
        Assert.Equal(categoryId, fact.CategoryId);
        Assert.Equal(SqlArticleGraphPersistedMetadataReader.ParseTags(tagIds), fact.TagIds);
        Assert.Equal(Epoch(1), fact.Source.SourceEpoch);
        Assert.Equal(selection, fixture.LastSelection);
    }

    [Fact]
    public async Task EmptyTagMembershipIsACompleteFactAndResultIsImmutable()
    {
        var fixture = new Fixture { ChangeRow = row => row with { SelectedTags = string.Empty } };
        ArticleGraphPersistedMetadataResult result = Assert.IsType<ArticleGraphPersistedMetadataResult>(
            await fixture.Reader.ReadAsync(Request([1])));
        Assert.Empty(Assert.Single(result.Facts).TagIds);
        Assert.Throws<NotSupportedException>(() => ((IList<ArticleGraphPersistedMetadataFact>)result.Facts).Clear());
        Assert.Throws<NotSupportedException>(() => ((IList<int>)result.Facts[0].TagIds).Add(2));
    }

    [Fact]
    public async Task UnavailablePermissionContextRefusesBeforeAnyMetadata()
    {
        var fixture = new Fixture
        {
            ChangePermission = snapshot => snapshot with { Status = AuthorArticlePinPermissionSnapshotStatus.Unavailable }
        };
        Assert.Null(await fixture.Reader.ReadAsync(Request([1])));
        Assert.Equal(new[] { "permission:context" }, fixture.Events);
        Assert.Equal(0, fixture.RowReads);
        Assert.Equal(0, fixture.CoordinateReads);
    }

    [Fact]
    public async Task EntirelyDeniedBatchRevalidatesPermissionsWithoutReadingHiddenFacts()
    {
        var fixture = new Fixture { Decision = id => new(id, false, false, string.Empty) };
        ArticleGraphPersistedMetadataResult result = Assert.IsType<ArticleGraphPersistedMetadataResult>(
            await fixture.Reader.ReadAsync(Request([1, 2])));
        Assert.Empty(result.Facts);
        Assert.Equal(4, fixture.PermissionReads);
        Assert.Equal(0, fixture.RowReads);
        Assert.Equal(0, fixture.CoordinateReads);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-1")]
    [InlineData("1,1")]
    [InlineData("1,,2")]
    [InlineData("01")]
    [InlineData(" 1")]
    [InlineData("2147483648")]
    public async Task MalformedPersistedMembershipRefusesTheEntireResult(string tags)
    {
        var fixture = new Fixture { ChangeRow = row => row.ArticleId == 2 ? row with { SelectedTags = tags } : row };
        Assert.Null(await fixture.Reader.ReadAsync(Request([1, 2])));
        Assert.Equal(0, fixture.CoordinateReads);
    }

    [Fact]
    public async Task BoundsMembershipAllocationBeforeReleasingFacts()
    {
        var fixture = new Fixture
        {
            ChangeRow = row => row with { SelectedTags = string.Join(',', Enumerable.Range(1, 257)) }
        };
        Assert.Null(await fixture.Reader.ReadAsync(Request([1])));
        fixture.ChangeRow = row => row with { SelectedTags = new string('1', 2817) };
        Assert.Null(await fixture.Reader.ReadAsync(Request([1])));
    }

    [Fact]
    public async Task MissingAndDeletedRowsRefuseWithoutPartialResults()
    {
        var fixture = new Fixture { OmitLastRow = true };
        Assert.Null(await fixture.Reader.ReadAsync(Request([1, 2])));
        Assert.Equal(0, fixture.CoordinateReads);
        fixture.OmitLastRow = false;
        fixture.ChangeRow = row => row.ArticleId == 2 ? row with { IsDeleted = true } : row;
        Assert.Null(await fixture.Reader.ReadAsync(Request([1, 2])));
        fixture.ChangeRow = row => row with { Status = ArticleStatus.Deleted };
        Assert.Null(await fixture.Reader.ReadAsync(Request([1])));
    }

    [Fact]
    public async Task PublicationPointerAndExactRevisionNumberAreRequiredRegardlessOfStatus()
    {
        var fixture = new Fixture { ChangeRow = row => row with { CurrentPublicationId = null, PublicationNo = null } };
        Assert.Null(await fixture.Reader.ReadAsync(Request([1], ArticleGraphMetadataSelection.Publication)));
        Assert.Equal(0, fixture.CoordinateReads);
        fixture.ChangeRow = row => row with { PublicationRecordRevisionNo = 9 };
        Assert.Null(await fixture.Reader.ReadAsync(Request([1], ArticleGraphMetadataSelection.Publication)));
        fixture.ChangeRow = row => row with { Status = ArticleStatus.Draft };
        Assert.NotNull(await fixture.Reader.ReadAsync(Request([1], ArticleGraphMetadataSelection.Publication)));
    }

    [Fact]
    public async Task CurrentFactsRefuseBrokenPublicationPointersAndAllowAnActuallyAbsentPublication()
    {
        var fixture = new Fixture { ChangeRow = row => row with { PublicationRevisionId = null } };
        Assert.Null(await fixture.Reader.ReadAsync(Request([1])));
        fixture.ChangeRow = row => row with { PublicationRecordRevisionNo = 9 };
        Assert.Null(await fixture.Reader.ReadAsync(Request([1])));
        fixture.ChangeRow = row => row with
        {
            CurrentPublicationId = null,
            PublicationNo = null,
            PublicationRevisionId = null,
            PublicationRevisionNo = null,
            PublicationRecordRevisionNo = null
        };
        ArticleGraphPersistedMetadataResult result = Assert.IsType<ArticleGraphPersistedMetadataResult>(
            await fixture.Reader.ReadAsync(Request([1])));
        ArticleGraphPersistedMetadataFact fact = Assert.Single(result.Facts);
        Assert.Equal(101, fact.Source.RevisionId);
        Assert.Null(fact.CurrentPublicationId);
        Assert.Null(fact.PublicationRevisionId);
    }

    [Theory]
    [InlineData("revision")]
    [InlineData("publication")]
    [InlineData("category")]
    [InlineData("tags")]
    public async Task PointerAndMembershipDriftRefusesTheEntireBatch(string field)
    {
        var fixture = new Fixture();
        fixture.ChangeRow = row => fixture.RowReads < 2 ? row : field switch
        {
            "revision" => row with { CurrentRevisionId = 102, SelectedRevisionId = 102 },
            "publication" => row with { CurrentPublicationId = 502 },
            "category" => row with { SelectedCategoryId = 99 },
            _ => row with { SelectedTags = "12" }
        };
        Assert.Null(await fixture.Reader.ReadAsync(Request([1, 2])));
        Assert.Equal(2, fixture.RowReads);
    }

    [Theory]
    [InlineData("owner")]
    [InlineData("site")]
    [InlineData("session")]
    [InlineData("permission")]
    [InlineData("decision")]
    public async Task RevalidatesPermissionContextAndIndividualDecisions(string field)
    {
        var fixture = new Fixture();
        fixture.ChangePermission = snapshot => fixture.PermissionReads < 3 ? snapshot : field switch
        {
            "owner" => snapshot with { Owner = new(42, "primary-site") },
            "site" => snapshot with { SiteRevision = "site:2" },
            "session" => snapshot with { SessionRevision = "session:2" },
            "permission" => snapshot with { PermissionRevision = "permission:2" },
            _ => snapshot with { Decisions = snapshot.Decisions.Select(decision => decision with { CanOpen = false }).ToArray() }
        };
        Assert.Null(await fixture.Reader.ReadAsync(Request([1])));
        Assert.Equal(1, fixture.RowReads);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("article")]
    [InlineData("revision")]
    [InlineData("number")]
    [InlineData("epoch")]
    [InlineData("mapping")]
    [InlineData("identity")]
    public async Task MissingWrongAndDriftingCanonicalMappingsRefuse(string field)
    {
        var fixture = new Fixture();
        fixture.ChangeSource = source => field switch
        {
            "article" => source with { ArticleId = 2 },
            "revision" => source with { RevisionId = 999 },
            "number" => source with { RevisionNo = 999 },
            "epoch" => source with { SourceEpoch = Guid.Empty },
            "identity" => source with { ArticleIdentity = Identity(2) },
            "mapping" when fixture.CoordinateReads == 2 => source with { SourceEpoch = Epoch(2) },
            _ => source
        };
        fixture.OmitLastSource = field == "missing";
        Assert.Null(await fixture.Reader.ReadAsync(Request([1])));
    }

    [Theory]
    [InlineData(IsolationLevel.RepeatableRead)]
    [InlineData(IsolationLevel.Serializable)]
    [InlineData(IsolationLevel.Unspecified)]
    public async Task UnsupportedSnapshotsRefuseBeforePermissionOrMetadata(IsolationLevel isolation)
    {
        var fixture = new Fixture { Isolation = isolation };
        Assert.Null(await fixture.Reader.ReadAsync(Request([1])));
        Assert.Empty(fixture.Events);
    }

    [Fact]
    public async Task AmbientOrHiddenTransactionsRefuseBeforeMetadata()
    {
        var fixture = new Fixture { Ambient = true };
        Assert.Null(await fixture.Reader.ReadAsync(Request([1])));
        Assert.Empty(fixture.Events);
        fixture.Ambient = false;
        fixture.FixedServerTransaction = true;
        Assert.Null(await fixture.Reader.ReadAsync(Request([1])));
        Assert.Empty(fixture.Events);
    }

    [Fact]
    public async Task ReadCommittedCallerRequiresTheSameServerTransactionIncarnation()
    {
        var fixture = new Fixture { CallerTransaction = true, FixedServerTransaction = true };
        Assert.NotNull(await fixture.Reader.ReadAsync(Request([1])));
        fixture = new Fixture { CallerTransaction = true };
        Assert.Null(await fixture.Reader.ReadAsync(Request([1])));
        Assert.Empty(fixture.Events);
    }

    [Fact]
    public async Task ServerConnectionDriftRefusesBeforeMetadata()
    {
        var fixture = new Fixture { ChangeBackend = true };
        Assert.Null(await fixture.Reader.ReadAsync(Request([1])));
        Assert.Empty(fixture.Events);
    }

    [Fact]
    public async Task UsesTwoBoundedBatchesRatherThanPerArticleReads()
    {
        var fixture = new Fixture();
        int[] ids = Enumerable.Range(1, 64).ToArray();
        ArticleGraphPersistedMetadataResult result = Assert.IsType<ArticleGraphPersistedMetadataResult>(
            await fixture.Reader.ReadAsync(Request(ids)));
        Assert.Equal(64, result.Facts.Count);
        Assert.Equal(2, fixture.RowReads);
        Assert.Equal(2, fixture.CoordinateReads);
        Assert.All(fixture.MetadataBatches, batch => Assert.Equal(ids, batch));
        Assert.True(result.ReadOperations <= 26);
    }

    [Fact]
    public async Task OversizedDuplicateAndUnderbudgetRequestsDoNotTouchReaders()
    {
        var fixture = new Fixture();
        Assert.Null(await fixture.Reader.ReadAsync(Request(Enumerable.Range(1, 65).ToArray())));
        Assert.Null(await fixture.Reader.ReadAsync(Request([1, 1])));
        Assert.Null(await fixture.Reader.ReadAsync(Request([1]) with { RemainingReadOperations = 25 }));
        Assert.Empty(fixture.Events);
        Assert.Equal(0, fixture.ProbeReads);
    }

    [Fact]
    public async Task ProductionBatchModeStaysUnavailableUntilCanonicalBatchApiExists()
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IAuthorArticlePinPermissionProjectionProvider permission = Substitute.For<IAuthorArticlePinPermissionProjectionProvider>();
        var reader = new SqlArticleGraphPersistedMetadataReader(db, new(), permission);
        Assert.Null(await reader.ReadAsync(Request([1, 2])));
        Assert.Empty(db.ReceivedCalls());
        Assert.Empty(permission.ReceivedCalls());
    }

    [Fact]
    public async Task ProductionSingleModeStaysUnavailableUntilPermissionSqlCancellationContractExists()
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IAuthorArticlePinPermissionProjectionProvider permission = Substitute.For<IAuthorArticlePinPermissionProjectionProvider>();
        var reader = new SqlArticleGraphPersistedMetadataReader(db, new(), permission);
        Assert.Null(await reader.ReadAsync(Request([1])));
        Assert.Empty(db.ReceivedCalls());
        Assert.Empty(permission.ReceivedCalls());
    }

    [Fact]
    public async Task ProductionCancellationPropagatesBeforeUnavailableAdmission()
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IAuthorArticlePinPermissionProjectionProvider permission = Substitute.For<IAuthorArticlePinPermissionProjectionProvider>();
        var reader = new SqlArticleGraphPersistedMetadataReader(db, new(), permission);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.ReadAsync(Request([1]), cancellation.Token));
        Assert.Empty(db.ReceivedCalls());
        Assert.Empty(permission.ReceivedCalls());
    }

    [Fact]
    public async Task CallerCancellationPropagatesAndDeadlineRefusesWithoutReleasingFacts()
    {
        var fixture = new Fixture();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Reader.ReadAsync(Request([1]), cancellation.Token));
        Assert.Equal(0, fixture.ProbeReads);
        using var duringRead = new CancellationTokenSource();
        fixture.BeforeRows = token =>
        {
            duringRead.Cancel();
            token.ThrowIfCancellationRequested();
            return Task.CompletedTask;
        };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Reader.ReadAsync(Request([1]), duringRead.Token));
        fixture = new Fixture { BeforeRows = token => Task.Delay(Timeout.InfiniteTimeSpan, token) };
        Assert.Null(await fixture.Reader.ReadAsync(Request([1]) with { RemainingMilliseconds = 30 }));
        Assert.Equal(0, fixture.CoordinateReads);
    }

    private static ArticleGraphPersistedMetadataRequest Request(int[] ids,
        ArticleGraphMetadataSelection selection = ArticleGraphMetadataSelection.Current)
        => new(s_owner, Guid.NewGuid(), ids.Select(id => new ArticleRelationArticleCoordinate(id, Identity(id))).ToArray(),
            selection, 64, 250);

    private static string Identity(int id) => $"article:{id:x8}-1111-4111-8111-111111111111";
    private static Guid Epoch(int id) => Guid.Parse($"{id:x8}-3333-4333-8333-333333333333");

    private sealed class Fixture
    {
        internal SqlArticleGraphPersistedMetadataReader Reader { get; }
        internal List<string> Events { get; } = [];
        internal List<int[]> MetadataBatches { get; } = [];
        internal int RowReads { get; private set; }
        internal int CoordinateReads { get; private set; }
        internal int ProbeReads { get; private set; }
        internal int PermissionReads { get; private set; }
        internal ArticleGraphMetadataSelection LastSelection { get; private set; }
        internal IsolationLevel Isolation { get; set; } = IsolationLevel.ReadCommitted;
        internal bool Ambient { get; set; }
        internal bool CallerTransaction { get; set; }
        internal bool FixedServerTransaction { get; set; }
        internal bool ChangeBackend { get; set; }
        internal bool OmitLastRow { get; set; }
        internal bool OmitLastSource { get; set; }
        internal Func<int, AuthorArticlePinPermissionDecision> Decision { get; set; }
            = id => new(id, true, true, $"permission:{id}");
        internal Func<SqlArticleGraphPersistedMetadataReader.Row, SqlArticleGraphPersistedMetadataReader.Row> ChangeRow { get; set; }
            = row => row;
        internal Func<ArticleRelationRevisionCoordinate, ArticleRelationRevisionCoordinate> ChangeSource { get; set; }
            = source => source;
        internal Func<AuthorArticlePinPermissionSnapshot, AuthorArticlePinPermissionSnapshot> ChangePermission { get; set; }
            = snapshot => snapshot;
        internal Func<CancellationToken, Task> BeforeRows { get; set; } = _ => Task.CompletedTask;

        internal Fixture()
        {
            IAuthorArticlePinPermissionProjectionProvider permissions = Substitute.For<IAuthorArticlePinPermissionProjectionProvider>();
            permissions.ResolveAsync(Arg.Any<AuthorArticlePinPermissionBatchRequest>(), Arg.Any<CancellationToken>())
                .Returns(call => Permission(call.Arg<AuthorArticlePinPermissionBatchRequest>()));
            Reader = new(permissions, Probe, Rows, Sources);
        }

        private Task<AuthorArticlePinPermissionSnapshot> Permission(AuthorArticlePinPermissionBatchRequest request)
        {
            PermissionReads++;
            Events.Add(request.ArticleIds.Count == 0 ? "permission:context" : $"permission:{string.Join(',', request.ArticleIds)}");
            var snapshot = new AuthorArticlePinPermissionSnapshot(AuthorArticlePinPermissionSnapshotStatus.Current,
                request.Owner, "permission:1", "site:1", "session:1", request.ArticleIds.Select(Decision).ToArray(), string.Empty);
            snapshot = ChangePermission(snapshot);
            return Task.FromResult(snapshot with { ContentDigest = AuthorArticlePinProjectionContract.ComputePermissionDigest(snapshot) });
        }

        private Task<SqlArticleGraphPersistedMetadataReader.SessionStamp> Probe(CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            ProbeReads++;
            return Task.FromResult(new SqlArticleGraphPersistedMetadataReader.SessionStamp(
                ChangeBackend ? ProbeReads : 1, FixedServerTransaction ? "1" : ProbeReads.ToString(), Isolation, CallerTransaction, Ambient));
        }

        private async Task<SqlArticleGraphPersistedMetadataReader.Row[]> Rows(int[] ids,
            ArticleGraphMetadataSelection selection, CancellationToken token)
        {
            RowReads++;
            LastSelection = selection;
            Events.Add("rows");
            MetadataBatches.Add(ids.ToArray());
            await BeforeRows(token);
            bool current = selection == ArticleGraphMetadataSelection.Current;
            SqlArticleGraphPersistedMetadataReader.Row[] rows = ids.Select(id => ChangeRow(new(id,
                ArticleStatus.Published, false, 100 + id, 10, 500 + id, 5, 50 + id, 5, 5,
                current ? 100 + id : 50 + id, current ? 10 : 5,
                current ? 7 : 3, current ? "9,11" : "2,4"))).ToArray();
            return OmitLastRow ? rows[..^1] : rows;
        }

        private Task<ArticleRelationRevisionCoordinate[]> Sources(SqlArticleGraphPersistedMetadataReader.Row[] rows, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            CoordinateReads++;
            Events.Add("coordinates");
            ArticleRelationRevisionCoordinate[] sources = rows.Select(row => ChangeSource(new(row.ArticleId,
                row.SelectedRevisionId, row.SelectedRevisionNo, Identity(row.ArticleId),
                $"revision:{row.SelectedRevisionId:x8}-2222-4222-8222-222222222222", Epoch(row.ArticleId)))).ToArray();
            return Task.FromResult(OmitLastSource ? sources[..^1] : sources);
        }
    }
}
