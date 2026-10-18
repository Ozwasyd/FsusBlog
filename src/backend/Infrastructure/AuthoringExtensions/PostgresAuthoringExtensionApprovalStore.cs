using System.Text.Json;

using FsusBlog.Server.Infrastructure.Auth;

using Microsoft.AspNetCore.DataProtection;

using Npgsql;

using static FsusBlog.Server.Infrastructure.AuthoringExtensions.AuthoringExtensionStateContract;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>
/// Owns PostgreSQL transactions; locks real admin rows and the existing lifecycle advisory key.
/// No fallback store, schema creation, permission cache or caller-supplied authorization snapshot.
/// </summary>
public sealed class PostgresAuthoringExtensionApprovalStore(NpgsqlDataSource dataSource, IDataProtectionProvider protection)
{
    private readonly IDataProtector _protector = protection.CreateProtector("FsusBlog.AuthoringExtensionApproval.v1");

    internal async ValueTask<AuthoringApprovalDecision> CreateAsync(
        long principalId, string sessionId, string siteId,
        Func<AuthoringApprovalActor, AuthoringApprovalDecision> prepare, CancellationToken cancellationToken)
    {
        await using NpgsqlConnection connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync(cancellationToken);
        AuthoringApprovalActor actor = await ActorAsync(connection, principalId, sessionId, siteId, cancellationToken);
        AuthoringApprovalDecision decision = prepare(actor);
        await FenceLifecycleAsync(connection, decision.ExpectedLifecycleReceipt, cancellationToken);
        Require(await ActorAsync(connection, principalId, sessionId, siteId, cancellationToken) == actor,
            "approval_actor_expired_or_changed_before_commit");
        decision = decision with { ExpiresAt = (await NowAsync(connection, cancellationToken)).AddMinutes(5) };
        await WriteAsync(connection, decision, true, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return decision;
    }

    internal async ValueTask<AuthoringApprovalDecision> ChangeAsync(
        string decisionId, long principalId, string sessionId, string siteId,
        Func<AuthoringApprovalDecision, CancellationToken, ValueTask<AuthoringApprovalDecision>> change,
        CancellationToken cancellationToken, bool fenceLifecycle = true)
    {
        Require(IsDigest(decisionId), "approval_decision_id_invalid");
        await using NpgsqlConnection connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync(cancellationToken);
        AuthoringApprovalActor actor = await ActorAsync(connection, principalId, sessionId, siteId, cancellationToken);
        AuthoringApprovalDecision current;
        await using (var command = new NpgsqlCommand("""
            SELECT status, revision, protected_payload, operation_sha256 FROM authoring_extension_approval_decision
            WHERE decision_id = $1 FOR UPDATE;
            """, connection))
        {
            command.Parameters.AddWithValue(decisionId);
            await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken);
            Require(await reader.ReadAsync(cancellationToken), "approval_decision_missing");
            current = Decode(reader.GetFieldValue<byte[]>(2));
            Require(current.DecisionId == decisionId && (int)current.Status == reader.GetInt16(0) &&
                current.Revision == reader.GetInt64(1) && current.OperationSha256 == reader.GetString(3), "approval_decision_tampered");
        }
        await ValidateJournalAsync(connection, current, cancellationToken);
        Require(current.Actor == actor, "approval_actor_site_or_permission_drift");
        // Expiration itself is durable even when the attempted claim is rejected after commit.
        AuthoringApprovalDecision next;
        if (current.Status is AuthoringApprovalStatus.Pending or AuthoringApprovalStatus.Approved &&
            current.ExpiresAt <= await NowAsync(connection, cancellationToken))
        {
            next = current with { Status = AuthoringApprovalStatus.Expired };
        }
        else
        {
            next = await change(current, cancellationToken);
            if (fenceLifecycle)
            {
                await FenceLifecycleAsync(connection, current.ExpectedLifecycleReceipt, cancellationToken);
            }
        }
        // Time may advance while state/receipt owners or a concurrent generation hold locks.
        // Recheck both SQL session lifetime and decision expiry at the final durable transition.
        Require(await ActorAsync(connection, principalId, sessionId, siteId, cancellationToken) == actor,
            "approval_actor_expired_or_changed_before_commit");
        if (current.Status is AuthoringApprovalStatus.Pending or AuthoringApprovalStatus.Approved &&
            next.Status is AuthoringApprovalStatus.Approved or AuthoringApprovalStatus.Claimed &&
            current.ExpiresAt <= await NowAsync(connection, cancellationToken))
        {
            next = current with { Status = AuthoringApprovalStatus.Expired };
        }
        if (next != current)
        {
            Require(IsTransitionAllowed(current.Status, next.Status), "approval_transition_invalid");
            next = next with { Revision = checked(current.Revision + 1) };
            await WriteAsync(connection, next, false, cancellationToken);
        }
        await transaction.CommitAsync(cancellationToken);
        return next;
    }

