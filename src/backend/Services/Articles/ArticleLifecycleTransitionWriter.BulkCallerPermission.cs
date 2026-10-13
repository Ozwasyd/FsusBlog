using System.Data;
using System.Runtime.CompilerServices;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Services.Articles.Bulk;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Security;

using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.JwtBearer;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Services.Articles;

public static partial class ArticleLifecycleTransitionWriter
{
    private const int BulkCallerPermissionByteLimit = 32 * 1024;
    private static readonly ConditionalWeakTable<BulkCallerPermissionObservation, BulkCallerPermissionState> s_bulkCallerPermissions = new();

    internal enum BulkCallerPermissionDecision
    {
        OriginalArticleWriteAbsent,
        ExplicitOperationPermissionAbsent,
        OriginalWriteAndExplicitOperationPresent
    }

    /// <summary>
    /// Original authenticated caller/site and persisted permission data only. This is not
    /// whole-set admission, a session lease, document/editor permission or a commit receipt.
    /// </summary>
    internal sealed class BulkCallerPermissionObservation(
        long adminPrincipalId, string siteScope, string operationId, string permissionPolicy,
        BulkCallerPermissionDecision decision, DateTimeOffset jwtNotBeforeUtc, DateTimeOffset jwtExpiresAtUtc)
    {
        internal long AdminPrincipalId { get; } = adminPrincipalId;
        internal string SiteScope { get; } = siteScope;
        internal string OperationId { get; } = operationId;
        internal string PermissionPolicy { get; } = permissionPolicy;
        internal BulkCallerPermissionDecision Decision { get; } = decision;
        internal DateTimeOffset JwtNotBeforeUtc { get; } = jwtNotBeforeUtc;
        internal DateTimeOffset JwtExpiresAtUtc { get; } = jwtExpiresAtUtc;
    }

    private sealed record BulkPersistedCallerFacts(string Status, bool IsRoot, string Permissions,
        string PrincipalRowVersion, string SessionRowVersion, string AccessTokenHash,
        DateTimeOffset? RevokedAtUtc, DateTimeOffset IdleExpiresAtUtc, DateTimeOffset AbsoluteExpiresAtUtc);

    private sealed class BulkCallerPermissionState(ISqlSugarClient database, NpgsqlTransaction transaction,
        HttpContext context, IServiceProvider services, IConfiguration configuration, TimeProvider timeProvider,
        ClaimsPrincipal principal, AuthenticationTicket ticket, AdminSessionValidationService sessions,
        AdminSessionValidationService.CurrentSessionObservation session, string sessionId, byte[] tokenHash,
        DateTimeOffset tokenNotBeforeUtc, DateTimeOffset tokenExpiresAtUtc, BulkPersistedCallerFacts facts)
    {
        internal readonly ISqlSugarClient _database = database;
        internal readonly NpgsqlTransaction _transaction = transaction;
        internal readonly WeakReference<HttpContext> _context = new(context);
        internal readonly WeakReference<IServiceProvider> _services = new(services);
        internal readonly IConfiguration _configuration = configuration;
        internal readonly TimeProvider _timeProvider = timeProvider;
        internal readonly ClaimsPrincipal _principal = principal;
        internal readonly WeakReference<AuthenticationProperties> _ticketProperties = new(ticket.Properties);
        internal readonly AdminSessionValidationService _sessions = sessions;
        internal readonly AdminSessionValidationService.CurrentSessionObservation _session = session;
        internal readonly string _sessionId = sessionId;
        internal readonly byte[] _tokenHash = tokenHash;
        internal readonly DateTimeOffset _tokenNotBeforeUtc = tokenNotBeforeUtc;
        internal readonly DateTimeOffset _tokenExpiresAtUtc = tokenExpiresAtUtc;
        internal readonly BulkPersistedCallerFacts _facts = facts;
        internal int _validationState;
    }

