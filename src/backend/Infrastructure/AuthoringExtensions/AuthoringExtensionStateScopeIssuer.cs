using System.Security.Cryptography;

using FsusBlog.Server.Infrastructure.Helpers;

using Npgsql;

using SqlSugar;

using static FsusBlog.Server.Infrastructure.AuthoringExtensions.AuthoringExtensionStateContract;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>A locator for one durable server-created Pending record; never an authority token.</summary>
public sealed record AuthoringExtensionScopeRegistration(string RegistrationId, AuthoringStateScope Scope);

/// <summary>
/// Server-only issuance wrapper. Begin persists Pending before the original initializer runs.
/// Retain its locator for retry; Complete can only resume that exact record and verified package.
/// Document scopes are deliberately refused until the canonical document owner supplies custody.
/// </summary>
public sealed class AuthoringExtensionStateScopeIssuer(
    NpgsqlDataSource dataSource,
    IConfiguration configuration,
    PostgresAuthoringExtensionScopeProvenanceStore provenance)
{
    public const string PolicyVersion = "server-issued-self-owned-state-v1";

    public async ValueTask<AuthoringExtensionScopeRegistration> BeginAsync(HttpContext context,
        VerifiedAuthoringPackage package, AuthoringStateScope? migrationSource = null,
        CancellationToken cancellationToken = default)
    {
        var actor = Actor(context, configuration);
        await using NpgsqlConnection connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await RequireLiveActorAsync(connection, actor.Id, actor.SessionId, cancellationToken);
        string userId = RandomId();
        if (migrationSource is not null)
        {
            await using IAuthoringExtensionApprovalScope held = await provenance.AcquireAsync(
                context, AuthoringApprovalOperation.Deletion, migrationSource, null, cancellationToken);
            Require(migrationSource.ExtensionId == package.Contract.Manifest.Id, "scope_issuance_extension_mismatch");
            userId = migrationSource.UserId;
            // The relation has the same durable owner and opaque user. The destination still
            // needs its own Pending -> insertion witness -> Active registration.
            return await BeginCoreAsync(actor.Id, actor.SiteId, userId, package, cancellationToken);
        }
        return await BeginCoreAsync(actor.Id, actor.SiteId, userId, package, cancellationToken);
    }

    private ValueTask<AuthoringExtensionScopeRegistration> BeginCoreAsync(long owner, string site,
        string userId, VerifiedAuthoringPackage package, CancellationToken token)
    {
        var scope = new AuthoringStateScope(package.Contract.Manifest.Id, package.Contract.Manifest.Version,
            site, userId, null, package.Contract.Manifest.StateSchemaVersion);
        ValidatePackage(package, scope);
        return provenance.BeginAsync(owner, package, new(RandomId(), scope), token);
    }

    public async ValueTask<AuthoringStateScope> CompleteAsync(HttpContext context,
        VerifiedAuthoringPackage package, string registrationId, CancellationToken cancellationToken = default)
    {
        var actor = Actor(context, configuration);
        await using NpgsqlConnection connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await RequireLiveActorAsync(connection, actor.Id, actor.SessionId, cancellationToken);
        AuthoringExtensionScopeRegistration registration = await provenance.ReadRegistrationAsync(
            connection, registrationId, actor.Id, actor.SiteId, package, cancellationToken);
        ValidatePackage(package, registration.Scope);

        // An exclusively owned original-store connection. Session configuration is never put on
        // an ambient/shared client; the original transaction owns its INSERT and witness together.
        await using NpgsqlConnection initializer = await dataSource.OpenConnectionAsync(cancellationToken);
        using var db = new SqlSugarClient(new ConnectionConfig
        {
            ConnectionString = dataSource.ConnectionString,
            DbType = SqlSugar.DbType.PostgreSQL,
            IsAutoCloseConnection = false
        });
        // DataSource.ConnectionString deliberately redacts credentials. Reuse its actual opened
        // connection instead of reconstructing an independently authenticated SQL client.
        db.Ado.Connection = initializer;
        try
        {
            db.Ado.CancellationToken = cancellationToken;
            _ = await db.Ado.GetScalarAsync("SELECT set_config('fsus.authoring_scope_registration', @Id, false);",
                new SugarParameter("@Id", registration.RegistrationId));
            await new PostgresAuthoringExtensionStateStore(db).InitializeAsync(package, registration.Scope, cancellationToken);
        }
        finally
        {
            // Disposal closes the exclusively owned connection, including on cancellation/failure.
            // RESET prevents a pooled session retaining an issuance marker after successful use.
            db.Ado.CancellationToken = null;
            if (db.Ado.Connection.State == System.Data.ConnectionState.Open)
            {
                await db.Ado.ExecuteCommandAsync("RESET fsus.authoring_scope_registration;");
            }
        }
        await RequireLiveActorAsync(connection, actor.Id, actor.SessionId, cancellationToken);
        await provenance.ActivateAsync(connection, registration, actor.Id, actor.SessionId, package,
            () => Require(Actor(context, configuration) == actor, "scope_issuance_actor_or_site_changed"), cancellationToken);
        return registration.Scope;
    }

    internal static string RandomId() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));

    internal static (long Id, string SessionId, string SiteId) Actor(HttpContext context, IConfiguration configuration)
    {
        Require(context.User.Identity?.IsAuthenticated == true && context.User.IsAdminPrincipal(), "scope_authenticated_admin_required");
        Require(context.User.TryGetAdminPrincipalId(out long id) && id > 0, "scope_admin_id_missing");
        string? session = context.User.GetAdminSessionId();
        string? site = configuration["AuthoringExtensions:SiteId"];
        Require(IsField(session, 64) && IsField(site, 256), "scope_session_or_explicit_site_missing");
        return (id, session!, site!);
    }

    internal static void ValidatePackage(VerifiedAuthoringPackage package, AuthoringStateScope scope)
    {
        ValidateOwner(package, scope);
        Require(package.Trust.ValidUntil > DateTimeOffset.UtcNow, "scope_package_trust_expired");
        Require(scope.DocumentId is null, "scope_document_authority_unavailable");
    }

    internal static async ValueTask RequireLiveActorAsync(NpgsqlConnection connection, long id, string session, CancellationToken token)
    {
        // Read only: final admin/session exclusion belongs exclusively to the approval transaction.
        // In particular this leaf must not hold SHARE and cause a same-actor step-up UPDATE deadlock.
        await using var command = new NpgsqlCommand("""
            SELECT EXISTS(SELECT 1 FROM admin_principal p JOIN admin_session s ON s.adminprincipalid=p.id
                WHERE p.id=$1 AND p.status='active' AND s.sessionid=$2 AND s.revokedatutc IS NULL
                AND s.idleexpiresatutc > clock_timestamp() AND s.absoluteexpiresatutc > clock_timestamp());
            """, connection);
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(session);
        Require(await command.ExecuteScalarAsync(token) is true, "scope_actor_or_session_inactive");
    }
}
