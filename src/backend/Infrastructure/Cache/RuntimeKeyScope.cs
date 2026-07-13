namespace FsusBlog.Server.Infrastructure.Cache;

public interface IRuntimeKeyScope
{
    /// <summary>
    /// Stable process-local scope token used by structured L1 keys. Implementations should
    /// return an existing token and avoid constructing a complete Redis prefix per lookup.
    /// </summary>
    string ScopeToken => PrefixKey(string.Empty);
    string PrefixKey(string key);
}

public sealed class DefaultRuntimeKeyScope : IRuntimeKeyScope
{
    public string ScopeToken => string.Empty;
    public string PrefixKey(string key) => key;
}
