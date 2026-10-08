using System.Text;
using System.Text.Json.Nodes;

using FsusBlog.Contracts.AuthoringWorkspace;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthoringWorkspaceSnapshotTests
{
    private const string SourceDigest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly AuthoringWorkspaceSnapshotScope s_scope = new(1, "site:primary");

    [Fact]
    public void CanonicalUtf8_MatchesSharedFrontendFixtureDigest()
    {
        AuthoringWorkspaceSnapshot snapshot = Snapshot(AuthoringWorkspaceSnapshotContract.DefaultLayout());
        Assert.False(snapshot.Layout.Shell.OutlineOpen);
        Assert.Equal("7a6edf2f3842c9c1e34e145543769ba82f2cbb9797a73b908b6a252d230d9163", snapshot.ContentDigest);
        DirectoryInfo? root = new(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "tests/fixtures/authoring-workspace/snapshot-current.json")))
        {
            root = root.Parent;
        }
        Assert.NotNull(root);
        byte[] bytes = File.ReadAllBytes(Path.Combine(root.FullName, "tests/fixtures/authoring-workspace/snapshot-current.json"));
        Assert.Equal(snapshot.ContentDigest, AuthoringWorkspaceSnapshotContract.Parse(bytes, s_scope, SourceDigest).ContentDigest);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Store_ExistingExplicitOutlinePreferenceIsPreservedWithoutWrites(bool outlineOpen)
    {
        AuthoringWorkspaceSnapshotLayout defaults = AuthoringWorkspaceSnapshotContract.DefaultLayout();
        AuthoringWorkspaceSnapshot saved = Snapshot(defaults with
        {
            Shell = defaults.Shell with
            {
                OutlineOpen = outlineOpen
            }
        });
        if (outlineOpen)
        {
            Assert.Equal("684e72bc43e7c3592266938dcd4087079c280f984bfdec1ca168bcc082f38249", saved.ContentDigest);
        }
        byte[] bytes = AuthoringWorkspaceSnapshotContract.Serialize(saved);
        var persistence = new MemoryPersistence();
        persistence.Rows[s_scope] = new(saved.Revision, bytes);
        var store = new AuthoringWorkspaceSnapshotStore(persistence, new SnapshotTimeProvider(), SourceDigest);
        AuthoringWorkspaceSnapshotResult read = await store.ReadAsync(s_scope);
        AuthoringWorkspaceSnapshotResult repeated = await store.ReadAsync(s_scope);
        Assert.Equal("current", read.Status);
        Assert.Equal(outlineOpen, read.Snapshot!.Layout.Shell.OutlineOpen);
        Assert.Equal(saved.ContentDigest, read.Snapshot.ContentDigest);
        Assert.Equal(read.Snapshot.ContentDigest, repeated.Snapshot!.ContentDigest);
        Assert.Equal(0, persistence.Writes);
        Assert.Equal(bytes, persistence.Rows[s_scope].Bytes.ToArray());
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(20)]
    [InlineData(100)]
    public void ClosedLayout_RoundTripsBoundedTabsAndCanonicalDigest(int count)
    {
        AuthoringWorkspaceSnapshot snapshot = Snapshot(Layout(count));
        byte[] bytes = AuthoringWorkspaceSnapshotContract.Serialize(snapshot);
        AuthoringWorkspaceSnapshot parsed = AuthoringWorkspaceSnapshotContract.Parse(bytes, s_scope, SourceDigest);
        Assert.Equal(count, parsed.Layout.Tabs.Length);
        Assert.Equal(snapshot.ContentDigest, parsed.ContentDigest);
        Assert.True(bytes.Length <= AuthoringWorkspaceSnapshotContract.MaxBytes);
        Assert.Equal(bytes, AuthoringWorkspaceSnapshotContract.Serialize(parsed));
    }

    [Theory]
    [InlineData("name")]
    [InlineData("workspaces")]
    [InlineData("body")]
    [InlineData("undo")]
    [InlineData("selection")]
    [InlineData("html")]
    [InlineData("attachmentBytes")]
    [InlineData("journal")]
    [InlineData("token")]
    public void Parser_RejectsUnknownAndContentFieldsAtEveryBoundary(string field)
    {
        foreach (string path in new[] { "root", "layout", "shell", "tab", "identity", "group", "scope" })
        {
            JsonNode root = JsonNode.Parse(AuthoringWorkspaceSnapshotContract.Serialize(Snapshot(Layout(1))))!;
            JsonNode target = path switch
            {
                "layout" => root["layout"]!,
                "shell" => root["layout"]!["shell"]!,
                "tab" => root["layout"]!["tabs"]![0]!,
                "identity" => root["layout"]!["tabs"]![0]!["identity"]!,
                "group" => root["layout"]!["groups"]![0]!,
                "scope" => root["scope"]!,
                _ => root
            };
            target[field] = "forbidden";
            Assert.Throws<AuthoringWorkspaceSnapshotException>(() => Parse(root));
        }
    }

    [Fact]
    public void Parser_RejectsMissingDuplicateKeysFutureSchemaSourceScopeAndTamper()
    {
        byte[] bytes = AuthoringWorkspaceSnapshotContract.Serialize(Snapshot(Layout(1)));
        string json = Encoding.UTF8.GetString(bytes);
        Assert.Throws<AuthoringWorkspaceSnapshotException>(() => AuthoringWorkspaceSnapshotContract.Parse(
            Encoding.UTF8.GetBytes(json.Replace("\"schemaVersion\":1", "\"schemaVersion\":1,\"schemaVersion\":1")), s_scope, SourceDigest));
        JsonNode missing = JsonNode.Parse(bytes)!;
        missing["layout"]!.AsObject().Remove("splitRatioPermille");
        Assert.Throws<AuthoringWorkspaceSnapshotException>(() => Parse(missing));
        foreach ((string field, JsonNode replacement) in new (string, JsonNode)[]
        {
            ("schemaVersion", JsonValue.Create(2)!), ("workspaceId", JsonValue.Create("second")!),
            ("revision", JsonValue.Create(2)!), ("contentDigest", JsonValue.Create(new string('b', 64))!)
        })
        {
            JsonNode root = JsonNode.Parse(bytes)!;
            root[field] = replacement;
            Assert.Throws<AuthoringWorkspaceSnapshotException>(() => Parse(root));
        }
        Assert.Throws<AuthoringWorkspaceSnapshotException>(() => AuthoringWorkspaceSnapshotContract.Parse(bytes, new(2, s_scope.SiteId), SourceDigest));
        Assert.Throws<AuthoringWorkspaceSnapshotException>(() => AuthoringWorkspaceSnapshotContract.Parse(bytes, new(1, "site:other"), SourceDigest));
        Assert.Throws<AuthoringWorkspaceSnapshotException>(() => AuthoringWorkspaceSnapshotContract.Parse(bytes, s_scope, new string('b', 64)));
        Assert.Throws<AuthoringWorkspaceSnapshotException>(() => AuthoringWorkspaceSnapshotContract.Parse(new byte[65_537], s_scope, SourceDigest));
        Assert.Throws<AuthoringWorkspaceSnapshotException>(() => AuthoringWorkspaceSnapshotContract.Parse(Encoding.UTF8.GetBytes("{}"), s_scope, SourceDigest));
    }

    [Fact]
    public void Layout_RejectsMirrorsThirdGroupOrphansMultiplePreviewsAndOversize()
    {
        AuthoringWorkspaceSnapshotLayout original = Layout(2);
        var duplicate = original with
        {
            Tabs = [original.Tabs[0], original.Tabs[1] with { Identity = original.Tabs[0].Identity }]
        };
        Assert.Throws<AuthoringWorkspaceSnapshotException>(() => Snapshot(duplicate));
        Assert.Throws<AuthoringWorkspaceSnapshotException>(() => Snapshot(original with
        {
            Groups = [original.Groups[0], new("group:secondary", [original.Tabs[0].TabId], original.Tabs[0].TabId)]
        }));
        Assert.Throws<AuthoringWorkspaceSnapshotException>(() => Snapshot(original with
        {
            Groups = [original.Groups[0], new("group:secondary", [], null), new("group:third", [], null)]
        }));
        Assert.Throws<AuthoringWorkspaceSnapshotException>(() => Snapshot(original with
        {
            Groups = [new("group:primary", ["tab:unknown"], "tab:unknown")]
        }));
        Assert.Throws<AuthoringWorkspaceSnapshotException>(() => Snapshot(original with
        {
            Tabs = original.Tabs.Select(tab => tab with { IsPinned = false, IsPreview = true }).ToArray()
        }));
        Assert.Throws<AuthoringWorkspaceSnapshotException>(() => Snapshot(Layout(101)));
        Assert.Throws<AuthoringWorkspaceSnapshotException>(() => Snapshot(original with { SplitRatioPermille = 199 }));
    }

    [Fact]
    public void Seal_DefensivelyCopiesArraysAndDefaultIsLegalEmptySingleGroup()
    {
        AuthoringWorkspaceSnapshotLayout input = Layout(1);
        AuthoringWorkspaceSnapshot snapshot = Snapshot(input);
        input.Tabs[0] = input.Tabs[0] with
        {
            TabId = "tab:changed"
        };
        input.Groups[0].TabIds[0] = "tab:changed";
        Assert.Equal("tab:000", snapshot.Layout.Tabs[0].TabId);
        Assert.Equal("tab:000", snapshot.Layout.Groups[0].TabIds[0]);
        AuthoringWorkspaceSnapshotContract.ValidateLayout(AuthoringWorkspaceSnapshotContract.DefaultLayout());
    }

    [Fact]
    public async Task Store_MissingReadIsZeroWriteAndCreateUpdateStaleCasAreExplicit()
    {
        var persistence = new MemoryPersistence();
        var store = Store(persistence);
        AuthoringWorkspaceSnapshotResult missing = await store.ReadAsync(s_scope);
        Assert.Equal("missing", missing.Status);
        Assert.Null(missing.Snapshot);
        Assert.Equal(0, persistence.Writes);
        AuthoringWorkspaceSnapshotResult created = await store.WriteAsync(s_scope, 0, Layout(20));
        Assert.Equal("applied", created.Status);
        Assert.True(AuthoringWorkspaceSnapshotStore.VerifyReceipt(created));
        Assert.False(created.Snapshot!.Layout.Shell.OutlineOpen);
        Assert.Equal(1, created.Revision);
        AuthoringWorkspaceSnapshotResult read = await store.ReadAsync(s_scope);
        Assert.Equal("current", read.Status);
        Assert.Equal(created.Snapshot!.ContentDigest, read.Snapshot!.ContentDigest);
        AuthoringWorkspaceSnapshotResult stale = await store.WriteAsync(s_scope, 0, Layout(1));
        Assert.Equal("conflict", stale.Status);
        Assert.Null(stale.Snapshot);
        Assert.Equal(1, persistence.Writes);
        AuthoringWorkspaceSnapshotResult updated = await store.WriteAsync(s_scope, 1, Layout(100));
        Assert.Equal(2, updated.Revision);
        Assert.Equal(100, updated.Snapshot!.Layout.Tabs.Length);
        Assert.All(new[] { missing, created, read, stale, updated }, result => Assert.True(AuthoringWorkspaceSnapshotStore.VerifyReceipt(result)));
    }

    [Fact]
    public async Task Store_ConcurrentIndependentClientsHaveExactlyOneWinner()
    {
        var persistence = new MemoryPersistence { GateNextReads = true };
        AuthoringWorkspaceSnapshotResult[] outcomes = await Task.WhenAll(
            Store(persistence).WriteAsync(s_scope, 0, Layout(1)), Store(persistence).WriteAsync(s_scope, 0, Layout(20)));
        Assert.Single(outcomes, outcome => outcome.Status == "applied");
        Assert.Single(outcomes, outcome => outcome.Status == "conflict");
        Assert.Equal(1, persistence.Writes);
        Assert.Single(persistence.Rows);
    }

    [Fact]
    public async Task Reset_IsConfirmedCasScopedAndPreservesOtherUserSiteRows()
    {
        var persistence = new MemoryPersistence();
        var store = Store(persistence);
        AuthoringWorkspaceSnapshotScope otherUser = new(2, s_scope.SiteId);
        AuthoringWorkspaceSnapshotScope otherSite = new(1, "site:other");
        await store.WriteAsync(s_scope, 0, Layout(20));
        await store.WriteAsync(otherUser, 0, Layout(1));
        await store.WriteAsync(otherSite, 0, Layout(100));
        await Assert.ThrowsAsync<AuthoringWorkspaceSnapshotException>(() => store.ResetAsync(s_scope, 1, "unconfirmed"));
        AuthoringWorkspaceSnapshotResult reset = await store.ResetAsync(s_scope, 1,
            AuthoringWorkspaceSnapshotStore.ResetConfirmation(s_scope, 1, SourceDigest));
        Assert.Equal("applied", reset.Status);
        Assert.Empty(reset.Snapshot!.Layout.Tabs);
        Assert.False(reset.Snapshot.Layout.Shell.OutlineOpen);
        Assert.Equal(2, reset.Revision);
        Assert.Single((await store.ReadAsync(otherUser)).Snapshot!.Layout.Tabs);
        Assert.Equal(100, (await store.ReadAsync(otherSite)).Snapshot!.Layout.Tabs.Length);
        Assert.Equal(3, persistence.Rows.Count);
        AuthoringWorkspaceSnapshotResult stale = await store.ResetAsync(s_scope, 1,
            AuthoringWorkspaceSnapshotStore.ResetConfirmation(s_scope, 1, SourceDigest));
        Assert.Equal("conflict", stale.Status);
    }

    [Theory]
    [InlineData("future_schema")]
    [InlineData("corrupt")]
    [InlineData("stored_revision")]
    public async Task CorruptFutureOrMismatchedRow_NeverRepairsWritesResetsOrDeletes(string kind)
    {
        var persistence = new MemoryPersistence();
        JsonNode root = JsonNode.Parse(AuthoringWorkspaceSnapshotContract.Serialize(Snapshot(Layout(1))))!;
        if (kind == "future_schema")
            root["schemaVersion"] = 2;
        if (kind == "corrupt")
            root["contentDigest"] = new string('b', 64);
        persistence.Rows[s_scope] = new(kind == "stored_revision" ? 2 : 1, Encoding.UTF8.GetBytes(root.ToJsonString()));
        AuthoringWorkspaceSnapshotResult result = await Store(persistence).ReadAsync(s_scope);
        Assert.Equal("blocked", result.Status);
        Assert.Null(result.Snapshot);
        Assert.True(AuthoringWorkspaceSnapshotStore.VerifyReceipt(result));
        await Assert.ThrowsAsync<AuthoringWorkspaceSnapshotException>(() => Store(persistence).WriteAsync(s_scope, result.Revision, Layout(0)));
        await Assert.ThrowsAsync<AuthoringWorkspaceSnapshotException>(() => Store(persistence).ResetAsync(s_scope, result.Revision,
            AuthoringWorkspaceSnapshotStore.ResetConfirmation(s_scope, result.Revision, SourceDigest)));
        Assert.Equal(0, persistence.Writes);
        Assert.Single(persistence.Rows);
    }

    [Fact]
    public async Task FailuresAndReceiptTampering_DoNotFallBackOrWrite()
    {
        var persistence = new MemoryPersistence { FailRead = true };
        await Assert.ThrowsAsync<IOException>(() => Store(persistence).ReadAsync(s_scope));
        Assert.Equal(0, persistence.Writes);
        persistence.FailRead = false;
        persistence.FailWrite = true;
        await Assert.ThrowsAsync<IOException>(() => Store(persistence).WriteAsync(s_scope, 0, Layout(1)));
        Assert.Empty(persistence.Rows);
        persistence.FailWrite = false;
        var result = await Store(persistence).WriteAsync(s_scope, 0, Layout(1));
        Assert.False(AuthoringWorkspaceSnapshotStore.VerifyReceipt(result with
        {
            Revision = 9
        }));
        Assert.False(AuthoringWorkspaceSnapshotStore.VerifyReceipt(result with
        {
            Receipt = result.Receipt with
            {
                Action = "reset",
                Scope = new(2, s_scope.SiteId)
            }
        }));
        Assert.False(AuthoringWorkspaceSnapshotStore.VerifyReceipt(result with
        {
            Snapshot = result.Snapshot! with
            {
                Revision = 9
            }
        }));
    }

    private static AuthoringWorkspaceSnapshot Parse(JsonNode root)
        => AuthoringWorkspaceSnapshotContract.Parse(Encoding.UTF8.GetBytes(root.ToJsonString()), s_scope, SourceDigest);
    private static AuthoringWorkspaceSnapshot Snapshot(AuthoringWorkspaceSnapshotLayout layout)
        => AuthoringWorkspaceSnapshotContract.Seal(s_scope, SourceDigest, 1, 1_800_000_000_000, layout);
    private static AuthoringWorkspaceSnapshotStore Store(MemoryPersistence persistence)
        => new(persistence, TimeProvider.System, SourceDigest);
    private static AuthoringWorkspaceSnapshotLayout Layout(int count)
    {
        AuthoringWorkspaceSnapshotTab[] tabs = Enumerable.Range(0, count).Select(index => new AuthoringWorkspaceSnapshotTab(
            $"tab:{index:D3}", new(index + 1, $"draft:{index:D3}", $"document:{index:D3}"), false, true)).ToArray();
        return AuthoringWorkspaceSnapshotContract.DefaultLayout() with
        {
            Tabs = tabs,
            Groups = [new("group:primary", tabs.Select(tab => tab.TabId).ToArray(), tabs.FirstOrDefault()?.TabId)]
        };
    }

    private sealed class MemoryPersistence : IAuthoringWorkspaceSnapshotPersistence
    {
        private readonly object _gate = new();
        private readonly TaskCompletionSource _reads = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _readCount;
        public Dictionary<AuthoringWorkspaceSnapshotScope, AuthoringWorkspaceSnapshotStoredRow> Rows { get; } = [];
        public int Writes
        {
            get; private set;
        }
        public bool FailRead
        {
            get; set;
        }
        public bool FailWrite
        {
            get; set;
        }
        public bool GateNextReads
        {
            get; init;
        }
        public async Task<AuthoringWorkspaceSnapshotStoredRow?> ReadAsync(AuthoringWorkspaceSnapshotScope scope, CancellationToken cancellationToken)
        {
            if (FailRead)
                throw new IOException("server_read_failed");
            if (GateNextReads && Interlocked.Increment(ref _readCount) <= 2)
            {
                if (_readCount == 2)
                    _reads.TrySetResult();
                await _reads.Task.WaitAsync(cancellationToken);
                return null;
            }
            lock (_gate)
                return Rows.TryGetValue(scope, out var row) ? new(row.Revision, row.Bytes.ToArray()) : null;
        }
        public Task<bool> CompareExchangeAsync(AuthoringWorkspaceSnapshotScope scope, long expectedRevision,
            AuthoringWorkspaceSnapshotStoredRow next, CancellationToken cancellationToken)
        {
            if (FailWrite)
                throw new IOException("server_write_failed");
            lock (_gate)
            {
                if ((Rows.TryGetValue(scope, out var row) ? row.Revision : 0) != expectedRevision)
                    return Task.FromResult(false);
                Rows[scope] = new(next.Revision, next.Bytes.ToArray());
                Writes++;
                return Task.FromResult(true);
            }
        }
    }

    private sealed class SnapshotTimeProvider : TimeProvider
    {
        public override DateTimeOffset GetUtcNow()
            => DateTimeOffset.FromUnixTimeMilliseconds(1_800_000_000_000);
    }
}
