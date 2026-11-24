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

        return gate.WithLiveAdminPermission(session, async (db, tx, _) =>
        {
            var items = new List<AdminReaderAccount>(WireLimits.AdminReaderPageSize);
            int total = 0, enabledTotal = 0, disabledTotal = 0;
            var hasMore = false;
            await SqlCommands.ReadAll(db, tx, ct, """
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
                    select count(*)::int as cnt, min(c.created_at) as registered_at, max(c.last_used_at) as last_used_at
                    from public.passkey_credential c where c.user_id = p.id
                ) pk on p.id is not null
                left join lateral (
                    select count(*)::int as cnt from public.user_session us
                    where us.user_id = p.id and us.generation = p.generation and us.expires_at > clock_timestamp()
                ) sess on p.id is not null
                left join lateral (
                    select count(*)::int as cnt from public.comment_account_owner co where co.user_id = p.id
                ) cm on p.id is not null
                left join lateral (
                    select a.happened_at, ap.handle as actor_handle, a.reason
                    from public.admin_reader_governance_audit a
                    join public.admin_principal ap on ap.id = a.principal_id
                    where a.user_id = p.id order by a.id desc limit 1
                ) ga on p.id is not null
                order by p.account_id desc nulls last, p.id desc nulls last
                """, rows =>
            {
                if (hasMore) return;
                (total, enabledTotal, disabledTotal) = (rows.GetInt32(0), rows.GetInt32(1), rows.GetInt32(2));
                if (rows.IsDBNull(3)) return;
                if (items.Count == WireLimits.AdminReaderPageSize) { hasMore = true; return; }
                items.Add(new(rows.GetGuid(3), rows.GetInt32(4), rows.GetString(5), rows.GetString(6), rows.GetBoolean(7),
                    rows.GetInt64(8), rows.GetInt32(9), rows.GetBoolean(10), rows.GetBoolean(11), rows.GetInt32(12), rows.GetInt32(13),
                    rows.IsDBNull(14) ? 0 : rows.GetUnixMilliseconds(14), rows.IsDBNull(15) ? 0 : rows.GetUnixMilliseconds(15),
                    rows.IsDBNull(16) ? 0 : rows.GetUnixMilliseconds(16), rows.GetString(17), rows.GetString(18)));
            }, filter.Keyword, likePattern, SqlCommands.Optional(NpgsqlDbType.Integer, accountIdFilter),
                SqlCommands.Optional(NpgsqlDbType.Boolean, filter.Enabled), filter.HasCursor, filter.AfterAccountId,
                filter.AfterUserId, WireLimits.AdminReaderPageSize + 1, exactAccountLookup);

            return new AdminReaderAccountPage(total, enabledTotal, disabledTotal, hasMore,
                hasMore ? items[^1].AccountId : 0, hasMore ? items[^1].UserId : Guid.Empty, items);
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

        return gate.WithLiveAdminPermission(session, async (db, tx, admin) =>
        {
            await Store.LockCommand(db, tx, admin.Id, normalized.IdempotencyKey, ct);
            if (await SqlCommands.QueryOne(db, tx, ct, """
                select fingerprint, user_id, next_enabled, next_generation, revoked_session_count, happened_at
                from public.admin_reader_governance_audit where principal_id = $1 and command_id = $2
                """, r => CryptographicOperations.FixedTimeEquals(fingerprint, r.GetFieldValue<byte[]>(0))
                    ? new AdminReaderStatusReceipt(r.GetGuid(1), r.GetBoolean(2), r.GetInt64(3), r.GetInt32(4), r.GetUnixMilliseconds(5), Replayed: true)
                    : throw new BusinessException(Rejection.Conflict, "This administrator command key is already in use."),
                admin.Id, normalized.IdempotencyKey) is { } replayed)
                return replayed;

            if (!await stepUp.ConsumeProofAsync(db, tx, admin, proof, fingerprint, ct, AdminStepUpAction.ChangeReaderStatus))
                throw new ReaderGovernanceProofRequiredException();

            var previousEnabled = await CheckTarget(db, tx, normalized, forUpdate: true, ct);
            var nextGeneration = (long)(await SqlCommands.Scalar(db, tx, ct, """
                update public.blog_user set enabled = $2, generation = generation + 1
                where id = $1 returning generation
                """, normalized.UserId, normalized.TargetEnabled) ?? throw TargetNotFound());

            var revokedSessions = 0;
            if (!normalized.TargetEnabled)
            {
                revokedSessions = (int)(await SqlCommands.Scalar(db, tx, ct, """
                    with deleted as (
                        delete from public.user_session where user_id = $1 returning generation, expires_at
                    )
                    select count(*) filter (where generation = $2 and expires_at > clock_timestamp())::int from deleted
                    """, normalized.UserId, normalized.ExpectedGeneration) ?? 0);
            }
            string[] tables = normalized.TargetEnabled
                ? ["login_ticket", "passkey_challenge"]
                : ["login_ticket", "passkey_challenge", "mfa_setup", "mfa_flow", "site_recovery_flow", "site_recovery_rebind"];
            foreach (var table in tables)
                await SqlCommands.Execute(db, tx, ct, $"delete from public.{table} where user_id = $1", normalized.UserId);

            var happenedAt = await SqlCommands.QueryRequired(db, tx, ct, """
                insert into public.admin_reader_governance_audit
                    (user_id, principal_id, command_id, fingerprint, previous_enabled, next_enabled,
                     previous_generation, next_generation, revoked_session_count, reason)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning happened_at
                """, r => r.GetFieldValue<DateTimeOffset>(0),
                () => new InvalidOperationException("Failed to record reader governance audit."),
                normalized.UserId, admin.Id, normalized.IdempotencyKey, fingerprint,
                previousEnabled, normalized.TargetEnabled, normalized.ExpectedGeneration, nextGeneration,
                revokedSessions, normalized.Reason);

            return new AdminReaderStatusReceipt(normalized.UserId, normalized.TargetEnabled, nextGeneration,
                revokedSessions, happenedAt.ToUnixTimeMilliseconds(), Replayed: false);
        }, ct);
    }

    private static async Task<bool> CheckTarget(NpgsqlConnection db, NpgsqlTransaction tx,
        AdminReaderStatusCommand command, bool forUpdate, CancellationToken ct)
    {
        var (enabled, generation) = await SqlCommands.QueryRequired(db, tx, ct,
            $"select enabled, generation from public.blog_user where id = $1{(forUpdate ? " for update" : "")}",
            r => (r.GetBoolean(0), r.GetInt64(1)), TargetNotFound, command.UserId);
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

internal sealed class ReaderGovernanceProofRequiredException : ProofRequiredException;
