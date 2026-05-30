namespace FsusBlog.Server.Infrastructure.Cache;

public interface IRuntimeKeyScope
{
    string PrefixKey(string key);
}

public sealed class DefaultRuntimeKeyScope : IRuntimeKeyScope
{
    public string PrefixKey(string key) => key;
}
