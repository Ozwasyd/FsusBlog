using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Npgsql;
using NpgsqlTypes;

namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminReaderGovernanceStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    internal Task<(AdminReaderAccountPage Page, string PermissionSession)> ListReaders(
        string? session, IQueryCollection query, CancellationToken ct)
    {
        var filter = ParseQuery(query);
        var likePattern = filter.Keyword.Length == 0 ? "" : "%" + EscapeLike(filter.Keyword) + "%";
        var exactAccountId = 0;
        var exactAccountLookup = filter.Keyword.StartsWith('#') &&
            int.TryParse(filter.Keyword[1..], NumberStyles.None, CultureInfo.InvariantCulture, out exactAccountId) &&
            exactAccountId > 0;
        int? accountIdFilter = exactAccountLookup
            ? exactAccountId
            : (int.TryParse(filter.Keyword, NumberStyles.None, CultureInfo.InvariantCulture, out var plainAccountId) && plainAccountId > 0
                ? plainAccountId
                : null);

        return gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            await using var cmd = Store.Sql(db, tx, """
                with matched as (
                    select u.id, u.name, u.enabled, u.generation,
                           coalesce(s.account_id, 0) as account_id,
                           coalesce(h.display_name, '') as display_name
                    from public.blog_user u
                    left join public.passkey_subject s on s.user_id = u.id
                    left join public.comment_public_handle h on h.user_id = u.id
                    where ($1 = ''
                           or ($9 and s.account_id = $3)
                           or (not $9 and (
                               u.name ilike $2 escape '\'
                               or coalesce(h.display_name, '') ilike $2 escape '\'
                               or ($3::integer is not null and s.account_id = $3))))
                ), totals as (
                    select count(*) filter (where $4::boolean is null or enabled = $4)::int as total,
                           count(*) filter (where enabled)::int as enabled_total,
                           count(*) filter (where not enabled)::int as disabled_total
                    from matched
                ), page as (
                    select m.id, m.name, m.enabled, m.generation, m.account_id, m.display_name
                    from matched m
                    where ($4::boolean is null or m.enabled = $4)
                      and (not $5 or (m.account_id, m.id) < ($6, $7))
                    order by m.account_id desc, m.id desc
                    limit $8
                )
                select t.total, t.enabled_total, t.disabled_total,
                       p.id, p.account_id, p.name, p.display_name, p.enabled, p.generation,
                       coalesce(pk.cnt, 0),
                       exists(select from public.site_recovery_key rk where rk.user_id = p.id),
                       exists(select from public.mfa_totp mt where mt.user_id = p.id),
                       coalesce(sess.cnt, 0),
                       coalesce(cm.cnt, 0),
                       pk.registered_at,
                       pk.last_used_at,
                       ga.happened_at,
                       coalesce(ga.actor_handle, ''),
                       coalesce(ga.reason, '')
                from totals t
                left join page p on true
                left join lateral (
                    select count(*)::int as cnt,
                           min(c.created_at) as registered_at,
                           max(c.last_used_at) as last_used_at
                    from public.passkey_credential c
                    where c.user_id = p.id
                ) pk on p.id is not null
                left join lateral (
                    select count(*)::int as cnt
                    from public.user_session us
                    where us.user_id = p.id and us.generation = p.generation and us.expires_at > clock_timestamp()
                ) sess on p.id is not null
                left join lateral (
                    select count(*)::int as cnt
                    from public.comment_account_owner co
                    where co.user_id = p.id
                ) cm on p.id is not null
                left join lateral (
                    select a.happened_at,
                           ap.handle as actor_handle,
                           a.reason
                    from public.admin_reader_governance_audit a
                    join public.admin_principal ap on ap.id = a.principal_id
                    where a.user_id = p.id
                    order by a.id desc
                    limit 1
                ) ga on p.id is not null
                order by p.account_id desc nulls last, p.id desc nulls last
                """,
                filter.Keyword,
                likePattern,
                SqlCommands.Optional(NpgsqlDbType.Integer, accountIdFilter),
                SqlCommands.Optional(NpgsqlDbType.Boolean, filter.Enabled),
                filter.HasCursor,
                filter.AfterAccountId,
                filter.AfterUserId,
                WireLimits.AdminReaderPageSize + 1,
                exactAccountLookup);

            var items = new List<AdminReaderAccount>(WireLimits.AdminReaderPageSize);
            var total = 0;
            var enabledTotal = 0;
            var disabledTotal = 0;
            var hasMore = false;
            await using var rows = await cmd.ExecuteReaderAsync(ct);
            while (await rows.ReadAsync(ct))
            {
                total = rows.GetInt32(0);
                enabledTotal = rows.GetInt32(1);
                disabledTotal = rows.GetInt32(2);
                if (rows.IsDBNull(3)) break;
                if (items.Count == WireLimits.AdminReaderPageSize)
                {
                    hasMore = true;
                    break;
                }
                items.Add(new AdminReaderAccount(
                    UserId: rows.GetGuid(3),
                    AccountId: rows.GetInt32(4),
                    Name: rows.GetString(5),
                    DisplayName: rows.GetString(6),
                    Enabled: rows.GetBoolean(7),
                    Generation: rows.GetInt64(8),
                    PasskeyCount: rows.GetInt32(9),
                    HasRecoveryKey: rows.GetBoolean(10),
                    HasTotp: rows.GetBoolean(11),
                    ActiveSessionCount: rows.GetInt32(12),
                    CommentCount: rows.GetInt32(13),
                    RegisteredAtUnixMs: rows.IsDBNull(14) ? 0 : rows.GetFieldValue<DateTimeOffset>(14).ToUnixTimeMilliseconds(),
                    LastUsedAtUnixMs: rows.IsDBNull(15) ? 0 : rows.GetFieldValue<DateTimeOffset>(15).ToUnixTimeMilliseconds(),
                    LastGovernanceAtUnixMs: rows.IsDBNull(16) ? 0 : rows.GetFieldValue<DateTimeOffset>(16).ToUnixTimeMilliseconds(),
                    LastGovernanceActor: rows.GetString(17),
                    LastGovernanceReason: rows.GetString(18)));
            }

            var nextAccountId = hasMore ? items[^1].AccountId : 0;
            var nextUserId = hasMore ? items[^1].UserId : Guid.Empty;
            var page = new AdminReaderAccountPage(total, enabledTotal, disabledTotal, hasMore, nextAccountId, nextUserId, items);
            return (page, AdminSessionGate.PermissionBinding(admin.Digest));
        }, ct);
    }

    internal Task<byte[]> BeginStatusStepUp(string? session, AdminReaderStatusCommand command, CancellationToken ct)
    {
        var normalized = NormalizeCommand(command);
        return stepUp.BeginStepUp(session, CommandFingerprint(normalized),
            (db, tx, _) => CheckTarget(db, tx, normalized, forUpdate: false, ct),
            ct, AdminStepUpAction.ChangeReaderStatus);
    }

    internal Task<byte[]> CompleteStatusStepUp(string? session, PasskeyLoginRequest assertion, CancellationToken ct) =>
        stepUp.CompleteStepUp(session, assertion, AdminStepUpAction.ChangeReaderStatus, ct);

    internal Task<(AdminReaderStatusReceipt Receipt, string PermissionSession)> ExecuteStatusChange(
        string? session, string? proof, AdminReaderStatusCommand command, CancellationToken ct)
    {
        var normalized = NormalizeCommand(command);
        var fingerprint = CommandFingerprint(normalized);

        return gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            var permissionSession = AdminSessionGate.PermissionBinding(admin.Digest);
            await Store.LockCommand(db, tx, admin.Id, normalized.IdempotencyKey, ct);
            await using (var replay = Store.Sql(db, tx, """
                select fingerprint, user_id, next_enabled, next_generation, revoked_session_count, happened_at
                from public.admin_reader_governance_audit
                where principal_id = $1 and command_id = $2
                """, admin.Id, normalized.IdempotencyKey))
            await using (var existing = await replay.ExecuteReaderAsync(ct))
            {
                if (await existing.ReadAsync(ct))
                {
                    if (!CryptographicOperations.FixedTimeEquals(fingerprint, existing.GetFieldValue<byte[]>(0)))
                        throw new BusinessException(Rejection.Conflict, "This administrator command key is already in use.");
                    var replayed = new AdminReaderStatusReceipt(
                        existing.GetGuid(1),
                        existing.GetBoolean(2),
                        existing.GetInt64(3),
                        existing.GetInt32(4),
                        existing.GetFieldValue<DateTimeOffset>(5).ToUnixTimeMilliseconds(),
                        Replayed: true);
                    return (replayed, permissionSession);
                }
            }

            if (!await stepUp.ConsumeProofAsync(db, tx, admin, proof, fingerprint, ct, AdminStepUpAction.ChangeReaderStatus))
                throw new ReaderGovernanceProofRequiredException();

            var previousEnabled = await CheckTarget(db, tx, normalized, forUpdate: true, ct);
            long nextGeneration;
            await using (var update = Store.Sql(db, tx, """
                update public.blog_user
                set enabled = $2, generation = generation + 1
                where id = $1
                returning generation
                """, normalized.UserId, normalized.TargetEnabled))
            {
                nextGeneration = (long)(await update.ExecuteScalarAsync(ct) ?? throw TargetNotFound());
            }

            var revokedSessions = 0;
            if (!normalized.TargetEnabled)
            {
                await using (var dropSessions = Store.Sql(db, tx, """
                    with deleted as (
                        delete from public.user_session
                        where user_id = $1
                        returning generation, expires_at
                    )
                    select count(*) filter (where generation = $2 and expires_at > clock_timestamp())::int
                    from deleted
                    """, normalized.UserId, normalized.ExpectedGeneration))
                {
                    revokedSessions = (int)(await dropSessions.ExecuteScalarAsync(ct) ?? 0);
                }
                foreach (var sql in new[]
                {
                    "delete from public.login_ticket where user_id = $1",
                    "delete from public.passkey_challenge where user_id = $1",
                    "delete from public.mfa_setup where user_id = $1",
                    "delete from public.mfa_flow where user_id = $1",
                    "delete from public.site_recovery_flow where user_id = $1",
                    "delete from public.site_recovery_rebind where user_id = $1"
                })
                {
                    await SqlCommands.Execute(db, tx, ct, sql, normalized.UserId);
                }
            }
            else
            {
                await SqlCommands.Execute(db, tx, ct, "delete from public.login_ticket where user_id = $1", normalized.UserId);
                await SqlCommands.Execute(db, tx, ct, "delete from public.passkey_challenge where user_id = $1", normalized.UserId);
            }

            DateTimeOffset happenedAt;
            await using (var audit = Store.Sql(db, tx, """
                insert into public.admin_reader_governance_audit
                    (user_id, principal_id, command_id, fingerprint, previous_enabled, next_enabled,
                     previous_generation, next_generation, revoked_session_count, reason)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                returning happened_at
                """,
                normalized.UserId, admin.Id, normalized.IdempotencyKey, fingerprint,
                previousEnabled, normalized.TargetEnabled,
                normalized.ExpectedGeneration, nextGeneration,
                revokedSessions, normalized.Reason))
            await using (var row = await audit.ExecuteReaderAsync(ct))
            {
                if (!await row.ReadAsync(ct))
                    throw new InvalidOperationException("Failed to record reader governance audit.");
                happenedAt = row.GetFieldValue<DateTimeOffset>(0);
            }

            var receipt = new AdminReaderStatusReceipt(
                normalized.UserId,
                normalized.TargetEnabled,
                nextGeneration,
                revokedSessions,
                happenedAt.ToUnixTimeMilliseconds(),
                Replayed: false);
            return (receipt, permissionSession);
        }, ct);
    }

    private static async Task<bool> CheckTarget(NpgsqlConnection db, NpgsqlTransaction tx,
        AdminReaderStatusCommand command, bool forUpdate, CancellationToken ct)
    {
        var suffix = forUpdate ? " for update" : "";
        await using var query = Store.Sql(db, tx,
            $"select enabled, generation from public.blog_user where id = $1{suffix}", command.UserId);
        await using var row = await query.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) throw TargetNotFound();
        var enabled = row.GetBoolean(0);
        var generation = row.GetInt64(1);
        if (generation != command.ExpectedGeneration || enabled == command.TargetEnabled)
            throw new BusinessException(Rejection.Conflict, "The reader account state changed. Reload the reader list.");
        return enabled;
    }

    private static AdminReaderStatusCommand NormalizeCommand(AdminReaderStatusCommand command)
    {
        if (command.UserId == Guid.Empty)
            throw new BusinessException(Rejection.Invalid, "Select a valid reader account.");
        if (command.ExpectedGeneration <= 0)
            throw new BusinessException(Rejection.Invalid, "A current reader generation is required.");
        if (command.IdempotencyKey == Guid.Empty)
            throw new BusinessException(Rejection.Invalid, "A valid command idempotency key is required.");
        var reason = command.Reason.Trim();
        if (reason.Length == 0 || reason.Length > WireLimits.AdminReaderReasonChars ||
            Encoding.UTF8.GetByteCount(reason) > WireLimits.AdminReaderReasonBytes ||
            reason.Any(char.IsControl))
            throw new BusinessException(Rejection.Invalid, "Provide a single-line governance reason between 1 and 500 characters.");
        return command with { Reason = reason };
    }

    internal static byte[] CommandFingerprint(AdminReaderStatusCommand command) =>
        SHA256.HashData(Wire.EncodeAdminReaderStatusCommand(command));

    private static ReaderListFilter ParseQuery(IQueryCollection query)
    {
        bool? enabled = null;
        if (query.TryGetValue("status", out var statuses))
        {
            if (statuses.Count != 1) throw InvalidFilter("Invalid reader status filter.");
            enabled = statuses[0] switch
            {
                "" or "all" => null,
                "enabled" => true,
                "disabled" => false,
                _ => throw InvalidFilter("Invalid reader status filter.")
            };
        }

        var keyword = "";
        if (query.TryGetValue("keyword", out var keywords))
        {
            if (keywords.Count != 1) throw InvalidFilter("Invalid reader search keyword.");
            keyword = (keywords[0] ?? "").Trim();
            if (keyword.Length > WireLimits.AdminReaderKeywordChars || keyword.Any(char.IsControl))
                throw InvalidFilter("Invalid reader search keyword.");
        }

        var hasAfterAccount = query.TryGetValue("afterAccountId", out var afterAccountValues);
        var hasAfterUser = query.TryGetValue("afterUserId", out var afterUserValues);
        if (hasAfterAccount != hasAfterUser)
            throw InvalidFilter("Invalid reader pagination cursor.");

        var afterAccountId = 0;
        var afterUserId = Guid.Empty;
        if (hasAfterAccount)
        {
            if (afterAccountValues.Count != 1 || afterUserValues.Count != 1 ||
                afterAccountValues[0] is not { Length: >= 1 and <= 10 } rawAccount ||
                !int.TryParse(rawAccount, NumberStyles.None, CultureInfo.InvariantCulture, out afterAccountId) ||
                afterAccountId < 0 || rawAccount != afterAccountId.ToString(CultureInfo.InvariantCulture) ||
                !Guid.TryParseExact(afterUserValues[0], "D", out afterUserId) || afterUserId == Guid.Empty)
                throw InvalidFilter("Invalid reader pagination cursor.");
        }

        return new ReaderListFilter(enabled, keyword, hasAfterAccount, afterAccountId, afterUserId);
    }

    private static string EscapeLike(string value) =>
        value.Replace(@"\", @"\\", StringComparison.Ordinal)
             .Replace("%", @"\%", StringComparison.Ordinal)
             .Replace("_", @"\_", StringComparison.Ordinal);

    private static BusinessException InvalidFilter(string message) => new(Rejection.Invalid, message);
    private static BusinessException TargetNotFound() => new(Rejection.NotFound, "Reader account not found.");

    private readonly record struct ReaderListFilter(
        bool? Enabled,
        string Keyword,
        bool HasCursor,
        int AfterAccountId,
        Guid AfterUserId);
}

internal sealed class ReaderGovernanceProofRequiredException : Exception;