    /// <summary>
    /// Enters through the registered original JwtBearer handler, then reads real persisted
    /// principal/session rows in the caller's exact native transaction. Missing operation
    /// permission is retained as a denial, never mapped from article.write or a digest.
    /// </summary>
    internal static async Task<BulkCallerPermissionObservation> CaptureBulkCallerPermissionAsync(
        ISqlSugarClient database, NpgsqlTransaction originalTransaction, HttpContext context,
        IConfiguration configuration, string expectedSiteScope, string operationId,
        CancellationToken cancellationToken)
    {
        using var requestCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, context.RequestAborted);
        cancellationToken = requestCancellation.Token;
        cancellationToken.ThrowIfCancellationRequested();
        RequireBulkCallerTransaction(database, originalTransaction);
        ArticleBulkOperation operation = RequireBulkCallerOperation(operationId);
        IServiceProvider services = context.RequestServices;
        if (!ReferenceEquals(configuration, services.GetRequiredService<IConfiguration>())
            || services.GetRequiredService<IAdminSessionValidationService>() is not AdminSessionValidationService sessions)
            throw BulkCallerPermissionFailure("original_services_required");
        TimeProvider timeProvider = services.GetRequiredService<TimeProvider>();
        RequireBulkCallerSite(configuration, expectedSiteScope);
        AuthenticateResult authenticated = await context.AuthenticateAsync(JwtBearerDefaults.AuthenticationScheme).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        AuthenticationTicket ticket = RequireBulkCallerTicket(context, authenticated);
        ClaimsPrincipal principal = ticket.Principal;
        if (!principal.IsAdminPrincipal() || !principal.TryGetAdminPrincipalId(out long adminId) || adminId <= 0
            || principal.GetAdminSessionId() is not { Length: > 0 and <= 64 } sessionId)
            throw BulkCallerPermissionFailure("original_admin_required");
        string accessToken = RequireBulkCallerSavedToken(ticket);
        (DateTimeOffset notBefore, DateTimeOffset expires) = ReadBulkCallerTokenTimes(ticket.Properties);
        byte[] tokenHash = SHA256.HashData(Encoding.UTF8.GetBytes(accessToken));
        AdminSessionValidationService.CurrentSessionObservation session = await sessions
            .CaptureCurrentSessionObservationAsync(principal, accessToken, cancellationToken).ConfigureAwait(false)
            ?? throw BulkCallerPermissionFailure("original_session_unavailable");
        BulkPersistedCallerFacts facts = await ReadBulkPersistedCallerFactsAsync(database, originalTransaction,
            adminId, sessionId, lockRows: false, cancellationToken).ConfigureAwait(false);
        BulkCallerPermissionDecision decision = DecideBulkCallerPermission(facts.IsRoot, facts.Permissions, operation.Id);
        var observation = new BulkCallerPermissionObservation(adminId, expectedSiteScope, operation.Id, operation.PermissionPolicy,
            decision, notBefore, expires);
        var state = new BulkCallerPermissionState(database, originalTransaction, context, services, configuration,
            timeProvider, principal, ticket, sessions, session, sessionId, tokenHash, notBefore, expires, facts);
        RequireBulkCallerSources(state, observation, context);
        RequireBulkPersistedCallerCurrent(facts, tokenHash, timeProvider.GetUtcNow(), notBefore, expires);
        RequireBulkCallerSessionAndJwtCurrent(sessions, session, principal, timeProvider,
            notBefore, expires, cancellationToken);
        s_bulkCallerPermissions.Add(observation, state);
        cancellationToken.ThrowIfCancellationRequested();
        return observation;
    }

    /// <summary>
    /// Rechecks actual original caller/site/session and permission rows after taking native
    /// share locks. A changed/refused observation is poisoned, never refreshed into a grant.
    /// Group admission still requires its original whole-set/document/obligation producers.
    /// </summary>
    internal static async Task RevalidateBulkCallerPermissionAfterLockAsync(
        ISqlSugarClient database, NpgsqlTransaction originalTransaction, HttpContext context,
        IConfiguration configuration, BulkCallerPermissionObservation observation,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!s_bulkCallerPermissions.TryGetValue(observation, out BulkCallerPermissionState? state)
            || !ReferenceEquals(database, state._database) || !ReferenceEquals(originalTransaction, state._transaction)
            || !state._context.TryGetTarget(out HttpContext? originalContext) || !ReferenceEquals(context, originalContext)
            || !ReferenceEquals(configuration, state._configuration)
            || Interlocked.CompareExchange(ref state._validationState, 1, 0) != 0)
            throw BulkCallerPermissionFailure("observation_unavailable");
        try
        {
            using var requestCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, context.RequestAborted);
            cancellationToken = requestCancellation.Token;
            RequireBulkCallerSources(state, observation, context);
            AuthenticateResult authenticated = await context.AuthenticateAsync(JwtBearerDefaults.AuthenticationScheme).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            AuthenticationTicket ticket = RequireBulkCallerTicket(context, authenticated);
            if (!state._ticketProperties.TryGetTarget(out AuthenticationProperties? properties))
                throw BulkCallerPermissionFailure("original_authentication_changed");
            RequireBulkCallerTicketFacts(ticket, properties, state._principal, state._tokenHash,
                state._tokenNotBeforeUtc, state._tokenExpiresAtUtc);
            BulkPersistedCallerFacts current = await ReadBulkPersistedCallerFactsAsync(database, originalTransaction,
                observation.AdminPrincipalId, state._sessionId, lockRows: true, cancellationToken).ConfigureAwait(false);
            RequireBulkCallerSources(state, observation, context);
            RequireBulkPersistedCallerCurrent(current, state._tokenHash, state._timeProvider.GetUtcNow(),
                state._tokenNotBeforeUtc, state._tokenExpiresAtUtc);
            if (current != state._facts
                || DecideBulkCallerPermission(current.IsRoot, current.Permissions, observation.OperationId) != observation.Decision)
                throw BulkCallerPermissionFailure("persisted_permission_changed");
            RequireBulkCallerSessionAndJwtCurrent(state._sessions, state._session, state._principal,
                state._timeProvider, state._tokenNotBeforeUtc, state._tokenExpiresAtUtc, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            Volatile.Write(ref state._validationState, 0);
        }
        catch
        {
            Volatile.Write(ref state._validationState, 2);
            throw;
        }
    }

    internal static BulkCallerPermissionDecision DecideBulkCallerPermission(bool isRoot, string permissions, string operationId)
    {
        ArticleBulkOperation operation = RequireBulkCallerOperation(operationId);
        string[] actual = permissions.Split(['\r', '\n', ',', ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        // Root is explicitly allowed by the original writer's article.write check only.
        // There is no original root bypass/mapping for the distinct Bulk operation policy.
        if (!isRoot && !actual.Contains(AdminPermissions.ArticleWrite, StringComparer.Ordinal))
            return BulkCallerPermissionDecision.OriginalArticleWriteAbsent;
        return actual.Contains(operation.PermissionPolicy, StringComparer.Ordinal)
            ? BulkCallerPermissionDecision.OriginalWriteAndExplicitOperationPresent
            : BulkCallerPermissionDecision.ExplicitOperationPermissionAbsent;
    }

    /// <summary>
    /// Final original session/JWT data check, shared by capture and locked revalidation.
    /// Rechecks JWT time after the blocking projection read, before publishing/reusing custody.
    /// Cannot enroll an observation or grant native/whole-set permission on its own.
    /// </summary>
    internal static void RequireBulkCallerSessionAndJwtCurrent(AdminSessionValidationService sessions,
        AdminSessionValidationService.CurrentSessionObservation session, ClaimsPrincipal principal,
        TimeProvider originalTimeProvider, DateTimeOffset tokenNotBeforeUtc, DateTimeOffset tokenExpiresAtUtc,
        CancellationToken cancellationToken)
    {
        if (!sessions.IsCurrentSessionObservation(session, principal, cancellationToken))
            throw BulkCallerPermissionFailure("original_session_changed");
        // Waiting on the original projection gate may cross the independently retained JWT deadline.
        DateTimeOffset now = originalTimeProvider.GetUtcNow();
        cancellationToken.ThrowIfCancellationRequested();
        if (now < tokenNotBeforeUtc || now >= tokenExpiresAtUtc)
            throw BulkCallerPermissionFailure("jwt_lifetime_not_current");
    }

    private static ArticleBulkOperation RequireBulkCallerOperation(string operationId)
    {
        if (operationId is not ("lifecycle.archive" or "lifecycle.restore" or "lifecycle.inbox-to-draft" or "lifecycle.draft-to-inbox"))
            throw BulkCallerPermissionFailure("operation_unsupported");
        return ArticleBulkOperationRegistry.Get(operationId);
    }

    private static void RequireBulkCallerSources(BulkCallerPermissionState state, BulkCallerPermissionObservation observation, HttpContext context)
    {
        context.RequestAborted.ThrowIfCancellationRequested();
        RequireBulkCallerTransaction(state._database, state._transaction);
        if (!state._context.TryGetTarget(out HttpContext? originalContext) || !ReferenceEquals(context, originalContext)
            || !state._services.TryGetTarget(out IServiceProvider? services) || !ReferenceEquals(context.RequestServices, services)
            || !ReferenceEquals(state._configuration, services.GetRequiredService<IConfiguration>())
            || !ReferenceEquals(state._sessions, services.GetRequiredService<IAdminSessionValidationService>())
            || !ReferenceEquals(state._timeProvider, services.GetRequiredService<TimeProvider>())
            || !state._ticketProperties.TryGetTarget(out AuthenticationProperties? properties)
            || ReadBulkCallerTokenTimes(properties) != (state._tokenNotBeforeUtc, state._tokenExpiresAtUtc)
            || !CryptographicOperations.FixedTimeEquals(state._tokenHash,
                SHA256.HashData(Encoding.UTF8.GetBytes(RequireBulkCallerSavedToken(properties))))
            || !ReferenceEquals(context.User, state._principal)
            || observation.JwtNotBeforeUtc != state._tokenNotBeforeUtc || observation.JwtExpiresAtUtc != state._tokenExpiresAtUtc
            || state._principal.Identity?.IsAuthenticated != true || !state._principal.IsAdminPrincipal()
            || !state._principal.TryGetAdminPrincipalId(out long adminId) || adminId != observation.AdminPrincipalId
            || state._principal.GetAdminSessionId() != state._sessionId
            || RequireBulkCallerOperation(observation.OperationId).PermissionPolicy != observation.PermissionPolicy)
            throw BulkCallerPermissionFailure("original_caller_changed");
        RequireBulkCallerSite(state._configuration, observation.SiteScope);
    }

    private static void RequireBulkCallerSite(IConfiguration configuration, string expectedSiteScope)
    {
        string current = SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope(configuration);
        if (string.IsNullOrWhiteSpace(expectedSiteScope) || expectedSiteScope.Length > 2048
            || expectedSiteScope.Any(char.IsControl) || !string.Equals(current, expectedSiteScope, StringComparison.Ordinal))
            throw BulkCallerPermissionFailure("original_site_changed");
    }

    private static AuthenticationTicket RequireBulkCallerTicket(HttpContext context, AuthenticateResult result)
    {
        if (!result.Succeeded || result.Ticket is not { } ticket
            || ticket.AuthenticationScheme != JwtBearerDefaults.AuthenticationScheme
            || ticket.Principal.Identity?.IsAuthenticated != true || !ReferenceEquals(context.User, ticket.Principal))
            throw BulkCallerPermissionFailure("original_authentication_required");
        return ticket;
    }

    private static string RequireBulkCallerSavedToken(AuthenticationTicket ticket)
        => RequireBulkCallerSavedToken(ticket.Properties);

    private static string RequireBulkCallerSavedToken(AuthenticationProperties properties)
        => properties.GetTokenValue("access_token") is { Length: > 0 and <= 16 * 1024 } token
            ? token : throw BulkCallerPermissionFailure("original_saved_token_required");

    /// <summary>Exact ticket data comparison only; cannot enroll an observation or grant admission.</summary>
    internal static void RequireBulkCallerTicketFacts(AuthenticationTicket ticket, AuthenticationProperties originalProperties,
        ClaimsPrincipal originalPrincipal, byte[] tokenHash, DateTimeOffset notBeforeUtc, DateTimeOffset expiresAtUtc)
    {
        // AuthenticationService recreates ticket envelopes; original handler properties/principal remain the inputs.
        if (ticket.AuthenticationScheme != JwtBearerDefaults.AuthenticationScheme || !ReferenceEquals(ticket.Properties, originalProperties)
            || !ReferenceEquals(ticket.Principal, originalPrincipal) || originalPrincipal.Identity?.IsAuthenticated != true
            || ReadBulkCallerTokenTimes(ticket.Properties) != (notBeforeUtc, expiresAtUtc)
            || !CryptographicOperations.FixedTimeEquals(tokenHash,
                SHA256.HashData(Encoding.UTF8.GetBytes(RequireBulkCallerSavedToken(ticket)))))
            throw BulkCallerPermissionFailure("original_authentication_changed");
    }

    private static (DateTimeOffset NotBefore, DateTimeOffset Expires) ReadBulkCallerTokenTimes(AuthenticationProperties properties)
    {
        // Original JwtBearer10.0.7 retains validated SecurityToken.ValidFrom/ValidTo here.
        // Missing data refuses; arbitrary JWT parsing is not an alternative admission path.
        if (properties.IssuedUtc is not { } notBefore || properties.ExpiresUtc is not { } expires
            || expires <= notBefore)
            throw BulkCallerPermissionFailure("original_token_lifetime_required");
        return (notBefore, expires);
    }

    private static NpgsqlConnection RequireBulkCallerTransaction(ISqlSugarClient database, NpgsqlTransaction transaction)
    {
        NpgsqlConnection connection = RequireBulkRevisionTransaction(database, transaction);
        // A retained RepeatableRead snapshot cannot prove fresh permission changes at revalidation.
        if (transaction.IsolationLevel != IsolationLevel.ReadCommitted)
            throw BulkCallerPermissionFailure("fresh_native_permission_scope_required");
        return connection;
    }

    private static async Task<BulkPersistedCallerFacts> ReadBulkPersistedCallerFactsAsync(ISqlSugarClient database,
        NpgsqlTransaction transaction, long adminId, string sessionId, bool lockRows, CancellationToken cancellationToken)
    {
        using var command = new NpgsqlCommand("""
            SELECT ap.status,ap.isroot,
                   CASE WHEN octet_length(ap.permissions)<=@PermissionByteLimit THEN ap.permissions ELSE NULL END,
                   ap.xmin::text,s.xmin::text,s.accesstokenhash,s.revokedatutc,s.idleexpiresatutc,s.absoluteexpiresatutc
            FROM admin_principal ap JOIN admin_session s ON s.adminprincipalid=ap.id
            WHERE ap.id=@AdminPrincipalId AND s.sessionid=@SessionId
            """ + (lockRows ? " FOR SHARE OF ap,s;" : ";"), RequireBulkCallerTransaction(database, transaction), transaction);
        command.Parameters.AddWithValue("PermissionByteLimit", BulkCallerPermissionByteLimit);
        command.Parameters.AddWithValue("AdminPrincipalId", adminId);
        command.Parameters.AddWithValue("SessionId", sessionId);
        using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false) || reader.IsDBNull(2))
            throw BulkCallerPermissionFailure("persisted_caller_unavailable");
        var facts = new BulkPersistedCallerFacts(reader.GetString(0), reader.GetBoolean(1), reader.GetString(2),
            reader.GetString(3), reader.GetString(4), reader.GetString(5),
            reader.IsDBNull(6) ? null : new DateTimeOffset(DateTime.SpecifyKind(reader.GetDateTime(6), DateTimeKind.Utc)),
            new DateTimeOffset(DateTime.SpecifyKind(reader.GetDateTime(7), DateTimeKind.Utc)),
            new DateTimeOffset(DateTime.SpecifyKind(reader.GetDateTime(8), DateTimeKind.Utc)));
        if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            throw BulkCallerPermissionFailure("persisted_caller_ambiguous");
        RequireBulkCallerTransaction(database, transaction);
        cancellationToken.ThrowIfCancellationRequested();
        return facts;
    }

    private static void RequireBulkPersistedCallerCurrent(BulkPersistedCallerFacts facts, byte[] tokenHash,
        DateTimeOffset now, DateTimeOffset tokenNotBeforeUtc, DateTimeOffset tokenExpiresAtUtc)
    {
        if (facts.Status != AdminPrincipalStatus.Active || facts.RevokedAtUtc.HasValue
            || facts.IdleExpiresAtUtc <= now || facts.AbsoluteExpiresAtUtc <= now
            || now < tokenNotBeforeUtc || now >= tokenExpiresAtUtc
            || !IsBulkRowVersion(facts.PrincipalRowVersion) || !IsBulkRowVersion(facts.SessionRowVersion)
            || facts.AccessTokenHash.Length != 64 || facts.AccessTokenHash.Any(static c => !char.IsAsciiHexDigit(c))
            || !CryptographicOperations.FixedTimeEquals(tokenHash, Convert.FromHexString(facts.AccessTokenHash)))
            throw BulkCallerPermissionFailure("persisted_caller_not_current");
    }

    private static ArticleWriteValidationException BulkCallerPermissionFailure(string reason)
        => new($"article_bulk_caller_permission_{reason}", "Original caller/site/session permission observation is unavailable or changed.");
}
