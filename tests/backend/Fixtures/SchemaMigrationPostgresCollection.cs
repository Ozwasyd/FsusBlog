namespace FsusBlog.Server.Tests;

[CollectionDefinition(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class SchemaMigrationPostgresCollectionA : ICollectionFixture<PostgresSchemaMigrationFixture>;

[CollectionDefinition(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class SchemaMigrationPostgresCollectionB : ICollectionFixture<PostgresSchemaMigrationFixture>;
