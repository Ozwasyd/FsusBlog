using System.Security.Cryptography;
using System.Text.RegularExpressions;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminHandleProofRequiredException : Exception;

internal sealed partial class AdminHandleStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    [GeneratedRegex("^[a-z][a-z0-9_.-]{0,63}$", RegexOptions.CultureInvariant)]
    private static partial Regex HandlePattern();

    internal Task<byte[]> BeginRenameStepUp(string? session, AdminHandleCommand command, CancellationToken ct)
    {
        var normalized = NormalizeCommand(command);
        return stepUp.BeginStepUp(session, CommandFingerprint(normalized),
            (db, tx, admin) => VerifyRenamePreconditions(db, tx, admin, normalized, lockPrincipal: false, ct),
            ct, AdminStepUpAction.RenameAdminHandle);
    }

    internal Task<byte[]> CompleteRenameStepUp(string? session, PasskeyLoginRequest assertion, CancellationToken ct) =>
        stepUp.CompleteStepUp(session, assertion, AdminStepUpAction.RenameAdminHandle, ct);

    internal Task<(AdminHandleReceipt Receipt, string PermissionSession)> ExecuteRename(
        string? session, string? proof, AdminHandleCommand command, CancellationToken ct)
    {
        var normalized = NormalizeCommand(command);
        var fingerprint = CommandFingerprint(normalized);

        return gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            var permissionSession = AdminSessionGate.PermissionBinding(admin.Digest);
            await Store.LockCommand(db, tx, admin.Id, normalized.IdempotencyKey, ct);
            await using (var replay = Store.Sql(db, tx, """
                select fingerprint, next_handle, happened_at
                from public.admin_handle_rename_audit
                where principal_id = $1 and command_id = $2
                """, admin.Id, normalized.IdempotencyKey))
            await using (var existing = await replay.ExecuteReaderAsync(ct))
            {
                if (await existing.ReadAsync(ct))
                {
                    if (!CryptographicOperations.FixedTimeEquals(fingerprint, existing.GetFieldValue<byte[]>(0)))
                        throw new BusinessException(Rejection.Conflict, "This administrator command key is already in use.");
                    var replayed = new AdminHandleReceipt(
                        existing.GetString(1),
                        existing.GetUnixMilliseconds(2),
                        Replayed: true);
                    return (replayed, permissionSession);
                }
            }

            if (!await stepUp.ConsumeProofAsync(db, tx, admin, proof, fingerprint, ct, AdminStepUpAction.RenameAdminHandle))
                throw new AdminHandleProofRequiredException();

            var previousHandle = await VerifyRenamePreconditions(db, tx, admin, normalized, lockPrincipal: true, ct);

            try
            {
                if (await SqlCommands.Execute(db, tx, ct, """
                    update public.admin_principal
                    set handle = $2
                    where id = $1
                    """, admin.Id, normalized.NewHandle) != 1)
                    throw AdminSessionGate.Denied();
            }
            catch (PostgresException error) when (error.SqlState == PostgresErrorCodes.UniqueViolation)
            {
                throw new BusinessException(Rejection.Conflict, "This administrator handle is already in use.");
            }

            DateTimeOffset happenedAt;
            await using (var audit = Store.Sql(db, tx, """
                insert into public.admin_handle_rename_audit
                    (principal_id, command_id, fingerprint, previous_handle, next_handle)
                values ($1, $2, $3, $4, $5)
                returning happened_at
                """, admin.Id, normalized.IdempotencyKey, fingerprint, previousHandle, normalized.NewHandle))
            await using (var row = await audit.ExecuteReaderAsync(ct))
            {
                if (!await row.ReadAsync(ct))
                    throw new InvalidOperationException("Failed to record administrator handle rename audit.");
                happenedAt = row.GetFieldValue<DateTimeOffset>(0);
            }

            await SqlCommands.Execute(db, tx, ct, """
                insert into public.admin_identity_audit (principal_id, action, happened_at, actor)
                values ($1, 'rename-handle', $2, $3)
                """, admin.Id, happenedAt, $"{previousHandle}->{normalized.NewHandle}");

            return (new AdminHandleReceipt(normalized.NewHandle, happenedAt.ToUnixTimeMilliseconds(), Replayed: false), permissionSession);
        }, ct);
    }

    internal static AdminHandleCommand NormalizeCommand(AdminHandleCommand command)
    {
        if (command.IdempotencyKey == Guid.Empty)
            throw new BusinessException(Rejection.Invalid, "A command idempotency key is required.");
        var expected = (command.ExpectedHandle ?? "").Trim();
        var next = (command.NewHandle ?? "").Trim();
        if (!HandlePattern().IsMatch(expected) || !HandlePattern().IsMatch(next))
            throw new BusinessException(Rejection.Invalid, "Administrator handle must start with a lowercase letter and use only lowercase letters, digits, '.', '_' or '-'.");
        if (string.Equals(expected, next, StringComparison.Ordinal))
            throw new BusinessException(Rejection.Invalid, "The new administrator handle must differ from the current handle.");
        return new AdminHandleCommand(expected, next, command.IdempotencyKey);
    }

    internal static byte[] CommandFingerprint(AdminHandleCommand normalized) =>
        SHA256.HashData(Wire.EncodeAdminHandleCommand(normalized));

    private static async Task<string> VerifyRenamePreconditions(
        NpgsqlConnection db, NpgsqlTransaction tx, AdminLiveSession admin, AdminHandleCommand normalized,
        bool lockPrincipal, CancellationToken ct)
    {
        string currentHandle;
        await using (var query = Store.Sql(db, tx,
            "select handle from public.admin_principal where id = $1" + (lockPrincipal ? " for update" : ""),
            admin.Id))
        {
            currentHandle = (await query.ExecuteScalarAsync(ct) as string) ?? throw AdminSessionGate.Denied();
        }
        if (!string.Equals(currentHandle, normalized.ExpectedHandle, StringComparison.Ordinal))
            throw new BusinessException(Rejection.Conflict, "The administrator handle changed before this update completed.");

        if (await SqlCommands.Scalar(db, tx, ct, """
            select 1 from public.admin_principal where handle = $1 and id <> $2
            """, normalized.NewHandle, admin.Id) is not null)
            throw new BusinessException(Rejection.Conflict, "This administrator handle is already in use.");

        return currentHandle;
    }
}