    // Recovery settlement intentionally does not require the old lifecycle head: the operation
    // may have appended a failure or result before crashing. It requires the exact issued claim.
    internal async ValueTask SettleAsync(AuthoringExtensionApprovalAuthority.ApprovedClaim claim,
        AuthoringApprovalStatus terminal, string? resultReceiptSha256, CancellationToken cancellationToken)
    {
        Require(terminal is AuthoringApprovalStatus.Completed or AuthoringApprovalStatus.Failed or AuthoringApprovalStatus.RecoveryRequired,
            "approval_terminal_invalid");
        Require(resultReceiptSha256 is null || IsDigest(resultReceiptSha256), "approval_result_digest_invalid");
        Require(terminal != AuthoringApprovalStatus.Completed || resultReceiptSha256 is not null, "approval_result_missing");
        await using NpgsqlConnection connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync(cancellationToken);
        AuthoringApprovalDecision current;
        await using (var command = new NpgsqlCommand("""
            SELECT status, revision, protected_payload, operation_sha256 FROM authoring_extension_approval_decision WHERE decision_id = $1 FOR UPDATE;
            """, connection))
        {
            command.Parameters.AddWithValue(claim.DecisionId);
            await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken);
            Require(await reader.ReadAsync(cancellationToken), "approval_decision_missing");
            current = Decode(reader.GetFieldValue<byte[]>(2));
            Require(current.DecisionId == claim.DecisionId && (int)current.Status == reader.GetInt16(0) &&
                current.Revision == reader.GetInt64(1) && current.OperationSha256 == reader.GetString(3), "approval_decision_tampered");
        }
        await ValidateJournalAsync(connection, current, cancellationToken);
        Require(claim.Matches(current), "approval_claim_mismatch");
        if (current.Status == terminal && current.ResultReceiptSha256 == resultReceiptSha256)
        {
            await transaction.CommitAsync(cancellationToken);
            return;
        }
        Require(current.Status == AuthoringApprovalStatus.Claimed, "approval_claim_already_settled");
        await WriteAsync(connection, current with
        {
            Status = terminal,
            Revision = checked(current.Revision + 1),
            ResultReceiptSha256 = resultReceiptSha256
        }, false, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public static bool IsTransitionAllowed(AuthoringApprovalStatus from, AuthoringApprovalStatus to) => (from, to) switch
    {
        (AuthoringApprovalStatus.Pending, AuthoringApprovalStatus.Approved or AuthoringApprovalStatus.Denied or
            AuthoringApprovalStatus.Revoked or AuthoringApprovalStatus.Expired) => true,
        (AuthoringApprovalStatus.Approved, AuthoringApprovalStatus.Claimed or AuthoringApprovalStatus.Revoked or
            AuthoringApprovalStatus.Expired) => true,
        (AuthoringApprovalStatus.Claimed, AuthoringApprovalStatus.Completed or AuthoringApprovalStatus.Failed or
            AuthoringApprovalStatus.RecoveryRequired) => true,
        _ => false
    };

    private async Task WriteAsync(NpgsqlConnection connection, AuthoringApprovalDecision decision, bool insert, CancellationToken token)
    {
        byte[] payload = _protector.Protect(JsonSerializer.SerializeToUtf8Bytes(decision));
        Require(payload.Length <= 25165824, "approval_payload_unbounded");
        string sql = insert ? """
            INSERT INTO authoring_extension_approval_decision(decision_id,status,revision,protected_payload,operation_sha256)
            VALUES ($1,$2,$3,$4,$5);
            """ : """
            UPDATE authoring_extension_approval_decision SET status=$2,revision=$3,protected_payload=$4
            WHERE decision_id=$1 AND revision=$3-1 AND operation_sha256=$5;
            """;
        await using (var command = new NpgsqlCommand(sql, connection))
        {
            command.Parameters.AddWithValue(decision.DecisionId);
            command.Parameters.AddWithValue((short)decision.Status);
            command.Parameters.AddWithValue(decision.Revision);
            command.Parameters.AddWithValue(payload);
            command.Parameters.AddWithValue(decision.OperationSha256);
            Require(await command.ExecuteNonQueryAsync(token) == 1, "approval_cas_failed");
        }
        await using var audit = new NpgsqlCommand("""
            INSERT INTO authoring_extension_approval_event(decision_id,revision,status,protected_payload)
            VALUES ($1,$2,$3,$4);
            """, connection);
        audit.Parameters.AddWithValue(decision.DecisionId);
        audit.Parameters.AddWithValue(decision.Revision);
        audit.Parameters.AddWithValue((short)decision.Status);
        audit.Parameters.AddWithValue(payload);
        await audit.ExecuteNonQueryAsync(token);
    }

    private async Task ValidateJournalAsync(NpgsqlConnection connection, AuthoringApprovalDecision current, CancellationToken token)
    {
        await using var command = new NpgsqlCommand("""
            SELECT revision,status,protected_payload FROM authoring_extension_approval_event
            WHERE decision_id=$1 ORDER BY revision;
            """, connection);
        command.Parameters.AddWithValue(current.DecisionId);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(token);
        AuthoringApprovalDecision? previous = null;
        while (await reader.ReadAsync(token))
        {
            AuthoringApprovalDecision item = Decode(reader.GetFieldValue<byte[]>(2));
            Require(item.DecisionId == current.DecisionId && item.Revision == reader.GetInt64(0) &&
                (int)item.Status == reader.GetInt16(1) && item.Revision == (previous?.Revision ?? -1) + 1 &&
                (previous is null ? item.Status == AuthoringApprovalStatus.Pending :
                    IsTransitionAllowed(previous.Status, item.Status) &&
                    Digest(item with { Status = previous.Status, Revision = previous.Revision, ResultReceiptSha256 = previous.ResultReceiptSha256 }) == Digest(previous)),
                "approval_journal_tampered");
            previous = item;
        }
        Require(previous is not null && Digest(previous) == Digest(current), "approval_journal_head_mismatch");
    }

    private AuthoringApprovalDecision Decode(byte[] payload)
    {
        Require(payload.Length <= 25165824, "approval_payload_unbounded");
        AuthoringApprovalDecision decision = JsonSerializer.Deserialize<AuthoringApprovalDecision>(_protector.Unprotect(payload))
            ?? throw new AuthoringExtensionContractException("approval_payload_missing");
        Require(decision.ContractVersion == 1 && Enum.IsDefined(decision.Status) && Enum.IsDefined(decision.Operation),
            "approval_contract_invalid");
        return decision;
    }

    private static async Task<AuthoringApprovalActor> ActorAsync(NpgsqlConnection connection,
        long principalId, string sessionId, string siteId, CancellationToken token)
    {
        // Lock separately so the order is explicit and concurrent revocation cannot pass the claim commit.
        string principalVersion;
        string permissions;
        long principalValidationVersion;
        await using (var command = new NpgsqlCommand("""
            SELECT xmin::text, permissions, validationversion FROM admin_principal
            WHERE id=$1 AND status='active' FOR SHARE;
            """, connection))
        {
            command.Parameters.AddWithValue(principalId);
            await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(token);
            Require(await reader.ReadAsync(token), "approval_principal_inactive");
            principalVersion = reader.GetString(0);
            permissions = reader.GetString(1);
            principalValidationVersion = reader.GetInt64(2);
            Require(permissions.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Contains(AdminPermissions.SystemConfig, StringComparer.Ordinal), "approval_permission_denied");
        }
        await using var session = new NpgsqlCommand("""
            SELECT xmin::text, validationversion FROM admin_session
            WHERE sessionid=$1 AND adminprincipalid=$2 AND revokedatutc IS NULL
                AND idleexpiresatutc > clock_timestamp() AND absoluteexpiresatutc > clock_timestamp()
            FOR SHARE;
            """, connection);
        session.Parameters.AddWithValue(sessionId);
        session.Parameters.AddWithValue(principalId);
        await using NpgsqlDataReader sessionReader = await session.ExecuteReaderAsync(token);
        Require(await sessionReader.ReadAsync(token), "approval_session_inactive");
        return new(principalId, sessionId, siteId, principalVersion, sessionReader.GetString(0), permissions,
            principalValidationVersion, sessionReader.GetInt64(1));
    }

    private static async Task FenceLifecycleAsync(NpgsqlConnection connection, AuthoringLifecycleReceipt expected, CancellationToken token)
    {
        await using (var command = new NpgsqlCommand("SELECT pg_advisory_xact_lock(hashtextextended($1, 0));", connection))
        {
            command.Parameters.AddWithValue($"authoring-lifecycle-receipt:{expected.ExtensionId}");
            await command.ExecuteNonQueryAsync(token);
        }
        await using var latest = new NpgsqlCommand("""
            SELECT receipt_sha256, generation FROM authoring_lifecycle_receipt
            WHERE extension_id=$1 ORDER BY sequence DESC LIMIT 1;
            """, connection);
        latest.Parameters.AddWithValue(expected.ExtensionId);
        await using NpgsqlDataReader reader = await latest.ExecuteReaderAsync(token);
        Require(await reader.ReadAsync(token) && reader.GetString(0) == expected.ReceiptSha256 &&
            reader.GetInt64(1) == expected.Generation, "approval_lifecycle_drift");
    }

    private static async Task<DateTimeOffset> NowAsync(NpgsqlConnection connection, CancellationToken token)
    {
        await using var command = new NpgsqlCommand("SELECT clock_timestamp();", connection);
        return new DateTimeOffset((DateTime)(await command.ExecuteScalarAsync(token))!);
    }
}
