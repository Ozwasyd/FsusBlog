namespace FsusBlog.Server.Infrastructure.Bootstrap;

public sealed class LifecycleBootstrapOptions
{
    public const string SectionName = "Lifecycle";

    public bool ClearAotDiskCacheOnStartup { get; init; }
}