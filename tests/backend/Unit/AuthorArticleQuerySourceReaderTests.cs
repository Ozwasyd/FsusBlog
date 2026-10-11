using System.Data;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Background;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Exercises the original source reader with ADO rows; no database or admission qualification.</summary>
[Trait("Category", "Unit")]
public sealed class AuthorArticleQuerySourceReaderTests
{
    [Theory]
    [InlineData(AuthorArticleQueryStatus.Draft)]
    [InlineData(AuthorArticleQueryStatus.Scheduled)]
    [InlineData(AuthorArticleQueryStatus.Published)]
    [InlineData(AuthorArticleQueryStatus.Archived)]
    public async Task Coordinates_PreserveExistingLifecycleAndVersion(AuthorArticleQueryStatus status)
    {
        DataTable rows = Coordinates();
        rows.Rows.Add(71, 901L, "row-71", (int)status);
        var fixture = new ReaderFixture(rows);

        AuthorArticleQuerySourceBatch batch = await fixture.Source.ReadCoordinatesAsync([status], default);

        Assert.Equal(new AuthorArticleQuerySourceCoordinate(71, 901, "row-71", status),
            Assert.Single(batch.Coordinates));
        Assert.False(batch.HasMore);
        Assert.Equal(new[] { (int)status }, fixture.Statuses());
        Assert.Contains("isdeleted = false", fixture.CommandText, StringComparison.Ordinal);
        Assert.Equal(AuthorArticleQuerySourceInspection.MaxBatchSize + 1,
            Assert.IsType<int>(fixture.Parameter("@Limit").Value));
        Assert.True(fixture.Reader!.IsClosed);
    }

