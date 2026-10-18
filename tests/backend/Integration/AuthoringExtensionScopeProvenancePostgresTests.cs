using System.Diagnostics;
using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

using Npgsql;

using SqlSugar;

using static FsusBlog.Server.Infrastructure.AuthoringExtensions.AuthoringExtensionStateContract;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AuthoringExtensionScopeProvenancePostgresTests(PostgresSchemaMigrationFixture postgres)
{
    private static readonly VerifiedAuthoringPackage s_package = AuthoringStateProcessWorker.Package("1.0.0", 1);
    private static readonly VerifiedAuthoringPackage s_next = AuthoringStateProcessWorker.Package("2.0.0", 2);

    [Fact]
    public async Task GenuineIssuance_PendingCannotAuthorize_ExactActiveOwnerCan()
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionScopeRegistration registration = await host.BeginAsync();
        Assert.Null(registration.Scope.DocumentId);
        Assert.NotEqual("1", registration.Scope.UserId);
        await host.RefuseAsync(registration.Scope);
        Assert.Equal(registration.Scope, await host.CompleteAsync(registration));
        await using IAuthoringExtensionApprovalScope held = await host.AcquireAsync(registration.Scope);
        Assert.True(IsDigest(held.AuthorizationSha256));
        await held.VerifyCurrentAsync(default);
        using SqlSugarClient db = host.Client();
        AuthoringStateSnapshot state = await new PostgresAuthoringExtensionStateStore(db).ReadAsync(s_package, registration.Scope, default);
        Assert.Equal(0, state.Revision);
        Assert.Empty(state.Entries);
    }

    [Fact]
    public async Task Migration_BindsBothIndependentRegistrationsAndDurableOwner()
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionScopeRegistration first = await host.BeginAsync();
        await host.CompleteAsync(first);
        AuthoringExtensionScopeRegistration second = await host.Issuer.BeginAsync(host.Context, s_next, first.Scope);
        Assert.Equal(first.Scope.UserId, second.Scope.UserId);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Authority.AcquireAsync(host.Context,
            AuthoringApprovalOperation.Migration, first.Scope, second.Scope, default).AsTask());
        await host.Issuer.CompleteAsync(host.Context, s_next, second.RegistrationId);
        string digest;
        await using (IAuthoringExtensionApprovalScope held = await host.Authority.AcquireAsync(host.Context,
            AuthoringApprovalOperation.Migration, first.Scope, second.Scope, default))
        {
            digest = held.AuthorizationSha256;
            await held.VerifyCurrentAsync(default);
        }
        await using IAuthoringExtensionApprovalScope deletion = await host.AcquireAsync(first.Scope);
        Assert.NotEqual(digest, deletion.AuthorizationSha256);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Authority.AcquireAsync(Actor(2),
            AuthoringApprovalOperation.Migration, first.Scope, second.Scope, default).AsTask());
    }

    [Theory]
    [InlineData("1")]
    [InlineData("root")]
    [InlineData("legacy-opaque-user")]
    public async Task ExistingStateAndRootPermission_DoNotCreateProvenance(string user)
    {
        await using Harness host = await CreateAsync();
        AuthoringStateScope scope = AuthoringStateProcessWorker.Scope(s_package) with
        {
            UserId = user,
            SiteId = "configured-site",
            DocumentId = null
        };
        using SqlSugarClient db = host.Client();
        await new PostgresAuthoringExtensionStateStore(db).InitializeAsync(s_package, scope, default);
        await host.RefuseAsync(scope);
    }

    [Fact]
    public async Task SameSiteAndLocator_DoNotAuthorizeAnotherAdmin()
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionScopeRegistration registration = await host.BeginAsync();
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Issuer.CompleteAsync(Actor(2), s_package, registration.RegistrationId).AsTask());
        await host.CompleteAsync(registration);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Authority.AcquireAsync(Actor(2),
            AuthoringApprovalOperation.Deletion, registration.Scope, null, default).AsTask());
        await host.RefuseAsync(registration.Scope with
        {
            SiteId = "primary-site"
        });
        await host.RefuseAsync(registration.Scope with
        {
            UserId = "1"
        });
        host.Configuration["AuthoringExtensions:SiteId"] = "different-site";
        await host.RefuseAsync(registration.Scope);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.CompleteAsync(registration));
    }

    [Fact]
    public async Task RegistrationCollision_DoesNotReplaceExistingActiveRecord()
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionScopeRegistration registration = await host.BeginAsync();
        await host.CompleteAsync(registration);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Issuer.BeginAsync(host.Context, s_package, registration.Scope).AsTask());
        await host.CompleteAsync(registration);
        await using IAuthoringExtensionApprovalScope held = await host.AcquireAsync(registration.Scope);
        await held.VerifyCurrentAsync(default);
    }

    [Fact]
    public async Task ConcurrentRegistrationRetry_ActivatesOnlyOneExactOriginalRecord()
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionScopeRegistration registration = await host.BeginAsync();
        AuthoringStateScope[] scopes = await Task.WhenAll(host.CompleteAsync(registration), host.CompleteAsync(registration));
        Assert.All(scopes, scope => Assert.Equal(registration.Scope, scope));
        await using IAuthoringExtensionApprovalScope held = await host.AcquireAsync(registration.Scope);
        await held.VerifyCurrentAsync(default);
    }

    [Fact]
    public async Task Resume_RejectsUnknownLocatorAndDifferentVerifiedPackage()
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionScopeRegistration registration = await host.BeginAsync();
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Issuer.CompleteAsync(
            host.Context, s_next, registration.RegistrationId).AsTask());
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Issuer.CompleteAsync(
            host.Context, s_package, new string('f', 64)).AsTask());
        await host.RefuseAsync(registration.Scope);
        await host.CompleteAsync(registration);
    }

    [Fact]
    public async Task OriginalTruncateAndReinsert_CannotReuseAnActiveCreationWitness()
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionScopeRegistration registration = await host.BeginAsync();
        await host.CompleteAsync(registration);
        await host.SqlAsync("TRUNCATE authoring_extension_state_scope CASCADE");
        await host.InitializeOriginalAsync(registration, true);
        await host.RefuseAsync(registration.Scope);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.CompleteAsync(registration));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RegistrationWait_RechecksNaturalSessionExpiryAndRequestSiteBeforeActivation(bool siteChange)
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionScopeRegistration registration = await host.BeginAsync();
        await using NpgsqlConnection blocker = await host.DataSource.OpenConnectionAsync();
        await using NpgsqlTransaction transaction = await blocker.BeginTransactionAsync();
        await using (var command = new NpgsqlCommand("SELECT pg_advisory_xact_lock(hashtextextended($1,2143))", blocker))
        {
            command.Parameters.AddWithValue($"authoring-extension-state:{ScopeId(registration.Scope)}");
            await command.ExecuteNonQueryAsync();
        }
        Task<AuthoringStateScope> completion = host.CompleteAsync(registration);
        await host.WaitForBlockedWriterAsync();
        if (siteChange)
        {
            host.Configuration["AuthoringExtensions:SiteId"] = "another-site";
        }
        else
        {
            await host.SqlAsync("UPDATE admin_session SET idleexpiresatutc=clock_timestamp()+interval '100 milliseconds' WHERE adminprincipalid=1");
            await Task.Delay(150);
        }
        await transaction.RollbackAsync();
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => completion);
        await host.RefuseAsync(registration.Scope);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CrashBoundary_RestartResumesOnlyItsOriginalDurableRecord(bool afterOriginalCommit)
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionScopeRegistration registration = await host.BeginAsync();
        if (afterOriginalCommit)
        {
            await host.InitializeOriginalAsync(registration, true);
        }
        var restarted = new AuthoringExtensionStateScopeIssuer(host.DataSource, host.Configuration,
            new PostgresAuthoringExtensionScopeProvenanceStore(host.DataSource, host.Configuration));
        await restarted.CompleteAsync(host.Context, s_package, registration.RegistrationId);
        await using IAuthoringExtensionApprovalScope held = await host.AcquireAsync(registration.Scope);
        await held.VerifyCurrentAsync(default);
    }

    [Fact]
    public async Task UnknownPreexistingOriginal_NeverAdoptedEvenIfExactEmptySnapshot()
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionScopeRegistration registration = await host.BeginAsync();
        // Setting the exact Pending locator after an unknown INSERT cannot create a witness.
        await host.InitializeOriginalAsync(registration, false);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.CompleteAsync(registration));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.CompleteAsync(registration));
        await host.RefuseAsync(registration.Scope);
    }

    [Theory]
    [InlineData("write")]
    [InlineData("delete")]
    [InlineData("revoke")]
    public async Task PendingCreationMutation_RefusesActivation(string mutation)
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionScopeRegistration registration = await host.BeginAsync();
        await host.InitializeOriginalAsync(registration, true);
        if (mutation == "write")
        {
            using SqlSugarClient db = host.Client();
            await new PostgresAuthoringExtensionStateStore(db).WriteAsync(s_package, registration.Scope, 0, new("key", [1]), default);
        }
        else if (mutation == "delete")
        {
            await host.SqlAsync("DELETE FROM authoring_extension_state_scope WHERE scope_id=$1", ScopeId(registration.Scope));
        }
        else
        {
            await host.Store.RevokeAsync(host.Context, registration.RegistrationId);
        }
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.CompleteAsync(registration));
        await host.RefuseAsync(registration.Scope);
    }

    [Theory]
    [InlineData("revoke")]
    [InlineData("provenance-delete")]
    [InlineData("original-delete")]
    [InlineData("owner-update")]
    public async Task HeldWitness_BlocksEveryRevokeDeleteOrOwnerMutationThroughFinalVerification(string mutation)
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionScopeRegistration registration = await host.BeginAsync();
        await host.CompleteAsync(registration);
        IAuthoringExtensionApprovalScope held = await host.AcquireAsync(registration.Scope);
        string sql = mutation switch
        {
            "revoke" => "UPDATE authoring_extension_scope_provenance SET status=2,revision=revision+1 WHERE scope_id=$1",
            "provenance-delete" => "DELETE FROM authoring_extension_scope_provenance WHERE scope_id=$1",
            "original-delete" => "DELETE FROM authoring_extension_state_scope WHERE scope_id=$1",
            _ => "UPDATE authoring_extension_scope_provenance SET owner_admin_principal_id=2 WHERE scope_id=$1"
        };
        Task writer = host.SqlAsync(sql, ScopeId(registration.Scope));
        try
        {
            await host.WaitForBlockedWriterAsync();
            Assert.False(writer.IsCompleted);
            await held.VerifyCurrentAsync(default);
        }
        finally
        {
            await held.DisposeAsync();
        }
        await writer.WaitAsync(TimeSpan.FromSeconds(5));
        await host.RefuseAsync(registration.Scope);
        await held.DisposeAsync();
        await Assert.ThrowsAsync<ObjectDisposedException>(() => held.VerifyCurrentAsync(default).AsTask());
    }

    [Theory]
    [InlineData("expiry")]
    [InlineData("session-revoke")]
    [InlineData("principal-revoke")]
    [InlineData("site")]
    [InlineData("actor")]
    public async Task Currentness_RechecksRealActorSessionAndConfigurationWithoutIndependentActorLocks(string mutation)
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionScopeRegistration registration = await host.BeginAsync();
        await host.CompleteAsync(registration);
        await using IAuthoringExtensionApprovalScope held = await host.AcquireAsync(registration.Scope);
        switch (mutation)
        {
            case "expiry":
                await host.SqlAsync("UPDATE admin_session SET idleexpiresatutc=clock_timestamp()-interval '1 second' WHERE adminprincipalid=1");
                break;
            case "session-revoke":
                await host.SqlAsync("UPDATE admin_session SET revokedatutc=clock_timestamp() WHERE adminprincipalid=1");
                break;
            case "principal-revoke":
                await host.SqlAsync("UPDATE admin_principal SET status='disabled' WHERE id=1");
                break;
            case "site":
                host.Configuration["AuthoringExtensions:SiteId"] = "other-site";
                break;
            default:
                host.Context.User = Actor(2).User;
                break;
        }
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => held.VerifyCurrentAsync(default).AsTask());
    }

    [Fact]
    public async Task ConnectionLoss_FailsCurrentnessAndDisposeReleasesWitness()
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionScopeRegistration registration = await host.BeginAsync();
        await host.CompleteAsync(registration);
        IAuthoringExtensionApprovalScope held = await host.AcquireAsync(registration.Scope);
        await host.SqlAsync("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'");
        await Assert.ThrowsAnyAsync<Exception>(() => held.VerifyCurrentAsync(default).AsTask());
        await held.DisposeAsync();
        await host.Store.RevokeAsync(host.Context, registration.RegistrationId);
        await host.RefuseAsync(registration.Scope);
    }

    [Fact]
    public async Task CancelledAcquire_CleansUpPreviouslyHeldSourceWitness()
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionScopeRegistration first = await host.BeginAsync();
        await host.CompleteAsync(first);
        AuthoringExtensionScopeRegistration second = await host.Issuer.BeginAsync(host.Context, s_next, first.Scope);
        await host.Issuer.CompleteAsync(host.Context, s_next, second.RegistrationId);
        string[] ids = new[] { ScopeId(first.Scope), ScopeId(second.Scope) }.Order(StringComparer.Ordinal).ToArray();
        await using NpgsqlConnection blocker = await host.DataSource.OpenConnectionAsync();
        await using NpgsqlTransaction transaction = await blocker.BeginTransactionAsync();
        await using (var command = new NpgsqlCommand("SELECT 1 FROM authoring_extension_scope_provenance WHERE scope_id=$1 FOR UPDATE", blocker))
        {
            command.Parameters.AddWithValue(ids[1]);
            await command.ExecuteNonQueryAsync();
        }
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(300));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => host.Authority.AcquireAsync(host.Context,
            AuthoringApprovalOperation.Migration, first.Scope, second.Scope, cancellation.Token).AsTask());
        await transaction.RollbackAsync();
        await host.SqlAsync("UPDATE authoring_extension_scope_provenance SET status=2 WHERE scope_id=$1", ids[0]);
    }

    [Theory]
    [InlineData("missing-site")]
    [InlineData("no-auth")]
    [InlineData("unknown-session")]
    [InlineData("expired-package")]
    public async Task Issuance_RefusesMissingTrustedInputs(string input)
    {
        await using Harness host = await CreateAsync();
        VerifiedAuthoringPackage package = s_package;
        if (input == "missing-site")
        {
            host.Configuration["AuthoringExtensions:SiteId"] = null;
        }
        if (input == "no-auth")
        {
            host.Context.User = new ClaimsPrincipal();
        }
        if (input == "unknown-session")
        {
            host.Context.User = Actor(1, "unknown").User;
        }
        if (input == "expired-package")
        {
            package = package with
            {
                Trust = package.Trust with
                {
                    ValidUntil = DateTimeOffset.UtcNow.AddMinutes(-1)
                }
            };
        }
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Issuer.BeginAsync(host.Context, package).AsTask());
    }

    private Task<Harness> CreateAsync() => CreateHarnessAsync(postgres);

    internal static async Task<Harness> CreateHarnessAsync(PostgresSchemaMigrationFixture postgres)
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(postgres);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(db, typeof(AdminPrincipal), typeof(AdminSession));
        await db.Ado.ExecuteCommandAsync(AuthoringExtensionStateStorageSchema.CreateTablesSql);
        await db.Ado.ExecuteCommandAsync(AuthoringExtensionScopeProvenanceStorageSchema.CreateTablesSql);
        db.Insertable(new[]
        {
            new AdminPrincipal { Handle = "provenance-first", Permissions = AdminPermissions.SystemConfig },
            new AdminPrincipal { Handle = "provenance-root", Permissions = string.Join('\n', AdminPermissions.All) }
        }).ExecuteCommand();
        db.Insertable(new[]
        {
            new AdminSession { SessionId = "session-1", AdminPrincipalId = 1,
                IdleExpiresAtUtc = DateTime.UtcNow.AddMinutes(30), AbsoluteExpiresAtUtc = DateTime.UtcNow.AddHours(1) },
            new AdminSession { SessionId = "session-2", AdminPrincipalId = 2,
                IdleExpiresAtUtc = DateTime.UtcNow.AddMinutes(30), AbsoluteExpiresAtUtc = DateTime.UtcNow.AddHours(1) }
        }).ExecuteCommand();
        return new(connectionString);
    }

    private static DefaultHttpContext Actor(long id, string? session = null) => new()
    {
        User = new ClaimsPrincipal(new ClaimsIdentity(new[]
        {
            new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
            new Claim("admin_id", id.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            new Claim("admin_sid", session ?? $"session-{id}")
        }, "fixture-admin"))
    };

    internal sealed class Harness : IAsyncDisposable
    {
        private readonly string _connectionString;
        internal string ConnectionString => _connectionString;
        public NpgsqlDataSource DataSource
        {
            get;
        }
        public IConfigurationRoot Configuration
        {
            get;
        } = new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["AuthoringExtensions:SiteId"] = "configured-site" }).Build();
        public DefaultHttpContext Context { get; } = Actor(1);
        public PostgresAuthoringExtensionScopeProvenanceStore Store
        {
            get;
        }
        public AuthoringExtensionScopeProvenanceAuthority Authority
        {
            get;
        }
        public AuthoringExtensionStateScopeIssuer Issuer
        {
            get;
        }

        public Harness(string connectionString)
        {
            _connectionString = connectionString;
            DataSource = NpgsqlDataSource.Create(connectionString);
            Store = new(DataSource, Configuration);
            Authority = new(Store);
            Issuer = new(DataSource, Configuration, Store);
        }

        public SqlSugarClient Client() => PostgresSqlSugarTestClient.Create(_connectionString);
        public Task<AuthoringExtensionScopeRegistration> BeginAsync() => Issuer.BeginAsync(Context, s_package).AsTask();
        public Task<AuthoringStateScope> CompleteAsync(AuthoringExtensionScopeRegistration registration) =>
            Issuer.CompleteAsync(Context, s_package, registration.RegistrationId).AsTask();
        public ValueTask<IAuthoringExtensionApprovalScope> AcquireAsync(AuthoringStateScope scope) =>
            Authority.AcquireAsync(Context, AuthoringApprovalOperation.Deletion, scope, null, default);
        public async Task RefuseAsync(AuthoringStateScope scope) =>
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => AcquireAsync(scope).AsTask());

        public async Task InitializeOriginalAsync(AuthoringExtensionScopeRegistration registration, bool marker)
        {
            using var db = new SqlSugarClient(new ConnectionConfig
            {
                ConnectionString = _connectionString,
                DbType = SqlSugar.DbType.PostgreSQL,
                IsAutoCloseConnection = false
            });
            if (marker)
            {
                await db.Ado.GetScalarAsync("SELECT set_config('fsus.authoring_scope_registration', @Id, false)",
                    new SugarParameter("@Id", registration.RegistrationId));
            }
            await new PostgresAuthoringExtensionStateStore(db).InitializeAsync(s_package, registration.Scope, default);
        }

        public async Task SqlAsync(string sql, params object[] values)
        {
            await using NpgsqlConnection connection = await DataSource.OpenConnectionAsync();
            await using var command = new NpgsqlCommand(sql, connection) { CommandTimeout = 5 };
            foreach (object value in values)
            {
                command.Parameters.AddWithValue(value);
            }
            await command.ExecuteNonQueryAsync();
        }

        public async Task WaitForBlockedWriterAsync()
        {
            long started = Stopwatch.GetTimestamp();
            while (Stopwatch.GetElapsedTime(started) < TimeSpan.FromSeconds(3))
            {
                await using NpgsqlConnection connection = await DataSource.OpenConnectionAsync();
                await using var command = new NpgsqlCommand("""
                    SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                        WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0)
                    """, connection);
                if (await command.ExecuteScalarAsync() is true)
                {
                    return;
                }
                await Task.Delay(10);
            }
            Assert.Fail("Expected a real PostgreSQL writer blocked by held provenance custody.");
        }

        public ValueTask DisposeAsync() => DataSource.DisposeAsync();
    }
}
