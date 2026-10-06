using System.Runtime.CompilerServices;
using System.Text.Json;

using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Infrastructure.Audit;

/// <summary>
/// Owns an independent admin event identity, immutable payload and its durable
/// reservation of the existing database primary key. Identical content is not identity.
/// </summary>
internal sealed class AdminAuditDurableDelivery
{
    private static readonly ConditionalWeakTable<AdminAuditLog, AdminAuditDurableDelivery> s_deliveries = new();
    private readonly AdminAuditFallbackWriter _owner;
    private readonly string _payload;

    internal AdminAuditDurableEntry Entry
    {
        get; private set;
    }

    private AdminAuditDurableDelivery(AdminAuditDurableEntry entry, AdminAuditFallbackWriter owner)
    {
        Entry = entry;
        _owner = owner;
        _payload = SerializePayload(entry.Payload);
    }

    internal static AdminAuditLog Bind(AdminAuditDurableEntry entry, AdminAuditFallbackWriter owner)
    {
        AdminAuditLog record = Copy(entry.Payload);
        record.Id = entry.DatabaseId;
        s_deliveries.Add(record, new AdminAuditDurableDelivery(entry, owner));
        return record;
    }

    internal static bool IsBound(AdminAuditLog record) => s_deliveries.TryGetValue(record, out _);

    internal static void BindSource(AdminAuditLog source, AdminAuditLog delivery)
        => s_deliveries.Add(source, GetRequired(delivery));

    internal static AdminAuditDurableDelivery GetRequired(AdminAuditLog record)
    {
        if (!s_deliveries.TryGetValue(record, out AdminAuditDurableDelivery? delivery))
        {
            throw new InvalidDataException("admin_audit_durable_identity_required");
        }
        if (delivery._payload != SerializePayload(record)
            || (record.Id != 0 && record.Id != delivery.Entry.DatabaseId))
        {
            throw new InvalidDataException("admin_audit_durable_payload_mismatch");
        }
        return delivery;
    }

    internal async Task<long> ReserveDatabaseIdAsync(
        Func<Task<long>> reserve, CancellationToken cancellationToken)
    {
        Entry = await _owner.ReserveDatabaseIdAsync(Entry, reserve, cancellationToken).ConfigureAwait(false);
        return Entry.DatabaseId;
    }

    internal static AdminAuditLog Copy(AdminAuditLog record)
        => JsonSerializer.Deserialize<AdminAuditLog>(JsonSerializer.Serialize(record))!;

    internal static string SerializePayload(AdminAuditLog record)
    {
        AdminAuditLog copy = Copy(record);
        copy.Id = 0;
        return JsonSerializer.Serialize(copy);
    }

    internal static bool MatchesStored(AdminAuditLog expected, AdminAuditLog actual)
    {
        AdminAuditLog copy = Copy(expected);
        DateTime utc = copy.OccurredAtUtc.Kind == DateTimeKind.Unspecified
            ? DateTime.SpecifyKind(copy.OccurredAtUtc, DateTimeKind.Utc)
            : copy.OccurredAtUtc.ToUniversalTime();
        copy.OccurredAtUtc = new DateTime(utc.Ticks - utc.Ticks % 10, DateTimeKind.Utc);
        AdminAuditLog stored = Copy(actual);
        stored.OccurredAtUtc = DateTime.SpecifyKind(stored.OccurredAtUtc, DateTimeKind.Utc);
        return SerializePayload(copy) == SerializePayload(stored);
    }
}

internal sealed record AdminAuditDurableEntry(
    Guid DeliveryId, long PublicationTicks, long DatabaseId, AdminAuditLog Payload);
