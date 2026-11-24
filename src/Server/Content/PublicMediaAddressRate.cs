namespace FsusBlog.V2.Server.Content;

internal sealed class PublicMediaAddressRate(TimeProvider clock)
{
    private const int ExcessRequests = 30;
    private const int MaximumAddresses = 131_072;
    private readonly long interval = (clock.TimestampFrequency + 9) / 10;
    private readonly Dictionary<IPAddress, LinkedListNode<AddressDebt>> pending = [];
    private readonly LinkedList<AddressDebt> activity = new();

    internal bool Admit(IPAddress address)
    {
        lock (pending)
        {
            var now = clock.GetTimestamp();
            // Even the largest debt is fully replenished this long after the last admission.
            if (activity.First is { } oldest && now - oldest.Value.LastAdmission >= interval * (ExcessRequests + 1))
            {
                pending.Remove(oldest.Value.Address);
                activity.RemoveFirst();
            }
            if (!pending.TryGetValue(address, out var entry))
            {
                if (pending.Count == MaximumAddresses) return false;
                var debt = new AddressDebt(address, now, now + interval);
                pending.Add(address, activity.AddLast(debt));
                return true;
            }

            // The next nominal request may arrive early by up to thirty intervals.
            if (entry.Value.NextNominalTime - now > interval * ExcessRequests) return false;
            entry.Value = new AddressDebt(address, now, Math.Max(now, entry.Value.NextNominalTime) + interval);
            activity.Remove(entry);
            activity.AddLast(entry);
            return true;
        }
    }

    private readonly record struct AddressDebt(IPAddress Address, long LastAdmission, long NextNominalTime);
}
