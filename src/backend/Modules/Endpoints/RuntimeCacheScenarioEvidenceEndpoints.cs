using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Security;

using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints;

internal static class RuntimeCacheScenarioEvidenceEndpoints
{
    private const string Prefix = "/_fsus/testing/runtime-cache/scenarios";
    private static readonly ConcurrentDictionary<string, SecurityRunState> s_securityRuns =
        new(StringComparer.Ordinal);
    private static readonly ConcurrentDictionary<string, TelemetryRunState> s_telemetryRuns =
        new(StringComparer.Ordinal);

    internal static WebApplication MapRuntimeCacheScenarioEvidenceEndpoints(this WebApplication app)
    {
        if ((!app.Environment.IsDevelopment() && !app.Environment.IsEnvironment("Test")) ||
            string.IsNullOrWhiteSpace(app.Configuration[RuntimeCacheEvidenceMiddleware.SecretConfigurationKey]))
        {
            return app;
        }

        app.MapPost($"{Prefix}/security-projections/{{runId}}/prepare", PrepareSecurityAsync).AllowAnonymous();
        app.MapPost($"{Prefix}/security-projections/{{runId}}/mutate", MutateSecurityAsync).AllowAnonymous();
        app.MapGet($"{Prefix}/security-projections/{{runId}}/hot/{{family}}", ReadSecurityHotAsync).AllowAnonymous();
        app.MapGet($"{Prefix}/security-projections/{{runId}}/snapshot", ReadSecuritySnapshotAsync).AllowAnonymous();
        app.MapDelete($"{Prefix}/security-projections/{{runId}}", CleanupSecurityAsync).AllowAnonymous();

        app.MapPost($"{Prefix}/telemetry/{{runId}}/prepare", PrepareTelemetryAsync).AllowAnonymous();
        app.MapGet($"{Prefix}/telemetry/{{runId}}/probe/{{mode}}/{{ordinal:int}}", ProbeTelemetryAsync).AllowAnonymous();
        app.MapGet($"{Prefix}/telemetry/snapshot", ReadTelemetrySnapshot).AllowAnonymous();
        app.MapGet($"{Prefix}/telemetry/boundaries/{{requestId}}", TakeTelemetryBoundaries).AllowAnonymous();
        app.MapDelete($"{Prefix}/telemetry/{{runId}}", CleanupTelemetryAsync).AllowAnonymous();
        return app;
    }

    private static async Task<IResult> PrepareSecurityAsync(
        HttpContext context,
        string runId,
        bool owner,
        ISqlSugarClient db,
        IAccountStateProjection accounts,
        BanStateProjection bans,
        IBlacklistService blacklist,
        IAdminSessionProjectionAuthorityReader adminAuthority,
        IAdminSessionProjectionMutationCoordinator adminMutations,
        NotificationStreamAccountAdmissionCache admission,
        IUserAccountReader users,
        TimeProvider timeProvider,
        CancellationToken cancellationToken)
    {
        if (!Authorized(context) || !ValidRunId(runId))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        User? user = await db.Queryable<User>()
            .Where(static item => item.Status == 0 && item.DeletedAt == null && item.AccountSubjectHash != null)
            .OrderBy(static item => item.Id)
            .FirstAsync(cancellationToken);
        AdminPrincipal? principal = await db.Queryable<AdminPrincipal>()
            .Where(static item => item.Status == AdminPrincipalStatus.Active)
            .OrderBy(static item => item.Id)
            .FirstAsync(cancellationToken);
        if (user?.AccountSubjectHash is null || principal is null)
        {
            return Results.Problem("security_projection_fixture_rows_missing", statusCode: 409);
        }

        string sessionId = SecuritySessionId(runId);
        byte[] tokenHash = SHA256.HashData(Encoding.UTF8.GetBytes($"runtime-cache-admin-token:{runId}"));
        string? creationEventId = null;
        if (owner)
        {
            DateTime now = DateTime.UtcNow;
            _ = await db.Deleteable<AdminSession>()
                .Where(item => item.SessionId == sessionId)
                .ExecuteCommandAsync(cancellationToken);
            await db.Insertable(new AdminSession
            {
                SessionId = sessionId,
                AdminPrincipalId = principal.Id,
                AccessTokenHash = Convert.ToHexString(tokenHash),
                ValidationVersion = 1,
                CreatedAtUtc = now,
                LastSeenAtUtc = now,
                IdleExpiresAtUtc = now.AddHours(2),
                AbsoluteExpiresAtUtc = now.AddHours(4)
            }).ExecuteCommandAsync(cancellationToken);
            PreparedAdminSessionProjectionMutation created =
                await adminMutations.PrepareSessionsAsync([sessionId], cancellationToken);
            await adminMutations.PublishPreparedAsync(created, cancellationToken);
            creationEventId = created.DurableEvent?.EventId;
        }

        AdminSessionProjectionSessionUpdate? session = null;
        for (int attempt = 0; attempt < 50 && !session.HasValue; attempt++)
        {
            session = await adminAuthority.ReadSessionAsync(sessionId, cancellationToken);
            if (!session.HasValue)
            {
                await Task.Delay(20, cancellationToken);
            }
        }
        if (!session.HasValue || !await adminAuthority.RefreshSessionAsync(sessionId, cancellationToken))
        {
            return Results.Problem("security_projection_admin_session_not_ready", statusCode: 409);
        }

        AccountStateReadResult account = await accounts.RefreshAsync(user.Id, user.AccountSubjectHash, cancellationToken);
        BanStateSnapshot ban = await blacklist.GetBanStateAsync(user.Id, user.AccountSubjectHash);
        _ = await admission.GetOrCreateAsync(user.Id, users, cancellationToken);
        if (!account.IsPresent || !ban.IsKnown)
        {
            return Results.Problem("security_projection_account_or_ban_not_ready", statusCode: 409);
        }

        var state = new SecurityRunState(
            runId,
            owner,
            SecurityEvidenceStartBoundary(timeProvider),
            user.Id,
            user.AccountSubjectHash,
            sessionId,
            principal.Id,
            tokenHash,
            account.Snapshot!.Generation,
            ban.Generation,
            session.Value.Generation,
            creationEventId);
        s_securityRuns[runId] = state;
        return Results.Ok(await SecuritySnapshotAsync(
            context,
            state,
            accounts,
            bans,
            context.RequestServices.GetRequiredService<AdminSessionProjection>(),
            admission,
            cancellationToken));
    }

