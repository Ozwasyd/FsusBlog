using System.Text.Json;

using FsusBlog.Server.Infrastructure.Distributed;

namespace FsusBlog.Server.Infrastructure.Security;

public sealed record PreparedAdminSessionProjectionMutation(
    IReadOnlyList<AdminSessionProjectionSessionUpdate> Sessions,
    IReadOnlyList<AdminSessionProjectionPrincipalUpdate> Principals,
    DistributedInvalidationEvent? DurableEvent);

public interface IAdminSessionProjectionMutationCoordinator
{
    Task<PreparedAdminSessionProjectionMutation> PrepareSessionsAsync(
        IReadOnlyCollection<string> sessionIds,
        CancellationToken cancellationToken = default);

    Task<PreparedAdminSessionProjectionMutation> PreparePrincipalAsync(
        long principalId,
        CancellationToken cancellationToken = default);

    Task PublishPreparedAsync(
        PreparedAdminSessionProjectionMutation mutation,
        CancellationToken cancellationToken = default);
}

public sealed class AdminSessionProjectionMutationCoordinator(
    IAdminSessionProjectionAuthorityReader authority,
    AdminSessionProjection projection,
    DistributedInvalidationEventFactory eventFactory,
    DistributedInvalidationOptions options,
    IDistributedInvalidationPublisher publisher,
    IDistributedInvalidationDeliveryLedger? ledger = null) : IAdminSessionProjectionMutationCoordinator
{
    public async Task<PreparedAdminSessionProjectionMutation> PrepareSessionsAsync(
        IReadOnlyCollection<string> sessionIds,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(sessionIds);
        string[] ids = sessionIds
            .Where(static value => !string.IsNullOrWhiteSpace(value))
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        var sessions = new List<AdminSessionProjectionSessionUpdate>(ids.Length);
        foreach (string sessionId in ids)
        {
            AdminSessionProjectionSessionUpdate? update =
                await authority.ReadSessionAsync(sessionId, cancellationToken).ConfigureAwait(false);
            if (!update.HasValue)
            {
                throw new InvalidOperationException("admin_session_projection_mutation_state_missing");
            }
            sessions.Add(update.Value);
        }
        return await PrepareAsync(sessions, [], cancellationToken).ConfigureAwait(false);
    }

    public async Task<PreparedAdminSessionProjectionMutation> PreparePrincipalAsync(
        long principalId,
        CancellationToken cancellationToken = default)
    {
        AdminSessionProjectionPrincipalUpdate? update =
            await authority.ReadPrincipalAsync(principalId, cancellationToken).ConfigureAwait(false);
        if (!update.HasValue)
        {
            throw new InvalidOperationException("admin_principal_projection_mutation_state_missing");
        }
        return await PrepareAsync([], [update.Value], cancellationToken).ConfigureAwait(false);
    }

    public async Task PublishPreparedAsync(
        PreparedAdminSessionProjectionMutation mutation,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(mutation);
        foreach (AdminSessionProjectionPrincipalUpdate principal in mutation.Principals)
        {
            EnsureApplied(projection.Apply(principal));
        }
        foreach (AdminSessionProjectionSessionUpdate session in mutation.Sessions)
        {
            EnsureApplied(projection.Apply(session));
        }
        if (mutation.DurableEvent is not null)
        {
            _ = await publisher.PublishPreparedAsync(mutation.DurableEvent, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task<PreparedAdminSessionProjectionMutation> PrepareAsync(
        IReadOnlyList<AdminSessionProjectionSessionUpdate> sessions,
        IReadOnlyList<AdminSessionProjectionPrincipalUpdate> principals,
        CancellationToken cancellationToken)
    {
        if (sessions.Count == 0 && principals.Count == 0)
        {
            return new PreparedAdminSessionProjectionMutation([], [], null);
        }
        DistributedInvalidationEvent? durableEvent = null;
        if (options.Enabled)
        {
            string[] targets =
            [
                .. principals.Select(AdminSessionProjectionEventCodec.Format),
                .. sessions.Select(AdminSessionProjectionEventCodec.Format)
            ];
            durableEvent = eventFactory.Create(new DistributedInvalidationRequest(
                DistributedInvalidationEventKinds.AdminSessionProjectionMutation,
                [],
                [],
                targets));
            await (ledger ?? throw new InvalidOperationException("distributed_invalidation_delivery_ledger_missing")).PrepareOutboxAsync(
                durableEvent,
                options.Topology ?? throw new InvalidOperationException("distributed_invalidation_topology_required"),
                cancellationToken).ConfigureAwait(false);
        }
        return new PreparedAdminSessionProjectionMutation(sessions, principals, durableEvent);
    }

    private static void EnsureApplied(AdminSessionProjectionApplyResult result)
    {
        if (!result.Accepted)
        {
            throw new InvalidOperationException($"admin_session_projection_mutation_{result.Status}");
        }
    }
}

public static class AdminSessionProjectionEventCodec
{
    private const string Prefix = "admin-session-projection:v1:";
    private static readonly JsonSerializerOptions s_json = new(JsonSerializerDefaults.Web);

    public static string Format(AdminSessionProjectionSessionUpdate update)
        => Prefix + Base64UrlEncode(JsonSerializer.SerializeToUtf8Bytes(
            new Payload("session", update, null),
            s_json));

    public static string Format(AdminSessionProjectionPrincipalUpdate update)
        => Prefix + Base64UrlEncode(JsonSerializer.SerializeToUtf8Bytes(
            new Payload("principal", null, update),
            s_json));

    public static bool TryParse(
        string value,
        out AdminSessionProjectionSessionUpdate? session,
        out AdminSessionProjectionPrincipalUpdate? principal)
    {
        session = null;
        principal = null;
        if (!value.StartsWith(Prefix, StringComparison.Ordinal))
        {
            return false;
        }
        try
        {
            Payload? payload = JsonSerializer.Deserialize<Payload>(
                Base64UrlDecode(value[Prefix.Length..]),
                s_json);
            if (payload is null)
            {
                return false;
            }
            if (string.Equals(payload.Type, "session", StringComparison.Ordinal)
                && payload.Session.HasValue
                && !payload.Principal.HasValue)
            {
                session = payload.Session.Value;
                return true;
            }
            if (string.Equals(payload.Type, "principal", StringComparison.Ordinal)
                && payload.Principal.HasValue
                && !payload.Session.HasValue)
            {
                principal = payload.Principal.Value;
                return true;
            }
            return false;
        }
        catch (Exception ex) when (ex is FormatException or JsonException)
        {
            return false;
        }
    }

    private static string Base64UrlEncode(ReadOnlySpan<byte> value)
        => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] Base64UrlDecode(string value)
    {
        string padded = value.Replace('-', '+').Replace('_', '/');
        padded += (padded.Length % 4) switch
        {
            2 => "==",
            3 => "=",
            _ => string.Empty
        };
        return Convert.FromBase64String(padded);
    }

    private sealed record Payload(
        string Type,
        AdminSessionProjectionSessionUpdate? Session,
        AdminSessionProjectionPrincipalUpdate? Principal);
}
