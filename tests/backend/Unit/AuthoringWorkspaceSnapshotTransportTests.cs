using FsusBlog.Contracts.AuthoringWorkspace;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.AuthoringWorkspace;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthoringWorkspaceSnapshotTransportTests
{
    private static readonly AuthoringWorkspaceSnapshotScope s_scope = new(1, "primary-site");

    [Fact]
    public async Task ReadAndExplicitWrite_ReturnTheCanonicalScopedReceiptAndCasConflict()
    {
        var persistence = new MemoryPersistence();
        var identity = new AuthoringWorkspaceSnapshotSourceIdentity();
        var store = new AuthoringWorkspaceSnapshotStore(persistence, TimeProvider.System, identity.SourceDigest);
        var transport = new AuthoringWorkspaceSnapshotTransport(store, identity);
        AuthoringWorkspaceSnapshotResponse missing = await transport.ReadAsync(s_scope, CancellationToken.None);
        Assert.Equal("missing", missing.Status);
        Assert.Equal(0, persistence.Writes);

        AuthoringWorkspaceSnapshotLayout layout = AuthoringWorkspaceSnapshotContract.DefaultLayout() with
        {
            Shell = AuthoringWorkspaceSnapshotContract.DefaultLayout().Shell with { OutlineOpen = false }
        };
        var command = new AuthoringWorkspaceSnapshotRequest("write", 0, identity.SourceDigest, layout, null);
        AuthoringWorkspaceSnapshotResponse result = await transport.MutateAsync(s_scope, command, CancellationToken.None);
        Assert.Equal("applied", result.Status);
        Assert.Equal(1, result.Revision);
        Assert.Equal(s_scope, result.Receipt.Scope);
        Assert.Equal(identity.SourceDigest, result.Receipt.SourceDigest);
        Assert.False(result.Snapshot!.Layout.Shell.OutlineOpen);
        AuthoringWorkspaceSnapshotResult canonical = await store.ReadAsync(s_scope);
        Assert.Equal(canonical.Receipt.ContentDigest,
            (await transport.ReadAsync(s_scope, CancellationToken.None)).Receipt.ContentDigest);
        Assert.Equal(canonical.Snapshot!.ContentDigest, result.Receipt.SnapshotDigest);
        Assert.Equal("conflict", (await transport.MutateAsync(s_scope, command, CancellationToken.None)).Status);
        Assert.Equal(1, persistence.Writes);
    }

    [Fact]
    public async Task DifferentScope_CannotReadAnotherUserOrSiteRow()
    {
        var persistence = new MemoryPersistence();
        var identity = new AuthoringWorkspaceSnapshotSourceIdentity();
        var transport = new AuthoringWorkspaceSnapshotTransport(
            new(persistence, TimeProvider.System, identity.SourceDigest), identity);
        await transport.MutateAsync(s_scope, new("write", 0, identity.SourceDigest,
            AuthoringWorkspaceSnapshotContract.DefaultLayout(), null), CancellationToken.None);
        foreach (AuthoringWorkspaceSnapshotScope scope in new[]
        {
            new AuthoringWorkspaceSnapshotScope(2, s_scope.SiteId), new(1, "other-site")
        })
        {
            AuthoringWorkspaceSnapshotResponse result = await transport.ReadAsync(scope, CancellationToken.None);
            Assert.Equal("missing", result.Status);
            Assert.Null(result.Snapshot);
            Assert.Equal(scope, result.Receipt.Scope);
        }
        Assert.Equal(1, persistence.Writes);
    }

    [Theory]
    [InlineData("stale-source")]
    [InlineData("unknown-action")]
    [InlineData("write-with-reset")]
    [InlineData("write-without-layout")]
    [InlineData("reset-with-layout")]
    public async Task InvalidMutation_RefusesBeforeAnyPersistence(string failure)
    {
        var persistence = new MemoryPersistence();
        var identity = new AuthoringWorkspaceSnapshotSourceIdentity();
        var transport = new AuthoringWorkspaceSnapshotTransport(
            new(persistence, TimeProvider.System, identity.SourceDigest), identity);
        var command = new AuthoringWorkspaceSnapshotRequest("write", 0, identity.SourceDigest,
            AuthoringWorkspaceSnapshotContract.DefaultLayout(), null);
        command = failure switch
        {
            "stale-source" => command with
            {
                SourceDigest = (identity.SourceDigest[0] == 'a' ? "b" : "a") + identity.SourceDigest[1..]
            },
            "unknown-action" => command with { Action = "delete" },
            "write-with-reset" => command with { ResetConfirmationDigest = new string('a', 64) },
            "write-without-layout" => command with { Layout = null },
            "reset-with-layout" => command with { Action = "reset", ResetConfirmationDigest = new string('a', 64) },
            _ => throw new InvalidOperationException()
        };
        await Assert.ThrowsAsync<AuthoringWorkspaceSnapshotException>(
            () => transport.MutateAsync(s_scope, command, CancellationToken.None));
        Assert.Equal(0, persistence.Reads);
        Assert.Equal(0, persistence.Writes);
    }

    [Fact]
    public async Task UnqualifiedDefaultReset_RefusesWithoutSilentlyChangingSignedLayout()
    {
        Assert.True(AuthoringWorkspaceSnapshotContract.DefaultLayout().Shell.OutlineOpen);
        var persistence = new MemoryPersistence();
        var identity = new AuthoringWorkspaceSnapshotSourceIdentity();
        var transport = new AuthoringWorkspaceSnapshotTransport(
            new(persistence, TimeProvider.System, identity.SourceDigest), identity);
        string confirmation = AuthoringWorkspaceSnapshotStore.ResetConfirmation(s_scope, 0, identity.SourceDigest);
        AuthoringWorkspaceSnapshotException error = await Assert.ThrowsAsync<AuthoringWorkspaceSnapshotException>(
            () => transport.MutateAsync(s_scope, new("reset", 0, identity.SourceDigest, null, confirmation), CancellationToken.None));
        Assert.Equal("default_layout_unqualified", error.Reason);
        Assert.Equal(0, persistence.Reads);
        Assert.Equal(0, persistence.Writes);
    }

    private sealed class MemoryPersistence : IAuthoringWorkspaceSnapshotPersistence
    {
        private readonly Dictionary<AuthoringWorkspaceSnapshotScope, AuthoringWorkspaceSnapshotStoredRow> _rows = [];

        public int Reads { get; private set; }

        public int Writes { get; private set; }

        public Task<AuthoringWorkspaceSnapshotStoredRow?> ReadAsync(AuthoringWorkspaceSnapshotScope scope,
            CancellationToken cancellationToken)
        {
            Reads++;
            return Task.FromResult(_rows.GetValueOrDefault(scope));
        }

        public Task<bool> CompareExchangeAsync(AuthoringWorkspaceSnapshotScope scope, long expectedRevision,
            AuthoringWorkspaceSnapshotStoredRow next, CancellationToken cancellationToken)
        {
            if ((_rows.GetValueOrDefault(scope)?.Revision ?? 0) != expectedRevision)
            {
                return Task.FromResult(false);
            }
            Writes++;
            _rows[scope] = next;
            return Task.FromResult(true);
        }
    }
}