    private static async Task<IResult> MutateSecurityAsync(
        HttpContext context,
        string runId,
        IBlacklistService blacklist,
        IAdminPrincipalService admins,
        IAccountStateProjection accounts,
        BanStateProjection bans,
        AdminSessionProjection adminSessions,
        NotificationStreamAccountAdmissionCache admission,
        CancellationToken cancellationToken)
    {
        if (!Authorized(context) || !s_securityRuns.TryGetValue(runId, out SecurityRunState? state))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }
        await blacklist.BanUserAsync(state.AccountId, "runtime-cache-evidence");
        AdminSessionRevokeResult revoked = await admins.RevokeAdminSessionAsync(
            state.AdminPrincipalId,
            state.AdminSessionId,
            "runtime-cache-evidence",
            cancellationToken);
        if (revoked != AdminSessionRevokeResult.Revoked)
        {
            return Results.Problem($"security_projection_admin_revoke_{revoked}", statusCode: 409);
        }
        return Results.Ok(await SecuritySnapshotAsync(
            context,
            state,
            accounts,
            bans,
            adminSessions,
            admission,
            cancellationToken));
    }

    private static async Task<IResult> ReadSecurityHotAsync(
        HttpContext context,
        string runId,
        string family,
        IAccountStateProjection accounts,
        BanStateProjection bans,
        AdminSessionProjection adminSessions,
        NotificationStreamAccountAdmissionCache admission,
        CancellationToken cancellationToken)
    {
        if (!Authorized(context) || !s_securityRuns.TryGetValue(runId, out SecurityRunState? state))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        object result;
        switch (family)
        {
            case "account":
                {
                    AccountStateReadResult read = await accounts.ReadAsync(
                        state.AccountId,
                        state.AccountSubjectHash,
                        cancellationToken);
                    result = new
                    {
                        family,
                        local = read.LocalHit,
                        outcome = read.Outcome.ToString(),
                        generation = read.Snapshot?.Generation ?? 0
                    };
                    break;
                }
            case "ban":
                {
                    BanStateProjectionLookup read = bans.Read(state.AccountSubjectHash);
                    result = new
                    {
                        family,
                        local = read.IsKnown,
                        outcome = read.Status.ToString(),
                        generation = read.Generation
                    };
                    break;
                }
            case "admin":
                {
                    AdminSessionProjectionValidationResult read = adminSessions.Validate(
                        state.AdminSessionId,
                        state.AdminPrincipalId,
                        state.InitialAdminTokenHash);
                    result = new
                    {
                        family,
                        local = read.Source == AdminSessionProjectionSources.LocalProjection,
                        outcome = read.Reason,
                        generation = read.Generation
                    };
                    break;
                }
            case "residency":
                {
                    result = SecurityResidency(accounts, bans, adminSessions, admission);
                    break;
                }
            default:
                return Results.BadRequest(new
                {
                    error = "security_projection_family_invalid"
                });
        }

        RuntimeCacheEvidenceObservation.Current?.MarkLayerSource("l1-object");
        return Results.Ok(result);
    }

    private static async Task<IResult> ReadSecuritySnapshotAsync(
        HttpContext context,
        string runId,
        ISqlSugarClient db,
        IAccountStateProjection accounts,
        BanStateProjection bans,
        AdminSessionProjection adminSessions,
        NotificationStreamAccountAdmissionCache admission,
        CancellationToken cancellationToken)
    {
        if (!Authorized(context) || !s_securityRuns.TryGetValue(runId, out SecurityRunState? state))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }
        object snapshot = await SecuritySnapshotAsync(
            context,
            state,
            accounts,
            bans,
            adminSessions,
            admission,
            cancellationToken);
        List<DistributedInvalidationConvergenceObligationEntity> rows = await DurableRowsAsync(db, state, cancellationToken);
        return Results.Ok(new
        {
            snapshot,
            durableRows = rows.Select(static row => new
            {
                row.EventId,
                row.Kind,
                row.State,
                row.RequiredNodeIds,
                row.AckedNodeIds,
                row.PayloadDigest
            })
        });
    }

    private static async Task<IResult> CleanupSecurityAsync(
        HttpContext context,
        string runId,
        ISqlSugarClient db,
        IBlacklistService blacklist,
        CancellationToken cancellationToken)
    {
        if (!Authorized(context) || !s_securityRuns.TryRemove(runId, out SecurityRunState? state))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }
        int deleted = 0;
        if (state.Owner)
        {
            await blacklist.UnbanUserAsync(state.AccountId);
            deleted = await db.Deleteable<AdminSession>()
                .Where(item => item.SessionId == state.AdminSessionId)
                .ExecuteCommandAsync(cancellationToken);
        }
        return Results.Ok(new
        {
            restored = true,
            deletedAdminSessions = deleted
        });
    }

    private static async Task<IResult> PrepareTelemetryAsync(
        HttpContext context,
        string runId,
        int errorCount,
        ICacheRawWriter writer,
        CancellationToken cancellationToken)
    {
        if (!Authorized(context) || !ValidRunId(runId) || errorCount is < 1 or > 1024)
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }
        string hitIdentity = $"runtime-cache-evidence:{runId}:telemetry:hit";
        string[] errorIdentities = Enumerable.Range(0, errorCount)
            .Select(index => $"runtime-cache-evidence:{runId}:telemetry:error:{index}")
            .ToArray();
        await writer.SetRawAsync(CachePolicyId.SystemPage, hitIdentity, [1], cancellationToken: cancellationToken);
        foreach (string identity in errorIdentities)
        {
            await writer.SetRawAsync(CachePolicyId.SystemPage, identity, [127], cancellationToken: cancellationToken);
        }
        s_telemetryRuns[runId] = new TelemetryRunState(hitIdentity, errorIdentities);
        return Results.Ok(new
        {
            prepared = true,
            errorCount
        });
    }

    private static async Task<IResult> ProbeTelemetryAsync(
        HttpContext context,
        string runId,
        string mode,
        int ordinal,
        ICacheTypedReader reader,
        CancellationToken cancellationToken)
    {
        if (!Authorized(context) || !s_telemetryRuns.TryGetValue(runId, out TelemetryRunState? state))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }
        string identity = mode switch
        {
            "hit" => state.HitIdentity,
            "miss" => $"runtime-cache-evidence:{runId}:telemetry:miss:{ordinal}",
            "error" when (uint)ordinal < (uint)state.ErrorIdentities.Length => state.ErrorIdentities[ordinal],
            _ => string.Empty
        };
        if (identity.Length == 0)
        {
            return Results.BadRequest(new
            {
                error = "telemetry_probe_invalid"
            });
        }
        CacheReadResult<int> read = await reader.TryGetAsync(
            CachePolicyId.SystemPage,
            identity,
            static bytes => bytes.Length == 1 && bytes.Span[0] == 1 ? (true, 1) : (false, 0),
            cancellationToken);
        return Results.Ok(new
        {
            mode,
            hit = read.Hit,
            value = read.Value
        });
    }

    private static IResult ReadTelemetrySnapshot(HttpContext context)
    {
        if (!Authorized(context))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }
        return Results.Ok(new
        {
            l1 = FsusObservability.GetCacheL1TelemetrySnapshot(),
            operations = FsusObservability.GetCacheOperationCounters()
                .Where(static item => item.Policy == CachePolicyTelemetry.Name(CachePolicyId.SystemPage))
                .ToArray()
        });
    }

    private static IResult TakeTelemetryBoundaries(HttpContext context, string requestId)
    {
        if (!Authorized(context))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }
        return RuntimeCacheL1BoundaryEvidenceStore.TryTake(requestId, out IReadOnlyList<RuntimeCacheL1BoundaryEvidence> evidence)
            ? Results.Ok(evidence)
            : Results.NotFound();
    }

    private static async Task<IResult> CleanupTelemetryAsync(
        HttpContext context,
        string runId,
        ICacheInvalidationStore cache,
        CancellationToken cancellationToken)
    {
        if (!Authorized(context) || !s_telemetryRuns.TryRemove(runId, out TelemetryRunState? state))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }
        CacheKeyIdentity[] keys =
        [
            new(CachePolicyId.SystemPage, state.HitIdentity),
            .. state.ErrorIdentities.Select(static identity => new CacheKeyIdentity(CachePolicyId.SystemPage, identity))
        ];
        await cache.RemoveManyAsync(keys, cancellationToken);
        return Results.Ok(new
        {
            removed = keys.Length
        });
    }

    private static async Task<object> SecuritySnapshotAsync(
        HttpContext context,
        SecurityRunState state,
        IAccountStateProjection accounts,
        BanStateProjection bans,
        AdminSessionProjection adminSessions,
        NotificationStreamAccountAdmissionCache admission,
        CancellationToken cancellationToken)
    {
        AccountStateReadResult account = await accounts.ReadAsync(
            state.AccountId,
            state.AccountSubjectHash,
            cancellationToken);
        BanStateProjectionLookup ban = bans.Read(state.AccountSubjectHash);
        AdminSessionProjectionValidationResult admin = adminSessions.Validate(
            state.AdminSessionId,
            state.AdminPrincipalId,
            state.InitialAdminTokenHash);
        return new
        {
            processId = Environment.ProcessId,
            route = context.Request.Path.Value,
            account = new
            {
                outcome = account.Outcome.ToString(),
                generation = account.Snapshot?.Generation ?? 0,
                account.LocalHit
            },
            ban = new
            {
                status = ban.Status.ToString(),
                ban.Generation,
                ban.IsKnown
            },
            admin = new
            {
                admin.IsValid,
                admin.Reason,
                admin.Source,
                admin.Generation
            },
            residency = SecurityResidency(accounts, bans, adminSessions, admission),
            baseline = new
            {
                state.InitialAccountGeneration,
                state.InitialBanGeneration,
                state.InitialAdminGeneration
            },
            state.CreationEventId
        };
    }

    private static object SecurityResidency(
        IAccountStateProjection accounts,
        BanStateProjection bans,
        AdminSessionProjection adminSessions,
        NotificationStreamAccountAdmissionCache admission)
    {
        AccountStateProjectionRuntimeSnapshot account = accounts.Snapshot();
        BanStateProjectionSnapshot ban = bans.Snapshot();
        AdminSessionProjectionSnapshot admin = adminSessions.Snapshot();
        NotificationStreamAccountAdmissionCacheSnapshot admissionSnapshot = admission.Snapshot();
        return new
        {
            account = new
            {
                account.Entries,
                account.LogicalBytes,
                account.CapacityBytes,
                maxEntries = account.Limits.MaxEntries,
                maxLogicalBytes = account.Limits.MaxLogicalBytes,
                maxCapacityBytes = account.Limits.MaxCapacityBytes
            },
            ban = new
            {
                ban.Entries,
                logicalBytes = ban.Utf8ResidentBytes,
                capacityBytes = ban.Utf8ResidentBytes,
                ban.MaxEntries,
                maxLogicalBytes = ban.MaxUtf8ResidentBytes,
                maxCapacityBytes = ban.MaxUtf8ResidentBytes
            },
            admin = new
            {
                entries = admin.SessionEntries + admin.PrincipalEntries,
                logicalBytes = admin.ResidentBytes,
                capacityBytes = admin.ResidentBytes,
                maxEntries = admin.MaxSessionEntries + admin.MaxPrincipalEntries,
                maxLogicalBytes = admin.MaxResidentBytes,
                maxCapacityBytes = admin.MaxResidentBytes
            },
            admission = new
            {
                admissionSnapshot.Entries,
                admissionSnapshot.LogicalBytes,
                admissionSnapshot.CapacityBytes,
                admissionSnapshot.MaxEntries,
                admissionSnapshot.MaxLogicalBytes,
                admissionSnapshot.MaxCapacityBytes
            }
        };
    }

    private static async Task<List<DistributedInvalidationConvergenceObligationEntity>> DurableRowsAsync(
        ISqlSugarClient db,
        SecurityRunState state,
        CancellationToken cancellationToken)
    {
        string[] kinds =
        [
            DistributedInvalidationEventKinds.AccountStateProjectionMutation,
            DistributedInvalidationEventKinds.BanStateProjection,
            DistributedInvalidationEventKinds.AdminSessionProjectionMutation
        ];
        DateTime startedAt = state.StartedAt.UtcDateTime;
        List<DistributedInvalidationConvergenceObligationEntity> candidates = await db
            .Queryable<DistributedInvalidationConvergenceObligationEntity>()
            .Where(row => row.CreatedAt >= startedAt && kinds.Contains(row.Kind))
            .OrderBy(row => row.Id)
            .ToListAsync(cancellationToken);
        return candidates.Where(row => DurableRowBelongsToRun(row, state)).ToList();
    }

    private static bool DurableRowBelongsToRun(
        DistributedInvalidationConvergenceObligationEntity row,
        SecurityRunState state)
    {
        if (string.IsNullOrWhiteSpace(row.PayloadJson))
        {
            return false;
        }
        DistributedInvalidationEvent? invalidation;
        try
        {
            invalidation = JsonSerializer.Deserialize<DistributedInvalidationEvent>(row.PayloadJson);
        }
        catch (JsonException)
        {
            return false;
        }
        if (invalidation is null)
        {
            return false;
        }
        return row.Kind switch
        {
            DistributedInvalidationEventKinds.AccountStateProjectionMutation => invalidation.ArtifactKeys.Any(
                artifact => AccountStateProjectionMutationPublisher.TryParseArtifact(
                    artifact,
                    out int accountId,
                    out _) && accountId == state.AccountId),
            DistributedInvalidationEventKinds.BanStateProjection => invalidation.ArtifactKeys.Any(
                artifact => DistributedInvalidationTargetResolver.TryParseBanStateProjectionTarget(
                    artifact,
                    out DistributedBanStateProjectionTarget target)
                    && target.Status == BanStateProjectionStatus.Banned
                    && string.Equals(target.AccountSubjectHash, state.AccountSubjectHash, StringComparison.Ordinal)),
            DistributedInvalidationEventKinds.AdminSessionProjectionMutation => invalidation.ArtifactKeys.Any(
                artifact => AdminSessionProjectionEventCodec.TryParse(
                    artifact,
                    out AdminSessionProjectionSessionUpdate? session,
                    out _)
                    && session.HasValue
                    && session.Value.RevokedAtUtc.HasValue
                    && string.Equals(session.Value.SessionId, state.AdminSessionId, StringComparison.Ordinal)),
            _ => false
        };
    }

    private static bool Authorized(HttpContext context)
    {
        string expected = context.RequestServices.GetRequiredService<IConfiguration>()[RuntimeCacheEvidenceMiddleware.SecretConfigurationKey] ?? string.Empty;
        string provided = context.Request.Headers[RuntimeCacheEvidenceMiddleware.SecretHeader].ToString();
        byte[] left = Encoding.UTF8.GetBytes(expected);
        byte[] right = Encoding.UTF8.GetBytes(provided);
        return left.Length > 0 && left.Length == right.Length && CryptographicOperations.FixedTimeEquals(left, right);
    }

    private static bool ValidRunId(string value)
        => value.Length is > 0 and <= 96 && value.All(static character =>
            char.IsAsciiLetterOrDigit(character) || character is '.' or '-');

    private static string SecuritySessionId(string runId)
        => $"rc-{Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(runId)))[..40]}";

    internal static DateTimeOffset SecurityEvidenceStartBoundary(TimeProvider timeProvider)
        => timeProvider.GetUtcNow().AddSeconds(-1);

    private sealed record SecurityRunState(
        string RunId,
        bool Owner,
        DateTimeOffset StartedAt,
        int AccountId,
        string AccountSubjectHash,
        string AdminSessionId,
        long AdminPrincipalId,
        byte[] InitialAdminTokenHash,
        long InitialAccountGeneration,
        long InitialBanGeneration,
        long InitialAdminGeneration,
        string? CreationEventId);

    private sealed record TelemetryRunState(string HitIdentity, string[] ErrorIdentities);
}
