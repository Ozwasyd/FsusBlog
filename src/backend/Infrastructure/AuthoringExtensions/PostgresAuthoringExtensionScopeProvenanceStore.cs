using System.Text.Json;

using Npgsql;

using static FsusBlog.Server.Infrastructure.AuthoringExtensions.AuthoringExtensionStateContract;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>
/// Owns provenance connections and transactions. SHARE (not KEY SHARE) excludes every ordinary
/// UPDATE/DELETE, including direct SQL revocation. No admin FK or independently held actor lock
/// is introduced. Original insertion/delete triggers acquire state then provenance: integration
/// must account for that real writer order, not assume provenance-before-state is globally safe.
/// </summary>
public sealed class PostgresAuthoringExtensionScopeProvenanceStore(
    NpgsqlDataSource dataSource, IConfiguration configuration)
{
    private sealed record Stored(string RegistrationId, string ScopeId, long Owner, string Policy,
        short Status, long Revision, AuthoringStateScope Scope, string PackageIdentity,
        byte[] InitialPayload, bool CreationSeen)
    {
        public string Authorization => Digest(new
        {
            RegistrationId,
            ScopeId,
            Owner,
            Policy,
            Status,
            Revision,
            Scope,
            PackageIdentity,
            CreationSeen,
            InitialPayloadSha256 = Digest(InitialPayload)
        });
    }

    internal async ValueTask<AuthoringExtensionScopeRegistration> BeginAsync(long owner,
        VerifiedAuthoringPackage package, AuthoringExtensionScopeRegistration registration, CancellationToken token)
    {
        await using NpgsqlConnection connection = await dataSource.OpenConnectionAsync(token);
        await using var command = new NpgsqlCommand("""
            INSERT INTO authoring_extension_scope_provenance
                (registration_id,scope_id,owner_admin_principal_id,policy_version,status,revision,
                 scope_payload,package_identity,initial_payload,creation_seen)
            VALUES ($1,$2,$3,$4,0,0,$5,$6,$7,false)
            ON CONFLICT DO NOTHING;
            """, connection);
        command.Parameters.AddWithValue(registration.RegistrationId);
        command.Parameters.AddWithValue(ScopeId(registration.Scope));
        command.Parameters.AddWithValue(owner);
        command.Parameters.AddWithValue(AuthoringExtensionStateScopeIssuer.PolicyVersion);
        command.Parameters.AddWithValue(Encode(registration.Scope));
        command.Parameters.AddWithValue(package.PackageIdentity);
        command.Parameters.AddWithValue(Encode(Snapshot(registration.Scope, package.PackageIdentity, 0, [])));
        Require(await command.ExecuteNonQueryAsync(token) == 1, "scope_registration_collision");
        return registration;
    }

    internal async ValueTask<AuthoringExtensionScopeRegistration> ReadRegistrationAsync(NpgsqlConnection connection,
        string registrationId, long owner, string site, VerifiedAuthoringPackage package, CancellationToken token)
    {
        Require(IsDigest(registrationId), "scope_registration_id_invalid");
        Stored stored = await ReadAsync(connection, "registration_id", registrationId, false, token);
        Require(stored.Owner == owner && stored.Scope.SiteId == site && stored.PackageIdentity == package.PackageIdentity &&
            stored.Status is 0 or 1, "scope_registration_owner_or_status_mismatch");
        AuthoringExtensionStateScopeIssuer.ValidatePackage(package, stored.Scope);
        return new(registrationId, stored.Scope);
    }

    internal async ValueTask ActivateAsync(NpgsqlConnection connection, AuthoringExtensionScopeRegistration registration,
        long owner, string session, VerifiedAuthoringPackage package, Action verifyRequest, CancellationToken token)
    {
        await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync(token);
        string scopeId = ScopeId(registration.Scope);
        // Match the real original writer order. A state DELETE holds the state row before its
        // provenance tombstone trigger; never wait on that row while holding provenance here.
        await using (var stateLock = new NpgsqlCommand(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 2143));", connection))
        {
            stateLock.Parameters.AddWithValue($"authoring-extension-state:{scopeId}");
            await stateLock.ExecuteNonQueryAsync(token);
        }
        byte[] payload;
        long revision;
        bool unfenced;
        await using (var state = new NpgsqlCommand(
            "SELECT payload,revision,fence IS NULL FROM authoring_extension_state_scope WHERE scope_id=$1 FOR SHARE;", connection))
        {
            state.Parameters.AddWithValue(scopeId);
            await using NpgsqlDataReader reader = await state.ExecuteReaderAsync(token);
            Require(await reader.ReadAsync(token), "scope_original_creation_missing");
            payload = reader.GetFieldValue<byte[]>(0);
            revision = reader.GetInt64(1);
            unfenced = reader.GetBoolean(2);
        }
        Stored stored = await ReadAsync(connection, "registration_id", registration.RegistrationId, true, token);
        Require(stored.Owner == owner && stored.Scope == registration.Scope && stored.PackageIdentity == package.PackageIdentity &&
            stored.CreationSeen && stored.Status is 0 or 1, "scope_exact_original_creation_unproven");
        verifyRequest();
        AuthoringExtensionStateScopeIssuer.ValidatePackage(package, stored.Scope);
        await AuthoringExtensionStateScopeIssuer.RequireLiveActorAsync(connection, owner, session, token);
        if (stored.Status == 0)
        {
            Require(stored.Revision == 0 && revision == 0 && unfenced && payload.AsSpan().SequenceEqual(stored.InitialPayload) &&
                payload.AsSpan().SequenceEqual(Encode(Snapshot(stored.Scope, package.PackageIdentity, 0, []))),
                "scope_initial_creation_changed");
            await using var activate = new NpgsqlCommand("""
                UPDATE authoring_extension_scope_provenance SET status=1,revision=revision+1
                WHERE registration_id=$1 AND status=0 AND revision=0 AND creation_seen;
                """, connection);
            activate.Parameters.AddWithValue(registration.RegistrationId);
            Require(await activate.ExecuteNonQueryAsync(token) == 1, "scope_activation_cas_failed");
        }
        await transaction.CommitAsync(token);
    }

    /// <summary>Revocation is durable; a registration can never return from Revoked to Active.</summary>
    public async ValueTask RevokeAsync(HttpContext context, string registrationId, CancellationToken cancellationToken = default)
    {
        var actor = AuthoringExtensionStateScopeIssuer.Actor(context, configuration);
        Require(IsDigest(registrationId), "scope_registration_id_invalid");
        await using NpgsqlConnection connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await AuthoringExtensionStateScopeIssuer.RequireLiveActorAsync(connection, actor.Id, actor.SessionId, cancellationToken);
        await using var command = new NpgsqlCommand("""
            UPDATE authoring_extension_scope_provenance SET status=2,revision=revision+1
            WHERE registration_id=$1 AND owner_admin_principal_id=$2 AND status<>2
                AND scope_payload=$3;
            """, connection);
        Stored stored = await ReadAsync(connection, "registration_id", registrationId, false, cancellationToken);
        Require(stored.Owner == actor.Id && stored.Scope.SiteId == actor.SiteId, "scope_revoke_owner_mismatch");
        command.Parameters.AddWithValue(registrationId);
        command.Parameters.AddWithValue(actor.Id);
        command.Parameters.AddWithValue(Encode(stored.Scope));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    internal async ValueTask<IAuthoringExtensionApprovalScope> AcquireAsync(HttpContext context,
        AuthoringApprovalOperation operation, AuthoringStateScope scope, AuthoringStateScope? destination, CancellationToken token)
    {
        var actor = AuthoringExtensionStateScopeIssuer.Actor(context, configuration);
        Require(scope.SiteId == actor.SiteId && scope.DocumentId is null &&
            (destination is null || destination.SiteId == actor.SiteId && destination.DocumentId is null), "scope_site_or_document_mismatch");
        NpgsqlConnection connection = await dataSource.OpenConnectionAsync(token);
        NpgsqlTransaction? transaction = null;
        try
        {
            transaction = await connection.BeginTransactionAsync(token);
            var witnesses = new List<Stored>();
            foreach (AuthoringStateScope item in (destination is null ? new[] { scope } : new[] { scope, destination })
                .OrderBy(ScopeId, StringComparer.Ordinal))
            {
                Stored stored = await ReadAsync(connection, "scope_id", ScopeId(item), true, token);
                Require(stored.Scope == item && stored.Owner == actor.Id && stored.Status == 1 && stored.CreationSeen &&
                    stored.Scope.DocumentId is null, "scope_active_exact_owner_required");
                witnesses.Add(stored);
            }
            var held = new Held(connection, transaction, context, configuration, actor, operation, scope, destination, witnesses);
            await held.VerifyCurrentAsync(token);
            return held;
        }
        catch
        {
            if (transaction is not null)
            {
                await transaction.DisposeAsync();
            }
            await connection.DisposeAsync();
            throw;
        }
    }

    private static async ValueTask<Stored> ReadAsync(NpgsqlConnection connection, string column, string id, bool hold, CancellationToken token)
    {
        // column comes only from the two fixed internal call sites, never caller input.
        Require(column is "scope_id" or "registration_id", "scope_lookup_invalid");
        await using var command = new NpgsqlCommand($"""
            SELECT registration_id,scope_id,owner_admin_principal_id,policy_version,status,revision,
                scope_payload,package_identity,initial_payload,creation_seen
            FROM authoring_extension_scope_provenance WHERE {column}=$1{(hold ? " FOR SHARE" : "")};
            """, connection);
        command.Parameters.AddWithValue(id);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(token);
        Require(await reader.ReadAsync(token), "scope_provenance_missing");
        byte[] bytes = reader.GetFieldValue<byte[]>(6);
        Require(bytes.Length <= 8192, "scope_provenance_unbounded");
        AuthoringStateScope scope = JsonSerializer.Deserialize<AuthoringStateScope>(bytes, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            ?? throw new AuthoringExtensionContractException("scope_provenance_invalid");
        Require(bytes.AsSpan().SequenceEqual(Encode(scope)) && ScopeId(scope) == reader.GetString(1) &&
            reader.GetString(3) == AuthoringExtensionStateScopeIssuer.PolicyVersion && IsDigest(reader.GetString(7)),
            "scope_provenance_identity_or_policy_changed");
        return new(reader.GetString(0), reader.GetString(1), reader.GetInt64(2), reader.GetString(3),
            reader.GetInt16(4), reader.GetInt64(5), scope, reader.GetString(7), reader.GetFieldValue<byte[]>(8), reader.GetBoolean(9));
    }

    private sealed class Held(NpgsqlConnection connection, NpgsqlTransaction transaction, HttpContext context,
        IConfiguration configuration, (long Id, string SessionId, string SiteId) actor,
        AuthoringApprovalOperation operation, AuthoringStateScope source, AuthoringStateScope? destination,
        List<Stored> witnesses) : IAuthoringExtensionApprovalScope
    {
        private bool _disposed;
        public string AuthorizationSha256
        {
            get;
        } = Digest(new
        {
            Policy = AuthoringExtensionStateScopeIssuer.PolicyVersion,
            operation,
            Source = source,
            Destination = destination,
            Witnesses = witnesses.Select(static row => row.Authorization).ToArray()
        });

        public async ValueTask VerifyCurrentAsync(CancellationToken cancellationToken)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            Require(connection.State == System.Data.ConnectionState.Open && transaction.Connection == connection,
                "scope_connection_custody_lost");
            Require(AuthoringExtensionStateScopeIssuer.Actor(context, configuration) == actor, "scope_request_actor_or_site_changed");
            await AuthoringExtensionStateScopeIssuer.RequireLiveActorAsync(connection, actor.Id, actor.SessionId, cancellationToken);
            foreach (Stored expected in witnesses)
            {
                Stored current = await ReadAsync(connection, "scope_id", expected.ScopeId, false, cancellationToken);
                Require(current.Authorization == expected.Authorization && current.Status == 1 && current.CreationSeen,
                    "scope_provenance_no_longer_current");
                await using var exists = new NpgsqlCommand(
                    "SELECT EXISTS(SELECT 1 FROM authoring_extension_state_scope WHERE scope_id=$1);", connection);
                exists.Parameters.AddWithValue(expected.ScopeId);
                Require(await exists.ExecuteScalarAsync(cancellationToken) is true, "scope_original_deleted");
            }
        }

        public async ValueTask DisposeAsync()
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;
            try
            {
                await transaction.DisposeAsync();
            }
            finally
            {
                await connection.DisposeAsync();
            }
        }
    }
}
