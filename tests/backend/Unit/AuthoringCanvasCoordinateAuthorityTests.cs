using System.Data;
using System.Data.Common;
using System.Diagnostics.CodeAnalysis;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Authoring;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthoringCanvasCoordinateAuthorityTests
{
    private const string CanvasDigest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private static readonly AuthoringCanvasOwner s_owner = new(61, "primary-site");

    [Fact]
    public void Scan_ResolvesLineEndHeadingAndBlockAnchorsWithBoundedContext()
    {
        IReadOnlyDictionary<string, AuthoringCanvasAnchorObservation> anchors =
            AuthoringCanvasAnchorSourceProjection.Scan(
                "# Overview ^doc-head\n\nIntro paragraph ^intro-block\n");

        AuthoringCanvasAnchorObservation heading = Assert.Single(anchors.Values, static value => value.OwnsHeading);
        Assert.Equal("doc-head", anchors.Single(pair => pair.Value == heading).Key);
        Assert.Equal(1, heading.ClaimCount);
        Assert.Equal("Overview", heading.ContextText);

        AuthoringCanvasAnchorObservation block = anchors["intro-block"];
        Assert.Equal(1, block.ClaimCount);
        Assert.False(block.OwnsHeading);
        Assert.Equal("Intro paragraph", block.ContextText);
    }

    [Fact]
    public void Scan_ResolvesExclusiveLineAnchorsOnlyAfterAtomicOwners()
    {
        IReadOnlyDictionary<string, AuthoringCanvasAnchorObservation> anchors =
            AuthoringCanvasAnchorSourceProjection.Scan(
                "| a | b |\n^tbl-anchor\n\nparagraph\n^para-orphan\n\n```csharp\nvar x = 1;\n```\n^code-anchor\n");

        Assert.True(anchors["tbl-anchor"].ClaimCount == 1);
        Assert.Equal("| a | b |", anchors["tbl-anchor"].ContextText);
        Assert.True(anchors["code-anchor"].ClaimCount == 1);
        Assert.Equal("var x = 1;", anchors["code-anchor"].ContextText);
        Assert.False(anchors.ContainsKey("para-orphan"));
    }

    [Fact]
    public void Scan_IgnoresMarkersInsideFencedOrphanAndMalformedPositions()
    {
        IReadOnlyDictionary<string, AuthoringCanvasAnchorObservation> anchors =
            AuthoringCanvasAnchorSourceProjection.Scan(
                "^orphan-first\n\n```\n^inside-fence\n```\n\n## Heading\n^after-heading\n\ntext\n\n^after-gap\n");

        Assert.Empty(anchors);
    }

    [Fact]
    public void Scan_CountsRepeatedClaimsInsteadOfFirstMatching()
    {
        IReadOnlyDictionary<string, AuthoringCanvasAnchorObservation> anchors =
            AuthoringCanvasAnchorSourceProjection.Scan(
                "First ^dup-anchor\n\nSecond ^dup-anchor\n");

        Assert.Equal(2, anchors["dup-anchor"].ClaimCount);
    }

    [Fact]
    public void Scan_TreatsInvalidGrammarAndMidTextMarkersAsNonAnchors()
    {
        IReadOnlyDictionary<string, AuthoringCanvasAnchorObservation> anchors =
            AuthoringCanvasAnchorSourceProjection.Scan(
                "x ^Upper-Case\n\ny^not-marker\n\nz ^x\n");

        Assert.False(anchors.ContainsKey("Upper-Case"));
        Assert.False(anchors.ContainsKey("not-marker"));
        Assert.True(anchors["x"].ClaimCount == 1);
    }

    [Fact]
    public void Scan_AcceptsSingleSpaceExclusiveMarkerAndHeadingOwner()
    {
        IReadOnlyDictionary<string, AuthoringCanvasAnchorObservation> anchors =
            AuthoringCanvasAnchorSourceProjection.Scan(
                "## Named ^space-anchor\n\npara\r\n## Next\r\n ^crlf-anchor\r\n");

        Assert.True(anchors["space-anchor"].ClaimCount == 1);
        Assert.True(anchors["crlf-anchor"].OwnsHeading);
        Assert.Equal("Next", anchors["crlf-anchor"].ContextText);
    }

    [Fact]
    public void Scan_BoundsContextSnippetAndDropsMarkupPayload()
    {
        string longText = new('x', AuthoringCanvasReferenceContract.MaxContextSnippetLength + 40);
        IReadOnlyDictionary<string, AuthoringCanvasAnchorObservation> anchors =
            AuthoringCanvasAnchorSourceProjection.Scan(
                $"{longText} ^long-anchor\n\nvalue <script> ^html-anchor\n");

        Assert.Equal(
            AuthoringCanvasReferenceContract.MaxContextSnippetLength,
            anchors["long-anchor"].ContextText!.Length);
        Assert.True(anchors["html-anchor"].ClaimCount == 1);
        Assert.Null(anchors["html-anchor"].ContextText);
    }

    [Fact]
    public async Task Authority_RejectsInvalidQueryShapesBeforeAnyRead()
    {
        var authority = new PostgresAuthoringCanvasCoordinateAuthority(Substitute.For<ISqlSugarClient>());

        await Assert.ThrowsAsync<ArgumentNullException>(() => authority.ReadBatchAsync(null!));

        AuthoringCanvasReferenceTarget[] oversized = Enumerable
            .Range(0, AuthoringCanvasReferenceContract.MaxBatchSize + 1)
            .Select(index => Target(AuthoringCanvasNodeType.BlockReference, block: $"b-{index}"))
            .ToArray();
        await Assert.ThrowsAsync<AuthoringCanvasBudgetExceededException>(
            () => authority.ReadBatchAsync(Query(oversized)));

        AuthoringCanvasValidationException articleNode = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => authority.ReadBatchAsync(Query([Target(AuthoringCanvasNodeType.ArticleReference)])));
        Assert.Equal("canvas_reference_coordinate_query_invalid", articleNode.Code);

        var wrongShape = new AuthoringCanvasReferenceTarget(
            Guid.CreateVersion7(),
            AuthoringCanvasNodeType.HeadingReference,
            101,
            null,
            "b-1",
            null,
            null);
        AuthoringCanvasValidationException wrongIdentity = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => authority.ReadBatchAsync(Query([wrongShape])));
        Assert.Equal("canvas_reference_coordinate_query_invalid", wrongIdentity.Code);

        Guid duplicateId = Guid.CreateVersion7();
        AuthoringCanvasReferenceTarget[] duplicated =
        [
            Target(AuthoringCanvasNodeType.BlockReference, duplicateId, "b-1"),
            Target(AuthoringCanvasNodeType.BlockReference, duplicateId, "b-2")
        ];
        AuthoringCanvasValidationException duplicate = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => authority.ReadBatchAsync(Query(duplicated)));
        Assert.Equal("canvas_reference_coordinate_query_invalid", duplicate.Code);
    }

    [Fact]
    public async Task Authority_ReturnsEmptyForEmptyTargetsWithoutIssuingReads()
    {
        var authority = new PostgresAuthoringCanvasCoordinateAuthority(Substitute.For<ISqlSugarClient>());

        IReadOnlyDictionary<Guid, AuthoringCanvasCoordinateFact> facts =
            await authority.ReadBatchAsync(Query([]));

        Assert.Empty(facts);
    }

    [Theory]
    [InlineData("$$\nHidden ^inside\n$$\nVisible ^outside", "outside", 1, "Visible")]
    [InlineData("$$unclosed\nVisible ^inside", "inside", 1, "Visible")]
    [InlineData(":::note\nHidden ^inside\n:::\nVisible ^outside", "outside", 1, "Visible")]
    [InlineData(":::note\nVisible ^inside", "inside", 1, "Visible")]
    [InlineData("$$unclosed\n:::note\nHidden ^inside\n:::\nVisible ^outside", "outside", 1, "Visible")]
    [InlineData(":::note\n$$unclosed\nHidden ^inside\n:::\nVisible ^outside", "outside", 1, "Visible")]
    [InlineData("$$\n\u0060\u0060\u0060lang\nHidden ^inside\n$$\nVisible ^outside", "outside", 1, "Visible")]
    [InlineData("\u0060\u0060\u0060\u0060lang\nHidden ^inside\n\u0060\u0060\u0060\nHidden ^inside\n\u0060\u0060\u0060\u0060\nVisible ^outside", "outside", 1, "Visible")]
    [InlineData("\u0060\u0060\u0060unclosed\nHidden ^inside", "", 0, null)]
    [InlineData(":::unclosed\n$$unclosed\nFirst ^inside\nSecond ^inside", "inside", 2, "First")]
    [InlineData("   ::widget[data]\n^inside", "inside", 1, "::widget[data]")]
    [InlineData("    :::note\nVisible ^inside\n:::", "inside", 1, "Visible")]
    [InlineData("paragraph\n ^inside", "inside", 1, "paragraph")]
    [InlineData("paragraph\n^inside", "", 0, null)]
    [InlineData("text ^Upper-Case\ntext^inside", "", 0, null)]
    [InlineData("## Named\r\n ^inside\r\n", "inside", 1, "Named")]
    public async Task StreamedScan_PreservesAtomicAndMalformedSourceGrammar(
        string source, string identity, int claims, string? context)
    {
        using var reader = new SegmentedReader(1, (source, 1));
        AuthoringCanvasAnchorSourceProjection.ScanResult result =
            await AuthoringCanvasAnchorSourceProjection.ScanAsync(reader, ["inside", "outside"]);
        Assert.Equal(source.Length, result.SourceCharacters);
        if (identity.Length == 0)
        {
            Assert.Empty(result.Anchors);
        }
        else
        {
            KeyValuePair<string, AuthoringCanvasAnchorObservation> actual = Assert.Single(result.Anchors);
            Assert.Equal(identity, actual.Key);
            Assert.Equal(claims, actual.Value.ClaimCount);
            Assert.Equal(context, actual.Value.ContextText);
        }
    }

    [Fact]
    public async Task StreamedScan_ReadsHugeLineWithoutWholeLineBufferAndFindsLateUnsafeText()
    {
        using var reader = new SegmentedReader(17,
            ("x", 100_000), (" ^large\n", 1),
            ("x", 100_000), ("< ^unsafe\n", 1),
            ("##", 1), (" ", 100_000), ("Heading ^heading", 1));
        AuthoringCanvasAnchorSourceProjection.ScanResult result =
            await AuthoringCanvasAnchorSourceProjection.ScanAsync(reader, ["large", "unsafe", "heading"]);
        Assert.Equal(new string('x', AuthoringCanvasReferenceContract.MaxContextSnippetLength),
            result.Anchors["large"].ContextText);
        Assert.Null(result.Anchors["unsafe"].ContextText);
        Assert.True(result.Anchors["heading"].OwnsHeading);
        Assert.Equal("Heading", result.Anchors["heading"].ContextText);
        Assert.InRange(reader.MaximumReadRequest, 1, AuthoringCanvasReferenceContract.MaxContextSnippetLength);
        Assert.Equal(reader.TotalCharacters, result.SourceCharacters);
    }

    [Fact]
    public async Task StreamedScan_HandlesLongFenceRunAndAtomicTokenWithoutStoringOpeningLine()
    {
        using var reader = new SegmentedReader(13,
            ("~", 100_000), ("\nHidden ^inside\n", 1),
            ("~", 99_999), ("\nStill hidden ^inside\n", 1),
            ("~", 100_000), ("\n::", 1), ("widget-", 100_000),
            ("[data]\n^outside", 1));
        AuthoringCanvasAnchorSourceProjection.ScanResult result =
            await AuthoringCanvasAnchorSourceProjection.ScanAsync(reader, ["inside", "outside"]);
        Assert.Equal("outside", Assert.Single(result.Anchors).Key);
        Assert.Equal(1, result.Anchors["outside"].ClaimCount);
        Assert.Equal(AuthoringCanvasReferenceContract.MaxContextSnippetLength,
            result.Anchors["outside"].ContextText!.Length);
    }

    [Fact]
    public async Task StreamedScan_ManyUnclosedOpenersPreserveRequestedDuplicateClaims()
    {
        using var reader = new SegmentedReader(19,
            ("First ^wanted\n", 1),
            (":::note\n$$unclosed\nClaim ^wanted\nOther ^unrequested\n", 20_000));
        AuthoringCanvasAnchorSourceProjection.ScanResult result =
            await AuthoringCanvasAnchorSourceProjection.ScanAsync(reader, ["wanted"]);
        AuthoringCanvasAnchorObservation anchor = Assert.Single(result.Anchors).Value;
        Assert.Equal(20_001, anchor.ClaimCount);
        Assert.Equal("First", anchor.ContextText);
        Assert.False(anchor.OwnsHeading);
    }

    [Fact]
    public async Task StreamedScan_DiscardsClosedTentativeClaimsButKeepsEarlierClaimAndLateDuplicate()
    {
        using var reader = new SegmentedReader(1,
            ("First ^wanted\n:::note\n$$unclosed\nHidden ^wanted\n:::\nLast ^wanted", 1));
        AuthoringCanvasAnchorSourceProjection.ScanResult result =
            await AuthoringCanvasAnchorSourceProjection.ScanAsync(reader, ["wanted"]);
        AuthoringCanvasAnchorObservation anchor = Assert.Single(result.Anchors).Value;
        Assert.Equal(2, anchor.ClaimCount);
        Assert.Equal("First", anchor.ContextText);
    }

    [Fact]
    public async Task StreamedScan_PreservesMaximumIdentityAndContextBeforeBareClosingOwner()
    {
        string identity = new('a', 64);
        using var reader = new SegmentedReader(7,
            ("\u0060\u0060\u0060lang\nContent\n\u0060\u0060\u0060\n^", 1), (identity, 1));
        AuthoringCanvasAnchorSourceProjection.ScanResult result =
            await AuthoringCanvasAnchorSourceProjection.ScanAsync(reader, [identity]);
        KeyValuePair<string, AuthoringCanvasAnchorObservation> anchor = Assert.Single(result.Anchors);
        Assert.Equal(identity, anchor.Key);
        Assert.Equal("Content", anchor.Value.ContextText);
    }

    [Fact]
    public async Task StreamedScan_PreservesTrimmedUnsafeWhitespaceAndHeadingRules()
    {
        using var reader = new SegmentedReader(3,
            (" \v# \vHeading \v ^heading\nx\v y ^unsafe\nx\t y ^safe", 1));
        AuthoringCanvasAnchorSourceProjection.ScanResult result =
            await AuthoringCanvasAnchorSourceProjection.ScanAsync(reader, ["heading", "unsafe", "safe"]);
        Assert.Equal("Heading", result.Anchors["heading"].ContextText);
        Assert.False(result.Anchors["heading"].OwnsHeading);
        Assert.Null(result.Anchors["unsafe"].ContextText);
        Assert.Equal("x\t y", result.Anchors["safe"].ContextText);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(10_000)]
    public async Task StreamedScan_SupportsOriginalFullRequestedIdentityRange(int count)
    {
        string[] identities = Enumerable.Range(0, count).Select(index => $"ref-{index}").ToArray();
        (string Text, long Repetitions)[] segments = identities
            .Select(identity => ($"Owner ^{identity}\n", 1L)).ToArray();
        using var reader = new SegmentedReader(11, segments);
        AuthoringCanvasAnchorSourceProjection.ScanResult result =
            await AuthoringCanvasAnchorSourceProjection.ScanAsync(reader, identities);
        Assert.Equal(count, result.Anchors.Count);
        Assert.All(result.Anchors.Values, anchor => Assert.Equal(1, anchor.ClaimCount));
        Assert.All(result.Anchors.Values, anchor => Assert.Equal("Owner", anchor.ContextText));
    }

    [Fact]
    public async Task StreamedScan_RejectsOversizedRequestWithoutReadingAndHonorsTerminalCancellation()
    {
        using var oversized = new SegmentedReader(1, ("Content ^wanted", 1));
        await Assert.ThrowsAsync<AuthoringCanvasBudgetExceededException>(() =>
            AuthoringCanvasAnchorSourceProjection.ScanAsync(
                oversized, Enumerable.Range(0, AuthoringCanvasReferenceContract.MaxBatchSize + 1)
                    .Select(index => $"ref-{index}").ToArray()));
        Assert.Equal(0, oversized.ReadCalls);
        using var cancellation = new CancellationTokenSource();
        using var terminal = new SegmentedReader(1, ("Content ^wanted", 1))
        {
            OnEnd = cancellation.Cancel
        };
        await Assert.ThrowsAsync<OperationCanceledException>(() =>
            AuthoringCanvasAnchorSourceProjection.ScanAsync(terminal, ["wanted"], cancellation.Token));
    }

    [Theory]
    [InlineData("X", "\n", false)]
    [InlineData("X", "\r\n", false)]
    [InlineData("Owner ", "\n", true)]
    [InlineData("Owner ", "\r\n", true)]
    [InlineData("# Owner ", "\n", true)]
    [InlineData("# Owner ", "\r\n", true)]
    public async Task StreamedScan_MaximumIdentityRetainsRealPredecessorAcrossLineEnd(
        string prefix, string lineEnd, bool valid)
    {
        string identity = new('a', 64);
        string source = $"## Previous\n{prefix}^{identity}{lineEnd}";
        using var reader = new SegmentedReader(1, (source, 1));
        AuthoringCanvasAnchorSourceProjection.ScanResult result =
            await AuthoringCanvasAnchorSourceProjection.ScanAsync(reader, [identity]);

        if (!valid)
        {
            Assert.Empty(result.Anchors);
        }
        else
        {
            AuthoringCanvasAnchorObservation anchor = Assert.Single(result.Anchors).Value;
            Assert.Equal("Owner", anchor.ContextText);
            Assert.Equal(prefix.StartsWith('#'), anchor.OwnsHeading);
            Assert.Equal(1, anchor.ClaimCount);
        }
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public async Task Authority_RechecksCancellationAfterLastNativeReadAndAwaitedOwnedCleanup(int cancelAt)
    {
        using var cancellation = new CancellationTokenSource();
        var cleanupEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cleanupReleased = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        bool readerDisposed = false;
        int nativeReads = 0;
        var reader = Substitute.For<DbDataReader>();
        reader.ReadAsync(Arg.Any<CancellationToken>()).Returns(_ =>
        {
            if (++nativeReads == 1)
            {
                return Task.FromResult(true);
            }
            if (cancelAt == 1)
            {
                cancellation.Cancel(); // A non-cooperative false return must not publish facts.
            }
            return Task.FromResult(false);
        });
        reader.GetInt64(0).Returns(11L);
        reader.GetInt32(1).Returns(101);
        reader.IsDBNull(2).Returns(false);
        reader.GetTextReader(2).Returns(new StringReader("Owner ^wanted"));
        reader.DisposeAsync().Returns(_ => new ValueTask(DisposeReaderAsync()));

        async Task DisposeReaderAsync()
        {
            cleanupEntered.TrySetResult();
            await cleanupReleased.Task;
            if (cancelAt == 2)
            {
                cancellation.Cancel();
            }
            readerDisposed = true;
        }

        var command = new BorrowedCommand(reader, () =>
        {
            if (cancelAt == 3)
            {
                cancellation.Cancel();
            }
        });
        var connection = new BorrowedConnection(command);
        var transaction = Substitute.For<DbTransaction>();
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.Connection.Returns(connection);
        ado.Transaction.Returns(transaction);
        ado.CommandTimeOut.Returns(30);
        using var scopes = new DataTable();
        scopes.Columns.Add("id", typeof(int));
        scopes.Columns.Add("current_revision_id", typeof(long));
        scopes.Columns.Add("status", typeof(int));
        scopes.Columns.Add("isdeleted", typeof(bool));
        scopes.Columns.Add("has_access", typeof(bool));
        scopes.Rows.Add(101, 11L, (int)ArticleStatus.Draft, false, true);
        ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>())
            .Returns(_ => Task.FromResult((IDataReader)scopes.CreateDataReader()));
        var authority = new PostgresAuthoringCanvasCoordinateAuthority(db);
        Task<IReadOnlyDictionary<Guid, AuthoringCanvasCoordinateFact>> pending =
            authority.ReadBatchAsync(Query([Target(AuthoringCanvasNodeType.BlockReference, block: "wanted")]),
                cancellation.Token);

        await cleanupEntered.Task;
        Assert.False(pending.IsCompleted); // Do not return while owned async cleanup is unfinished.
        cleanupReleased.TrySetResult();
        if (cancelAt == 0)
        {
            AuthoringCanvasCoordinateFact fact = Assert.Single((await pending).Values);
            Assert.Equal(AuthoringCanvasReferenceCoordinateState.Current, fact.State);
        }
        else
        {
            await Assert.ThrowsAsync<OperationCanceledException>(() => pending);
        }
        Assert.True(readerDisposed);
        Assert.True(command.Disposed);
        Assert.Equal(CommandBehavior.SequentialAccess, command.ObservedBehavior);
        Assert.Equal(cancellation.Token, command.ObservedToken);
        Assert.Same(transaction, command.Transaction);
        Assert.Equal(0, connection.CloseCalls);
        Assert.False(connection.Disposed);
        transaction.DidNotReceive().Commit();
        transaction.DidNotReceive().Rollback();
    }

    // These borrowed I/O fixtures drive the original public authority and awaited cleanup,
    // not a SQL/native qualification or a separate cancellation predicate.
    private sealed class BorrowedConnection(BorrowedCommand command) : DbConnection
    {
        [AllowNull]
        public override string ConnectionString { get; set; } = string.Empty;
        public override string Database => "fixture";
        public override string DataSource => "fixture";
        public override string ServerVersion => "fixture";
        public override ConnectionState State => ConnectionState.Open;
        internal int CloseCalls
        {
            get; private set;
        }
        internal bool Disposed
        {
            get; private set;
        }
        public override void Close() => CloseCalls++;
        public override void Open() => throw new InvalidOperationException("borrowed_connection_already_open");
        public override void ChangeDatabase(string databaseName) => throw new NotSupportedException();
        protected override DbTransaction BeginDbTransaction(IsolationLevel isolationLevel)
            => throw new InvalidOperationException("borrowed_transaction_must_not_be_replaced");
        protected override DbCommand CreateDbCommand()
        {
            command.Connection = this;
            return command;
        }
        protected override void Dispose(bool disposing) => Disposed = true;
    }

    private sealed class BorrowedCommand(DbDataReader reader, Action onDispose) : DbCommand
    {
        private readonly DbParameterCollection _parameters = Substitute.For<DbParameterCollection>();
        [AllowNull]
        public override string CommandText { get; set; } = string.Empty;
        public override int CommandTimeout
        {
            get; set;
        }
        public override CommandType CommandType
        {
            get; set;
        }
        public override bool DesignTimeVisible
        {
            get; set;
        }
        public override UpdateRowSource UpdatedRowSource
        {
            get; set;
        }
        protected override DbConnection? DbConnection
        {
            get; set;
        }
        protected override DbTransaction? DbTransaction
        {
            get; set;
        }
        protected override DbParameterCollection DbParameterCollection => _parameters;
        internal CommandBehavior ObservedBehavior
        {
            get; private set;
        }
        internal CancellationToken ObservedToken
        {
            get; private set;
        }
        internal bool Disposed
        {
            get; private set;
        }
        public override void Cancel() => throw new NotSupportedException();
        public override int ExecuteNonQuery() => throw new NotSupportedException();
        public override object? ExecuteScalar() => throw new NotSupportedException();
        public override void Prepare() => throw new NotSupportedException();
        protected override DbParameter CreateDbParameter() => Substitute.For<DbParameter>();
        protected override DbDataReader ExecuteDbDataReader(CommandBehavior behavior)
            => throw new NotSupportedException();
        protected override Task<DbDataReader> ExecuteDbDataReaderAsync(
            CommandBehavior behavior, CancellationToken cancellationToken)
        {
            ObservedBehavior = behavior;
            ObservedToken = cancellationToken;
            return Task.FromResult(reader);
        }
        public override async ValueTask DisposeAsync()
        {
            await Task.Yield();
            onDispose();
            Disposed = true;
        }
    }

    // Virtual repetitions do not materialize a large Markdown fixture. The original
    // stream consumer cannot use whole-line/whole-source APIs on this fixture.
    private sealed class SegmentedReader(
        int chunkSize,
        params (string Text, long Repetitions)[] segments) : TextReader
    {
        private int _segment;
        private int _offset;
        private long _repetition;
        internal int MaximumReadRequest
        {
            get; private set;
        }
        internal int ReadCalls
        {
            get; private set;
        }
        internal long TotalCharacters { get; } = segments.Sum(segment => segment.Text.Length * segment.Repetitions);
        internal Action? OnEnd
        {
            get; init;
        }

        public override ValueTask<int> ReadAsync(Memory<char> buffer, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ReadCalls++;
            MaximumReadRequest = Math.Max(MaximumReadRequest, buffer.Length);
            int written = 0;
            while (written < Math.Min(chunkSize, buffer.Length) && _segment < segments.Length)
            {
                (string text, long repetitions) = segments[_segment];
                if (text.Length == 0 || _repetition == repetitions)
                {
                    _segment++;
                    _offset = 0;
                    _repetition = 0;
                    continue;
                }
                buffer.Span[written++] = text[_offset++];
                if (_offset == text.Length)
                {
                    _offset = 0;
                    _repetition++;
                }
            }
            if (written == 0)
            {
                OnEnd?.Invoke();
            }
            return ValueTask.FromResult(written);
        }

        public override string ReadToEnd() => throw new InvalidOperationException("whole_source_read_forbidden");
        public override string? ReadLine() => throw new InvalidOperationException("whole_line_read_forbidden");
    }

    private static AuthoringCanvasReferenceTarget Target(
        AuthoringCanvasNodeType nodeType,
        string? heading = null,
        string? block = null)
        => Target(nodeType, Guid.CreateVersion7(), heading ?? block);

    private static AuthoringCanvasReferenceTarget Target(
        AuthoringCanvasNodeType nodeType,
        Guid nodeId,
        string? identity)
        => new(
            nodeId,
            nodeType,
            101,
            nodeType == AuthoringCanvasNodeType.HeadingReference ? identity : null,
            nodeType == AuthoringCanvasNodeType.BlockReference ? identity : null,
            null,
            null);

    private static AuthoringCanvasCoordinateFactQuery Query(
        IReadOnlyList<AuthoringCanvasReferenceTarget> targets)
        => new(
            Guid.CreateVersion7(),
            7,
            CanvasDigest,
            s_owner,
            targets);
}
