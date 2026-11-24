namespace FsusBlog.V2.Platform.Extensions;

public static class AppearanceRegistryLoader
{
    public static AppearanceRegistry Load(DirectoryInfo root, TimeProvider clock)
    {
        var path = ExtensionDisk.ValidatePrivateRoot(root);
        return AppearanceRegistry.Load((name, limit) => ExtensionDisk.Read(path, name, limit, default), clock);
    }
}
