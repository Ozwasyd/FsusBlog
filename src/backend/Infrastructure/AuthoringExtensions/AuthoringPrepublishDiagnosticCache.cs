using System.Diagnostics.CodeAnalysis;
using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>
/// Bounded, request-exact storage of structurally verified outcomes. The original host must supply admitted
/// current inputs and invalidate on authority loss. This component neither observes live grants nor proves
/// lifecycle generation: diagnostic schema v1 has no generation binding. No receipt eligibility is issued.
/// </summary>
internal sealed class AuthoringPrepublishDiagnosticCache
{
    private const int MaximumRetainedBytes = 64 * 1024 * 1024;

    private readonly object _gate = new();
    private readonly Dictionary<Slot, Entry> _entries = [];
    private readonly int _maximumEntries;
    private readonly int _maximumBytes;
    private readonly TimeProvider _timeProvider;
    private int _retainedBytes;

    internal AuthoringPrepublishDiagnosticCache(int maximumEntries, int maximumBytes, TimeProvider timeProvider)
    {
        ArgumentNullException.ThrowIfNull(timeProvider);
        if (maximumEntries is < 1 or > AuthoringPrepublishDiagnosticRegistry.MaximumDiagnostics ||
            maximumBytes is < 1 or > MaximumRetainedBytes)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumEntries), "Cache limits must be explicit and bounded.");
        }

        _maximumEntries = maximumEntries;
        _maximumBytes = maximumBytes;
        _timeProvider = timeProvider;
    }

    /// <summary>
    /// Advances this host's current observation and retires its previous evaluation ticket, even for identical
    /// input. Every identity in the original InputSha256, including request and deadline, participates in reuse.
    /// Call only after the original host has admitted current package, document, configuration and read authority.
    /// </summary>
    internal Ticket SetCurrent(AuthoringPrepublishDiagnosticRegistry registry, AuthoringPrepublishDiagnosticInput input)
    {
        ArgumentNullException.ThrowIfNull(registry);
        ArgumentNullException.ThrowIfNull(input);
        lock (_gate)
        {
            DateTimeOffset now = _timeProvider.GetUtcNow();
            // Unavailable is the existing public input-binding validator; its classification is never cached.
            _ = registry.Unavailable(input, AuthoringDiagnosticUnavailableReason.Stale);
            _ = registry.CreateInput(input.DiagnosticId, input.Context, input.Metadata, input.SourceRanges, now);
            PruneExpired(now);
            Slot slot = SlotFor(input);
            _entries.TryGetValue(slot, out Entry? previous);
            if (previous is not null && (input.Context.DocumentEpoch < previous.Input.Context.DocumentEpoch ||
                input.Context.DocumentEpoch == previous.Input.Context.DocumentEpoch &&
                input.Context.SourceRevision < previous.Input.Context.SourceRevision))
            {
                throw new AuthoringExtensionContractException("Diagnostic current observation cannot regress its source or epoch.");
            }

            AuthoringPrepublishDiagnosticResult? retained = previous?.Input.InputSha256 == input.InputSha256
                ? previous.Result : null;
            int bytes = JsonSerializer.SerializeToUtf8Bytes(input).Length;
            if (retained is not null)
            {
                bytes += ResponseBytes(retained);
            }

            if (previous is null && _entries.Count >= _maximumEntries ||
                (long)_retainedBytes - (previous?.Bytes ?? 0) + bytes > _maximumBytes)
            {
                throw new AuthoringExtensionContractException("Diagnostic cache admission exceeds its explicit limits.");
            }

            if (_timeProvider.GetUtcNow() >= input.Context.Deadline)
            {
                throw new AuthoringExtensionContractException("Diagnostic current observation expired during admission.");
            }

            var ticket = new Ticket(input);
            _retainedBytes += bytes - (previous?.Bytes ?? 0);
            _entries[slot] = new Entry(ticket, registry, input, retained, bytes);
            return ticket;
        }
    }

    /// <summary>
    /// Accepts at most one completed result for a still-current local ticket. A foreign, superseded, expired,
    /// unavailable or already completed evaluation cannot overwrite a current outcome.
    /// </summary>
    internal bool TryStore(Ticket ticket, AuthoringPrepublishDiagnosticResult result)
    {
        ArgumentNullException.ThrowIfNull(ticket);
        ArgumentNullException.ThrowIfNull(result);
        lock (_gate)
        {
            PruneExpired(_timeProvider.GetUtcNow());
            if (!TryFind(ticket, out Entry? entry) || entry.Result is not null ||
                result.Input.InputSha256 != entry.Input.InputSha256 || result.UnavailableReason is not null ||
                result.Status is not (AuthoringDiagnosticOutcomeStatus.Findings or AuthoringDiagnosticOutcomeStatus.NoFindings))
            {
                return false;
            }

            AuthoringPrepublishDiagnosticResult verified = Revalidate(entry.Registry, result);
            int bytes = ResponseBytes(verified);
            if ((long)_retainedBytes + bytes > _maximumBytes ||
                _timeProvider.GetUtcNow() >= entry.Input.Context.Deadline)
            {
                return false;
            }

            entry.Result = verified;
            entry.Bytes += bytes;
            _retainedBytes += bytes;
            return true;
        }
    }

    /// <summary>Returns only the exact current request's revalidated completion before its original deadline.</summary>
    internal bool TryGet(Ticket ticket, [NotNullWhen(true)] out AuthoringPrepublishDiagnosticResult? result)
    {
        ArgumentNullException.ThrowIfNull(ticket);
        lock (_gate)
        {
            result = null;
            PruneExpired(_timeProvider.GetUtcNow());
            if (!TryFind(ticket, out Entry? entry) || entry.Result is null)
            {
                return false;
            }

            AuthoringPrepublishDiagnosticResult verified = Revalidate(entry.Registry, entry.Result);
            if (_timeProvider.GetUtcNow() >= entry.Input.Context.Deadline)
            {
                return false;
            }

            result = verified;
            return true;
        }
    }

    /// <summary>
    /// Retires all local tickets and results for an extension on revoke, disable, update or uninstall.
    /// Re-admission of identical bytes still creates a distinct ticket; invalidation never restores authority.
    /// </summary>
    internal void InvalidateExtension(string extensionId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(extensionId);
        lock (_gate)
        {
            Slot[] slots = [.. _entries.Where(pair => pair.Value.Input.ExtensionId == extensionId).Select(static pair => pair.Key)];
            foreach (Slot slot in slots)
            {
                Remove(slot);
            }
        }
    }

    private AuthoringPrepublishDiagnosticResult Revalidate(
        AuthoringPrepublishDiagnosticRegistry registry, AuthoringPrepublishDiagnosticResult result)
    {
        AuthoringPrepublishDiagnosticResult verified = registry.ValidateResult(result.Input, Response(result), _timeProvider.GetUtcNow());
        if (result.Required != verified.Required || result.Status != verified.Status)
        {
            throw new AuthoringExtensionContractException("Cached outcome differs from its original host policy.");
        }

        return verified;
    }

    private bool TryFind(Ticket ticket, [NotNullWhen(true)] out Entry? entry) =>
        _entries.TryGetValue(SlotFor(ticket.Input), out entry) && ReferenceEquals(entry.Ticket, ticket);

    private void PruneExpired(DateTimeOffset now)
    {
        Slot[] slots = [.. _entries.Where(pair => now >= pair.Value.Input.Context.Deadline).Select(static pair => pair.Key)];
        foreach (Slot slot in slots)
        {
            Remove(slot);
        }
    }

    private void Remove(Slot slot)
    {
        _retainedBytes -= _entries[slot].Bytes;
        _entries.Remove(slot);
    }

    private static Slot SlotFor(AuthoringPrepublishDiagnosticInput input) =>
        new(input.Context.ArticleId, input.Context.DocumentId, input.DiagnosticId);

    private static AuthoringPrepublishDiagnosticResponse Response(AuthoringPrepublishDiagnosticResult result) => new(
        AuthoringPrepublishDiagnosticRegistry.SchemaVersion, result.Input.DiagnosticId, result.Input.InputSha256,
        result.Status == AuthoringDiagnosticOutcomeStatus.Findings ? AuthoringDiagnosticCompletion.Findings :
            AuthoringDiagnosticCompletion.NoFindings, result.Facts);

    private static int ResponseBytes(AuthoringPrepublishDiagnosticResult result) =>
        JsonSerializer.SerializeToUtf8Bytes(Response(result)).Length;

    internal sealed class Ticket(AuthoringPrepublishDiagnosticInput input)
    {
        internal AuthoringPrepublishDiagnosticInput Input { get; } = input;
    }

    private readonly record struct Slot(long ArticleId, string DocumentId, string DiagnosticId);

    private sealed class Entry(
        Ticket ticket,
        AuthoringPrepublishDiagnosticRegistry registry,
        AuthoringPrepublishDiagnosticInput input,
        AuthoringPrepublishDiagnosticResult? result,
        int bytes)
    {
        internal Ticket Ticket { get; } = ticket;
        internal AuthoringPrepublishDiagnosticRegistry Registry { get; } = registry;
        internal AuthoringPrepublishDiagnosticInput Input { get; } = input;
        internal AuthoringPrepublishDiagnosticResult? Result { get; set; } = result;
        internal int Bytes { get; set; } = bytes;
    }
}
