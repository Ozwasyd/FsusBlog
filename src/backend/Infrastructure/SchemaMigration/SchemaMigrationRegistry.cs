namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public interface ISchemaMigrationRegistry
{
    IReadOnlyList<ISchemaMigrationDescriptor> GetDescriptors();
}

public sealed class SchemaMigrationRegistry : ISchemaMigrationRegistry
{
    private readonly IReadOnlyList<ISchemaMigrationDescriptor> _descriptors =
        SchemaMigrationManifest.Current.Descriptors;

    public IReadOnlyList<ISchemaMigrationDescriptor> GetDescriptors() => _descriptors;
}
