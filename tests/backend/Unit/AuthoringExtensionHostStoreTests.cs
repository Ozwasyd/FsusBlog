using System.Collections.Immutable;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringExtensionHostStoreTests
{
    [Fact]
    public async Task LifecycleReceipt_PersistenceFailureDoesNotPublishGhostReceipt()
    {
        string root = TemporaryRoot();
        try
        {
            var store = new LocalAuthoringLifecycleReceiptStore(root);
            BlockRoot(root);

            await Assert.ThrowsAnyAsync<IOException>(async () =>
                await store.AppendAsync(CreateReceipt()));

            Assert.Null(await store.GetLatestAsync("acme.author-tools", CancellationToken.None));
        }
        finally
        {
            DeleteTemporaryRoot(root);
        }
    }

    [Fact]
    public async Task StatePut_PersistenceFailureDoesNotPublishGhostValue()
    {
        string root = TemporaryRoot();
        try
        {
            var store = new LocalAuthoringExtensionStateStore(root);
            AuthoringStateScope scope = Scope("1.0.0", 1);
            BlockRoot(root);

            await Assert.ThrowsAnyAsync<IOException>(async () =>
                await store.PutAsync(scope, "key", [1, 2, 3], CancellationToken.None));

            Assert.Equal((0L, 0L), await store.MeasureAsync(scope, CancellationToken.None));
        }
        finally
        {
            DeleteTemporaryRoot(root);
        }
    }

    [Fact]
    public async Task StateMigration_PersistenceFailuresDoNotPublishCandidateState()
    {
        string root = TemporaryRoot();
        try
        {
            var store = new LocalAuthoringExtensionStateStore(root);
            AuthoringStateScope source = Scope("1.0.0", 1);
            AuthoringStateScope target = Scope("2.0.0", 2);
            AuthoringStateMigrationPlan plan = Plan(source, target);
            await store.PutAsync(source, "old", [1, 2, 3], CancellationToken.None);
            BlockRoot(root);

            await Assert.ThrowsAnyAsync<IOException>(async () =>
                await store.BackupAsync(plan, CancellationToken.None));
            Assert.Equal(1, (await store.MeasureAsync(source, CancellationToken.None)).Records);

            await Assert.ThrowsAnyAsync<IOException>(async () =>
                await store.ApplyAsync(plan, CancellationToken.None));
            Assert.Equal(1, (await store.MeasureAsync(source, CancellationToken.None)).Records);
        }
        finally
        {
            DeleteTemporaryRoot(root);
        }
    }

    [Fact]
    public async Task StateRollbackAndDelete_PersistenceFailuresPreservePublishedState()
    {
        string root = TemporaryRoot();
        try
        {
            var store = new LocalAuthoringExtensionStateStore(root);
            AuthoringStateScope source = Scope("1.0.0", 1);
            AuthoringStateScope target = Scope("2.0.0", 2);
            AuthoringStateMigrationPlan plan = Plan(source, target);
            await store.PutAsync(source, "old", [1, 2, 3], CancellationToken.None);
            await store.BackupAsync(plan, CancellationToken.None);
            await store.ApplyAsync(plan, CancellationToken.None);
            BlockRoot(root);

            await Assert.ThrowsAnyAsync<IOException>(async () =>
                await store.RollbackAsync(plan, CancellationToken.None));
            Assert.Equal(3, (await store.MeasureAsync(source, CancellationToken.None)).Records);

            await Assert.ThrowsAnyAsync<IOException>(async () =>
                await store.DeleteAsync(source with { DocumentId = null }, CancellationToken.None));
            Assert.Equal(3, (await store.MeasureAsync(source, CancellationToken.None)).Records);
        }
        finally
        {
            DeleteTemporaryRoot(root);
        }
    }

    [Theory]
    [InlineData("extension", "bad\nidentity")]
    [InlineData("version", "bad\tversion")]
    [InlineData("site", " bad-site")]
    [InlineData("user", "bad-user\0")]
    [InlineData("document", "bad\rdocument")]
    [InlineData("key", "bad\u001fkey")]
    public async Task StatePut_UnboundedOrControlCharacterIdentityFailsClosed(string field, string invalid)
    {
        string root = TemporaryRoot();
        try
        {
            var store = new LocalAuthoringExtensionStateStore(root);
            AuthoringStateScope scope = Scope("1.0.0", 1);
            string key = "key";
            scope = field switch
            {
                "extension" => scope with { ExtensionId = invalid },
                "version" => scope with { ExtensionVersion = invalid },
                "site" => scope with { SiteId = invalid },
                "user" => scope with { UserId = invalid },
                "document" => scope with { DocumentId = invalid },
                "key" => scope,
                _ => throw new InvalidOperationException()
            };
            if (field == "key")
            {
                key = invalid;
            }

            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await store.PutAsync(scope, key, [1], CancellationToken.None));
            Assert.Equal((0L, 0L), await store.MeasureAsync(Scope("1.0.0", 1), CancellationToken.None));
        }
        finally
        {
            DeleteTemporaryRoot(root);
        }
    }

    [Fact]
    public async Task StatePut_IdentityLengthBoundFailsClosed()
    {
        string root = TemporaryRoot();
        try
        {
            var store = new LocalAuthoringExtensionStateStore(root);
            AuthoringStateScope scope = Scope("1.0.0", 1) with
            {
                ExtensionId = new string('x', 129)
            };

            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await store.PutAsync(scope, "key", [1], CancellationToken.None));
        }
        finally
        {
            DeleteTemporaryRoot(root);
        }
    }

    private static AuthoringLifecycleReceipt CreateReceipt()
    {
        var receipt = new AuthoringLifecycleReceipt(
            1,
            1,
            "acme.author-tools",
            new string('a', 64),
            "1.0.0",
            1,
            1,
            AuthoringLifecycleState.Installed,
            AuthoringLifecycleState.Enabled,
            1,
            new string('b', 64),
            null,
            new string('0', 64),
            string.Empty);
        return receipt with
        {
            ReceiptSha256 = AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(receipt)
        };
    }

    private static AuthoringStateScope Scope(string version, int schemaVersion) => new(
        "acme.author-tools",
        version,
        "site-1",
        "user-1",
        "document-1",
        schemaVersion);

    private static AuthoringStateMigrationPlan Plan(
        AuthoringStateScope source,
        AuthoringStateScope target) => new(
            "migration-1",
            source,
            target,
            100,
            1024,
            TimeSpan.FromSeconds(5),
            [new AuthoringStateTransform(AuthoringStateTransformKind.RenameKey, "old", "new", [])],
            "backup-1",
            "rollback-1",
            new string('c', 64));

    private static string TemporaryRoot() =>
        Path.Combine(Path.GetTempPath(), $"fsusblog-authoring-store-{Guid.NewGuid():N}");

    private static void BlockRoot(string root)
    {
        Directory.Move(root, root + ".persisted");
        File.WriteAllText(root, "blocked");
    }

    private static void DeleteTemporaryRoot(string root)
    {
        if (File.Exists(root))
        {
            File.Delete(root);
        }
        else if (Directory.Exists(root))
        {
            Directory.Delete(root, true);
        }

        if (Directory.Exists(root + ".persisted"))
        {
            Directory.Delete(root + ".persisted", true);
        }
    }
}