    [Fact]
    public async Task Fields_PreserveDistinctArchivedIdsAndRealMetadata()
    {
        DataTable rows = Fields();
        rows.Rows.Add(71, 901L, "row-71", (int)ArticleStatus.Archived,
            "same title", "category-a", new[] { "tag-a", "tag-b" });
        rows.Rows.Add(72, 902L, "row-72", (int)ArticleStatus.Archived,
            "same title", "category-b", Array.Empty<string>());
        var fixture = new ReaderFixture(rows);

        IReadOnlyList<AuthorArticleQuerySourceFields> fields = await fixture.Source.ReadFieldsAsync([71, 72], default);

        Assert.Equal(new[] { 71, 72 }, fields.Select(static field => field.Coordinate.ArticleId));
        Assert.Equal(new AuthorArticleQuerySourceCoordinate(71, 901, "row-71", AuthorArticleQueryStatus.Archived),
            fields[0].Coordinate);
        Assert.Equal(new AuthorArticleQuerySourceCoordinate(72, 902, "row-72", AuthorArticleQueryStatus.Archived),
            fields[1].Coordinate);
        Assert.All(fields, static field => Assert.Equal("same title", field.Title));
        Assert.Equal("category-a", fields[0].Category);
        Assert.Equal(new[] { "tag-a", "tag-b" }, fields[0].Tags);
        Assert.Equal("category-b", fields[1].Category);
        Assert.Empty(fields[1].Tags);
        Assert.Equal(new[] { 71, 72 }, Assert.IsType<int[]>(fixture.Parameter("@ArticleIds").Value));
        Assert.Equal(new[]
        {
            (int)ArticleStatus.Draft, (int)ArticleStatus.Scheduled,
            (int)ArticleStatus.Published, (int)ArticleStatus.Archived
        }, fixture.Statuses());
        Assert.DoesNotContain((int)ArticleStatus.Deleted, fixture.Statuses());
        Assert.Contains("a.isdeleted = false", fixture.CommandText, StringComparison.Ordinal);
        Assert.True(fixture.Reader!.IsClosed);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(42)]
    public async Task Coordinates_RejectDeletedAndUnknownStatusesBeforeAdo(int status)
    {
        var fixture = new ReaderFixture(Coordinates());

        ArgumentException error = await Assert.ThrowsAsync<ArgumentException>(() =>
            fixture.Source.ReadCoordinatesAsync([(AuthorArticleQueryStatus)status], default));

        Assert.Equal("statuses", error.ParamName);
        await fixture.Ado.DidNotReceive().GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>());
    }

    [Theory]
    [InlineData("empty")]
    [InlineData("zero")]
    [InlineData("negative")]
    [InlineData("duplicate")]
    [InlineData("oversized")]
    public async Task Fields_RejectInvalidAdmittedIdsBeforeAdo(string fault)
    {
        int[] ids = fault switch
        {
            "empty" => [],
            "zero" => [0],
            "negative" => [-1],
            "duplicate" => [71, 71],
            "oversized" => Enumerable.Range(1, AuthorArticleQuerySourceInspection.MaxBatchSize + 1).ToArray(),
            _ => throw new ArgumentException(nameof(fault))
        };
        var fixture = new ReaderFixture(Fields());

        ArgumentException error = await Assert.ThrowsAsync<ArgumentException>(() =>
            fixture.Source.ReadFieldsAsync(ids, default));

        Assert.Equal("admittedArticleIds", error.ParamName);
        await fixture.Ado.DidNotReceive().GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>());
    }

    [Fact]
    public async Task Coordinates_ArchivedOverflowRemainsBounded()
    {
        DataTable rows = Coordinates();
        for (int id = 1; id <= AuthorArticleQuerySourceInspection.MaxBatchSize + 1; id++)
        {
            rows.Rows.Add(id, id * 10L, $"row-{id}", (int)ArticleStatus.Archived);
        }
        var fixture = new ReaderFixture(rows);

        AuthorArticleQuerySourceBatch batch = await fixture.Source.ReadCoordinatesAsync(
            [AuthorArticleQueryStatus.Archived], default);

        Assert.True(batch.HasMore);
        Assert.Equal(AuthorArticleQuerySourceInspection.MaxBatchSize, batch.Coordinates.Count);
        Assert.Equal(AuthorArticleQuerySourceInspection.MaxBatchSize, batch.Coordinates[^1].ArticleId);
        Assert.All(batch.Coordinates, static row => Assert.Equal(AuthorArticleQueryStatus.Archived, row.Status));
        Assert.True(fixture.Reader!.IsClosed);
    }

    [Fact]
    public async Task Coordinates_EmptyScopeDoesNotReadAdo()
    {
        var fixture = new ReaderFixture(Coordinates());

        AuthorArticleQuerySourceBatch batch = await fixture.Source.ReadCoordinatesAsync([], default);

        Assert.Empty(batch.Coordinates);
        Assert.False(batch.HasMore);
        await fixture.Ado.DidNotReceive().GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CanceledProjection_DisposesAdoReaderWithoutReturningRows(bool fields)
    {
        var fixture = new ReaderFixture(fields ? Fields() : Coordinates());
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        if (fields)
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                fixture.Source.ReadFieldsAsync([71], cancellation.Token));
        }
        else
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                fixture.Source.ReadCoordinatesAsync([AuthorArticleQueryStatus.Archived], cancellation.Token));
        }
        Assert.True(fixture.Reader!.IsClosed);
    }

    [Fact]
    public async Task HistoryCoordinates_PreserveExactRequestedIdsAndLiveRevisions()
    {
        DataTable rows = Coordinates();
        rows.Rows.Add(2001, 901L, "row-2001", (int)ArticleStatus.Published);
        var fixture = new ReaderFixture(rows);

        AuthorArticleQuerySourceBatch batch = await fixture.Source.ReadCoordinatesForIdsAsync(
            [AuthorArticleQueryStatus.Published], [2001, 3001], default);

        Assert.Equal(new AuthorArticleQuerySourceCoordinate(2001, 901, "row-2001", AuthorArticleQueryStatus.Published),
            Assert.Single(batch.Coordinates));
        Assert.False(batch.HasMore);
        Assert.Equal(new[] { 2001, 3001 }, Assert.IsType<int[]>(fixture.Parameter("@ArticleIds").Value));
        Assert.Equal(new[] { (int)ArticleStatus.Published }, fixture.Statuses());
        Assert.Contains("id = ANY(@ArticleIds)", fixture.CommandText, StringComparison.Ordinal);
        Assert.Contains("isdeleted = false", fixture.CommandText, StringComparison.Ordinal);
        Assert.True(fixture.Reader!.IsClosed);
    }

    [Theory]
    [InlineData("empty")]
    [InlineData("zero")]
    [InlineData("negative")]
    [InlineData("duplicate")]
    [InlineData("oversized")]
    public async Task HistoryCoordinates_RejectInvalidIdsBeforeAdo(string fault)
    {
        int[] ids = fault switch
        {
            "empty" => [],
            "zero" => [0],
            "negative" => [-1],
            "duplicate" => [71, 71],
            "oversized" => Enumerable.Range(1, AuthorArticleQuerySourceInspection.MaxBatchSize + 1).ToArray(),
            _ => throw new ArgumentException(nameof(fault))
        };
        var fixture = new ReaderFixture(Coordinates());

        ArgumentException error = await Assert.ThrowsAsync<ArgumentException>(() =>
            fixture.Source.ReadCoordinatesForIdsAsync([AuthorArticleQueryStatus.Draft], ids, default));

        Assert.Equal("articleIds", error.ParamName);
        await fixture.Ado.DidNotReceive().GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>());
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(42)]
    public async Task HistoryCoordinates_RejectDeletedAndUnknownStatusesBeforeAdo(int status)
    {
        var fixture = new ReaderFixture(Coordinates());

        ArgumentException error = await Assert.ThrowsAsync<ArgumentException>(() =>
            fixture.Source.ReadCoordinatesForIdsAsync([(AuthorArticleQueryStatus)status], [71], default));

        Assert.Equal("statuses", error.ParamName);
        await fixture.Ado.DidNotReceive().GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>());
    }

    [Fact]
    public async Task HistoryCoordinates_EmptyScopeDoesNotReadAdo()
    {
        var fixture = new ReaderFixture(Coordinates());

        AuthorArticleQuerySourceBatch batch = await fixture.Source.ReadCoordinatesForIdsAsync([], [71], default);

        Assert.Empty(batch.Coordinates);
        Assert.False(batch.HasMore);
        await fixture.Ado.DidNotReceive().GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>());
    }

    [Fact]
    public async Task HistoryCoordinates_CancellationDisposesReader()
    {
        var fixture = new ReaderFixture(Coordinates());
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Source.ReadCoordinatesForIdsAsync(
            [AuthorArticleQueryStatus.Draft], [71], cancellation.Token));

        Assert.True(fixture.Reader!.IsClosed);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(1000)]
    [InlineData(1001)]
    [InlineData(10000)]
    public async Task Continuation_TracesEverySparseIdInBoundedOrderedPages(int count)
    {
        var fixture = PagedFixture(count);
        var ids = new List<int>();
        int afterArticleId = 0;
        int calls = 0;
        AuthorArticleQuerySourceBatch page;
        do
        {
            page = await fixture.Source.ReadCoordinatesAfterAsync([AuthorArticleQueryStatus.Draft], afterArticleId, default);
            calls++;
            Assert.InRange(page.Coordinates.Count, 0, AuthorArticleQuerySourceInspection.MaxBatchSize);
            Assert.All(page.Coordinates, row => Assert.True(row.ArticleId > afterArticleId));
            Assert.Equal(afterArticleId, Assert.IsType<int>(fixture.Parameter("@AfterArticleId").Value));
            Assert.Contains("id > @AfterArticleId", fixture.CommandText, StringComparison.Ordinal);
            Assert.Contains("isdeleted = false", fixture.CommandText, StringComparison.Ordinal);
            Assert.Equal(AuthorArticleQuerySourceInspection.MaxBatchSize + 1,
                Assert.IsType<int>(fixture.Parameter("@Limit").Value));
            Assert.True(fixture.Reader!.IsClosed);
            ids.AddRange(page.Coordinates.Select(static row => row.ArticleId));
            if (page.HasMore)
            {
                int next = Assert.IsType<int>(page.NextAfterArticleId);
                Assert.Equal(page.Coordinates[^1].ArticleId, next);
                Assert.True(next > afterArticleId);
                afterArticleId = next;
            }
            else
            {
                Assert.Null(page.NextAfterArticleId);
            }
        }
        while (page.HasMore);

        Assert.Equal(Enumerable.Range(1, count).Select(static id => id * 2), ids);
        Assert.Equal(Math.Max(1, (count + AuthorArticleQuerySourceInspection.MaxBatchSize - 1)
            / AuthorArticleQuerySourceInspection.MaxBatchSize), calls);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(int.MinValue)]
    public async Task Continuation_RejectsNegativePositionBeforeAdo(int afterArticleId)
    {
        var fixture = new ReaderFixture(Coordinates());

        ArgumentOutOfRangeException error = await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            fixture.Source.ReadCoordinatesAfterAsync([AuthorArticleQueryStatus.Draft], afterArticleId, default));

        Assert.Equal("afterArticleId", error.ParamName);
        await fixture.Ado.DidNotReceive().GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>());
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(42)]
    public async Task Continuation_RejectsDeletedAndUnknownStatusBeforeAdo(int status)
    {
        var fixture = new ReaderFixture(Coordinates());

        ArgumentException error = await Assert.ThrowsAsync<ArgumentException>(() =>
            fixture.Source.ReadCoordinatesAfterAsync([(AuthorArticleQueryStatus)status], 2000, default));

        Assert.Equal("statuses", error.ParamName);
        await fixture.Ado.DidNotReceive().GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>());
    }

    [Fact]
    public async Task Continuation_EmptyScopeDoesNotReadAdo()
    {
        var fixture = new ReaderFixture(Coordinates());

        AuthorArticleQuerySourceBatch page = await fixture.Source.ReadCoordinatesAfterAsync([], 2000, default);

        Assert.Empty(page.Coordinates);
        Assert.False(page.HasMore);
        Assert.Null(page.NextAfterArticleId);
        await fixture.Ado.DidNotReceive().GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>());
    }

    [Fact]
    public async Task Continuation_FirstPageUsesOriginalCoordinateOwner()
    {
        var fixture = PagedFixture(1);

        AuthorArticleQuerySourceBatch first = await fixture.Source.ReadCoordinatesAsync([AuthorArticleQueryStatus.Draft], default);
        AuthorArticleQuerySourceBatch explicitFirst = await fixture.Source.ReadCoordinatesAfterAsync([AuthorArticleQueryStatus.Draft], 0, default);

        Assert.Equal(first.Coordinates, explicitFirst.Coordinates);
        Assert.Equal(first.HasMore, explicitFirst.HasMore);
        Assert.Equal(0, fixture.Parameter("@AfterArticleId").Value);
    }

    [Fact]
    public async Task Continuation_InterruptedReadDisposesReaderAndCanResumeSamePosition()
    {
        var fixture = PagedFixture(1001);
        AuthorArticleQuerySourceBatch first = await fixture.Source.ReadCoordinatesAsync([AuthorArticleQueryStatus.Draft], default);
        int position = Assert.IsType<int>(first.NextAfterArticleId);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            fixture.Source.ReadCoordinatesAfterAsync([AuthorArticleQueryStatus.Draft], position, cancellation.Token));
        Assert.True(fixture.Reader!.IsClosed);
        AuthorArticleQuerySourceBatch resumed = await fixture.Source.ReadCoordinatesAfterAsync(
            [AuthorArticleQueryStatus.Draft], position, default);

        Assert.Equal(2002, Assert.Single(resumed.Coordinates).ArticleId);
        Assert.False(resumed.HasMore);
        Assert.Null(resumed.NextAfterArticleId);
        Assert.True(fixture.Reader!.IsClosed);
    }

    [Theory]
    [InlineData("ids")]
    [InlineData("statuses")]
    [InlineData("oversized-ids")]
    public async Task HistoryCoordinates_OwnsInputsWhileOriginalGateWaits(string mutation)
    {
        var gate = new PausedGate();
        DataTable rows = Coordinates();
        rows.Rows.Add(7, 70L, "row-7", 0);
        var fixture = new ReaderFixture(rows, gate);
        List<int> ids = [7];
        AuthorArticleQueryStatus[] statuses = [AuthorArticleQueryStatus.Draft];
        Task<AuthorArticleQuerySourceBatch> pending = fixture.Source.ReadCoordinatesForIdsAsync(statuses, ids, default);
        try
        {
            await gate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            if (mutation == "ids")
            {
                ids[0] = 8;
            }
            else if (mutation == "statuses")
            {
                statuses[0] = (AuthorArticleQueryStatus)4;
            }
            else
            {
                ids.AddRange(Enumerable.Range(8, AuthorArticleQuerySourceInspection.MaxBatchSize));
            }
        }
        finally
        {
            gate.Release.TrySetResult();
        }
        AuthorArticleQuerySourceBatch batch = await pending.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(new[] { 7 }, batch.Coordinates.Select(static coordinate => coordinate.ArticleId));
        Assert.Equal(new[] { 7 }, Assert.IsType<int[]>(fixture.Parameter("@ArticleIds").Value));
        Assert.Equal(new[] { 0 }, fixture.Statuses());
    }

    [Fact]
    public async Task Fields_OwnsIdsWhileOriginalGateWaits()
    {
        var gate = new PausedGate();
        DataTable rows = Fields();
        rows.Rows.Add(7, 70L, "row-7", 0, "title", "category", new[] { "tag" });
        var fixture = new ReaderFixture(rows, gate);
        int[] ids = [7];
        Task<IReadOnlyList<AuthorArticleQuerySourceFields>> pending = fixture.Source.ReadFieldsAsync(ids, default);
        try
        {
            await gate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            ids[0] = 8;
        }
        finally
        {
            gate.Release.TrySetResult();
        }
        IReadOnlyList<AuthorArticleQuerySourceFields> fields = await pending.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(7, Assert.Single(fields).Coordinate.ArticleId);
        Assert.Equal(new[] { 7 }, Assert.IsType<int[]>(fixture.Parameter("@ArticleIds").Value));
    }

    [Fact]
    public async Task Continuation_OwnsStatusesWhileOriginalGateWaits()
    {
        var gate = new PausedGate();
        var fixture = new ReaderFixture(Coordinates(), gate);
        AuthorArticleQueryStatus[] statuses = [AuthorArticleQueryStatus.Draft];
        Task<AuthorArticleQuerySourceBatch> pending = fixture.Source.ReadCoordinatesAfterAsync(statuses, 7, default);
        try
        {
            await gate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            statuses[0] = (AuthorArticleQueryStatus)4;
        }
        finally
        {
            gate.Release.TrySetResult();
        }
        await pending.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(new[] { 0 }, fixture.Statuses());
        Assert.Equal(7, fixture.Parameter("@AfterArticleId").Value);
    }

    private sealed class PausedGate : IDbConcurrencyGate
    {
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public DbConcurrencyGateSnapshot GetSnapshot() => new(1, 0, 0);

        public async Task<T> ExecuteAsync<T>(string operation, Func<CancellationToken, Task<T>> action,
            Func<CancellationToken, Task<T>> onTimeout, CancellationToken cancellationToken = default)
        {
            Entered.TrySetResult();
            await Release.Task.WaitAsync(cancellationToken);
            return await action(cancellationToken);
        }
    }

    private static ReaderFixture PagedFixture(int count)
    {
        var fixture = new ReaderFixture(Coordinates());
        fixture.RowsForCommand = parameters =>
        {
            int after = Assert.IsType<int>(Assert.Single(parameters,
                parameter => parameter.ParameterName == "@AfterArticleId").Value);
            int limit = Assert.IsType<int>(Assert.Single(parameters,
                parameter => parameter.ParameterName == "@Limit").Value);
            DataTable rows = Coordinates();
            foreach (int id in Enumerable.Range(1, count).Select(static id => id * 2).Where(id => id > after).Take(limit))
            {
                rows.Rows.Add(id, id * 10L, $"row-{id}", (int)ArticleStatus.Draft);
            }
            return rows;
        };
        return fixture;
    }

    private static DataTable Coordinates()
    {
        var table = new DataTable();
        table.Columns.Add("id", typeof(int));
        table.Columns.Add("current_revision_id", typeof(long));
        table.Columns.Add("row_version", typeof(string));
        table.Columns.Add("status", typeof(int));
        return table;
    }

    private static DataTable Fields()
    {
        DataTable table = Coordinates();
        table.Columns.Add("title", typeof(string));
        table.Columns.Add("category_name", typeof(string));
        table.Columns.Add("tag_names", typeof(string[]));
        return table;
    }

    private sealed class ReaderFixture
    {
        public IAdo Ado { get; } = Substitute.For<IAdo>();
        public IAuthorArticleQuerySourceReader Source
        {
            get;
        }
        public string CommandText { get; private set; } = string.Empty;
        public SugarParameter[] Parameters { get; private set; } = [];
        public Func<SugarParameter[], DataTable>? RowsForCommand
        {
            get; set;
        }
        public DataTableReader? Reader
        {
            get; private set;
        }

        public ReaderFixture(DataTable rows, IDbConcurrencyGate? gate = null)
        {
            var db = Substitute.For<ISqlSugarClient>();
            db.Ado.Returns(Ado);
            Ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(call =>
            {
                CommandText = call.ArgAt<string>(0);
                Parameters = call.ArgAt<SugarParameter[]>(1);
                Reader = (RowsForCommand?.Invoke(Parameters) ?? rows).CreateDataReader();
                return Task.FromResult((IDataReader)Reader);
            });
            Source = new ArticleService(
                _db: db,
                _searchIndex: Substitute.For<ISearchIndexService>(),
                _redisOperations: Substitute.For<IRedisOperationExecutor>(),
                _cacheReader: Substitute.For<ICacheTypedReader>(),
                _cacheWriter: Substitute.For<ICacheRawWriter>(),
                _stringReader: Substitute.For<ICacheStringReader>(),
                _stringWriter: Substitute.For<ICacheStringWriter>(),
                _cacheMissCoordinator: Substitute.For<ICacheMissCoordinator>(),
                _dbConcurrencyGate: gate ?? new ImmediateDbConcurrencyGate(),
                _runtimeKeyScope: Substitute.For<IRuntimeKeyScope>(),
                _httpContextAccessor: Substitute.For<IHttpContextAccessor>(),
                _logger: NullLogger<ArticleService>.Instance,
                _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(),
                _cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
                _mutationFence: Substitute.For<IArticlePublicMutationFence>(),
                _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>(),
                _viewWriteBuffer: Substitute.For<IArticleViewWriteBuffer>(),
                _publicationValidator: ArticlePublicationValidatorTestFactory.CreateAllowing(),
                _articleBodyRepairQueue: new ArticleBodyRepairQueue());
        }

        public SugarParameter Parameter(string name)
            => Assert.Single(Parameters, parameter => parameter.ParameterName == name);

        public int[] Statuses()
        {
            SugarParameter parameter = Parameter("@Statuses");
            Assert.True(parameter.IsArray);
            return Assert.IsType<int[]>(parameter.Value);
        }
    }
}
