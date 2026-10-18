using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Tests.Helpers;

internal static class TransientMemoryTestLedger
{
    internal static (MemoryReservationCoordinator Ledger, ResourceDomainId Host, ResourceDomainId Operations) Create(long bytes)
    {
        var host = new ResourceDomainId(Guid.NewGuid());
        var operations = new ResourceDomainId(Guid.NewGuid());
        var topology = new MemoryResourceTopology([
            new(host, "host", MemoryResourceUnit.Bytes, null),
            new(operations, "operations", MemoryResourceUnit.OperationSlots, null)
        ]);
        return (new(topology, [new(host, MemoryResourceUnit.Bytes, bytes),
            new(operations, MemoryResourceUnit.OperationSlots, 4)], 1, 32, 1024), host, operations);
    }
}
