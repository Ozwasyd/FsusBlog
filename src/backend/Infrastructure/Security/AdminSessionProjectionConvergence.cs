using System.Text.Json;

using FsusBlog.Server.Infrastructure.Distributed;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>
/// Holds authority updates and their optional prepared invalidation event; preparation is not publication or commit.
/// </summary>
/// <param name="Sessions">Session facts read from the authority for local application.</param>
/// <param name="Principals">Principal facts read from the authority for local application.</param>
/// <param name="DurableEvent">The event prepared in the delivery ledger when distribution is enabled, or null.</param>
public sealed record PreparedAdminSessionProjectionMutation(
    IReadOnlyList<AdminSessionProjectionSessionUpdate> Sessions,
    IReadOnlyList<AdminSessionProjectionPrincipalUpdate> Principals,
    DistributedInvalidationEvent? DurableEvent);

/// <summary>
/// Separates reading and preparing mutation facts from applying and publishing them after the caller commits.
/// </summary>
/// <remarks>The caller owns the authority transaction; publication does not certify acknowledgement by every node.</remarks>
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

/// <summary>
/// Prepares authority facts and optional ledger outbox work, then applies committed facts locally before publishing.
/// </summary>
/// <param name="authority">Reader of current session and principal authority facts.</param>
/// <param name="projection">Local projection that must accept each published update.</param>
/// <param name="eventFactory">Factory for the versioned internal invalidation event.</param>
/// <param name="options">Distribution configuration governing whether an outbox event is prepared.</param>
/// <param name="publisher">Publisher invoked after local application; its result is not an all-node acknowledgement.</param>
/// <param name="ledger">Delivery ledger required when preparing a distributed event.</param>
public sealed class AdminSessionProjectionMutationCoordinator(
    IAdminSessionProjectionAuthorityReader authority,
    AdminSessionProjection projection,
    DistributedInvalidationEventFactory eventFactory,
    DistributedInvalidationOptions options,
    IDistributedInvalidationPublisher publisher,
    IDistributedInvalidationDeliveryLedger? ledger = null) : IAdminSessionProjectionMutationCoordinator
{
    /// <summary>
    /// Reads nonblank, ordinal-distinct session IDs in sorted order and prepares their updates without applying them.
    /// </summary>
    /// <param name="sessionIds">IDs to read; blank IDs are ignored.</param>
    /// <param name="cancellationToken">Cancellation for authority reads and outbox preparation.</param>
    /// <returns>The read facts and optional ledger-prepared event, or an empty mutation when no IDs remain.</returns>
    /// <exception cref="ArgumentNullException">The ID collection is null.</exception>
    /// <exception cref="InvalidOperationException">An authority fact or required distribution dependency is missing.</exception>
    /// <remarks>Read and ledger failures propagate; this method neither commits the caller's transaction nor publishes.</remarks>
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

    /// <summary>Reads one principal authority fact and prepares its update without applying it.</summary>
    /// <param name="principalId">The principal identity to read from the authority.</param>
    /// <param name="cancellationToken">Cancellation for the authority read and outbox preparation.</param>
    /// <returns>A single-principal mutation with an optional ledger-prepared event.</returns>
    /// <exception cref="InvalidOperationException">The principal fact or required distribution dependency is missing.</exception>
    /// <remarks>Read and ledger failures propagate; the caller retains transaction and commit ownership.</remarks>
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

    /// <summary>Applies prepared principal facts, then session facts, before publishing any prepared event.</summary>
    /// <param name="mutation">Facts prepared before, and published after, the caller's authority commit.</param>
    /// <param name="cancellationToken">Cancellation passed to the event publisher.</param>
    /// <returns>A task completing after local application and, when present, the publisher call.</returns>
    /// <exception cref="ArgumentNullException">The prepared mutation is null.</exception>
    /// <exception cref="InvalidOperationException">The local projection rejects an update.</exception>
    /// <remarks>
    /// Earlier local updates are not rolled back if a later apply or publication fails. The publisher result is not
    /// inspected here, so task completion does not prove remote delivery or acknowledgement.
    /// </remarks>
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

/// <summary>Encodes and decodes versioned admin-session targets for internal distributed invalidation.</summary>
/// <remarks>Payload parsing checks format and update kind, not authenticity or projection admission.</remarks>
public static class AdminSessionProjectionEventCodec
{
    private const string Prefix = "admin-session-projection:v1:";
    private static readonly JsonSerializerOptions s_json = new(JsonSerializerDefaults.Web);

    /// <summary>Encodes a session update as a version-prefixed, base64url internal event target.</summary>
    /// <param name="update">The session fact to serialize with the session payload kind.</param>
    /// <returns>The internal target string; encoding does not publish or apply the update.</returns>
    public static string Format(AdminSessionProjectionSessionUpdate update)
        => Prefix + Base64UrlEncode(JsonSerializer.SerializeToUtf8Bytes(
            new Payload("session", update, null),
            s_json));

    /// <summary>Encodes a principal update as a version-prefixed, base64url internal event target.</summary>
    /// <param name="update">The principal fact to serialize with the principal payload kind.</param>
    /// <returns>The internal target string; encoding does not publish or apply the update.</returns>
    public static string Format(AdminSessionProjectionPrincipalUpdate update)
        => Prefix + Base64UrlEncode(JsonSerializer.SerializeToUtf8Bytes(
            new Payload("principal", null, update),
            s_json));

    /// <summary>Parses a supported target only when its payload contains exactly one matching update kind.</summary>
    /// <param name="value">The nonnull internal target string to inspect.</param>
    /// <param name="session">The parsed session update on session success; otherwise null.</param>
    /// <param name="principal">The parsed principal update on principal success; otherwise null.</param>
    /// <returns>True for a supported session or principal payload; false for unsupported or malformed encoding/JSON.</returns>
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
