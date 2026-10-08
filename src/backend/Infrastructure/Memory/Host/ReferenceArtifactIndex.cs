namespace FsusBlog.Server.Infrastructure.Memory.Host;

/// <summary>Dictionary oracle for the same normalized routes, IDs, identities and eligibility.</summary>
internal sealed class ReferenceArtifactIndex
{
    private readonly Dictionary<long, FlatArtifactDescriptor> _ids = new();
    private readonly Dictionary<string, FlatArtifactDescriptor> _routes = new(StringComparer.Ordinal);
    private readonly FlatArtifactIndexLimits _limits;

    internal ReferenceArtifactIndex(IReadOnlyList<FlatArtifactIndexEntry> entries, FlatArtifactIndexLimits limits)
    {
        ArgumentNullException.ThrowIfNull(entries);
        ArgumentNullException.ThrowIfNull(limits);
        if (!limits.IsValid || entries.Count > limits.MaximumEntries)
        {
            throw new ArgumentException("Entries exceed the finite index limits.", nameof(entries));
        }
        _limits = limits;
        foreach (FlatArtifactIndexEntry entry in entries)
        {
            if (!entry.Descriptor.IsValid
                || !FlatArtifactIndexLayout.TryCanonicalize(entry.RouteKey, limits.MaximumKeyBytes, out string route))
            {
                throw new ArgumentException("Invalid descriptor or canonical route.", nameof(entries));
            }
            _ids.Add(entry.Descriptor.Id, entry.Descriptor);
            _routes.Add(route, entry.Descriptor);
        }
    }

    internal bool TryGetId(long id, out FlatArtifactDescriptor descriptor)
        => _ids.TryGetValue(id, out descriptor) && descriptor.IsEligible;

    internal bool TryGetRoute(string route, out FlatArtifactDescriptor descriptor)
    {
        descriptor = default;
        return FlatArtifactIndexLayout.TryCanonicalize(route, _limits.MaximumKeyBytes, out string canonical)
            && _routes.TryGetValue(canonical, out descriptor) && descriptor.IsEligible;
    }
}
