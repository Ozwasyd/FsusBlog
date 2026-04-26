namespace FsusBlog.Server.Tests;

[CollectionDefinition(nameof(SchemaMigrationPostgresCollection), DisableParallelization = true)]
public sealed class SchemaMigrationPostgresCollection : ICollectionFixture<PostgresSchemaMigrationFixture>;
