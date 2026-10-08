namespace FsusBlog.ArticleVault.MacOS;

// Overflow has one reserved delivery slot. Pending audit records are never overwritten.
internal sealed class MacVaultRawFactBuffer(int capacity)
{
    private readonly Queue<MacVaultRawFact> _facts = new();
    private MacVaultRawFact? _overflow;

    internal bool IsOverflowed => _overflow is not null;

    internal bool TryAppend(MacVaultRawFact fact)
    {
        if (_overflow is not null || _facts.Count >= capacity)
        {
            return false;
        }

        _facts.Enqueue(fact);
        return true;
    }

    internal void RecordOverflow(MacVaultRawFact fact) => _overflow ??= fact;

    internal IReadOnlyList<MacVaultRawFact> Drain()
    {
        var facts = new List<MacVaultRawFact>(_facts.Count + (_overflow is null ? 0 : 1));
        while (_facts.TryDequeue(out MacVaultRawFact? fact))
        {
            facts.Add(fact);
        }

        if (_overflow is not null)
        {
            facts.Add(_overflow);
            _overflow = null;
        }

        return facts;
    }
}
