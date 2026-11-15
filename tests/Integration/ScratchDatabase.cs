using System.Security.Cryptography;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Sessions;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

internal sealed class ScratchDatabase : IAsyncDisposable
{
    internal const string Variable = "FSUSBLOG_TEST_DB";

    private readonly string _database;
    private readonly string _maintenanceConnectionString;
    internal string ConnectionString { get; }
    internal NpgsqlDataSource DataSource { get; }

    internal async Task<(Guid Id, string Token, string Handle)> SignIn(string name, CancellationToken ct, bool canAuthor = true)
    {
        var id = Guid.NewGuid();
        await using (var connection = await DataSource.OpenConnectionAsync(ct))
        await using (var account = Store.Sql(connection, null, """
            insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,$3,true,1)
            """, id, name, canAuthor))
            await account.ExecuteNonQueryAsync(ct);
        return await SignIn(id, ct);
    }

    internal async Task<(Guid Id, string Token, string Handle)> SignIn(Guid id, CancellationToken ct)
    {
        var key = RandomNumberGenerator.GetBytes(32);
        await using (var connection = await DataSource.OpenConnectionAsync(ct))
        await using (var ticket = Store.Sql(connection, null, """
            insert into public.login_ticket(digest,user_id,expires_at) values($1,$2,now()+interval '2 minutes')
            """, SHA256.HashData(key), id))
            await ticket.ExecuteNonQueryAsync(ct);
        var token = (await new Store(DataSource).SignIn(Convert.ToHexStringLower(key), ct)).Token;
        return (id, token, SiteSessions.Id(id, Store.TokenDigest(token)!));
    }

    private ScratchDatabase(string maintenanceConnectionString, string database)
    {
        _database = database;
        _maintenanceConnectionString = maintenanceConnectionString;
        ConnectionString = new NpgsqlConnectionStringBuilder(maintenanceConnectionString) { Database = database }.ConnectionString;
        DataSource = NpgsqlDataSource.Create(ConnectionString);
    }

    internal static async Task<ScratchDatabase> Create(string dsn, CancellationToken ct)
    {
        var settings = new NpgsqlConnectionStringBuilder(dsn);
        if (string.IsNullOrWhiteSpace(settings.Database))
            throw new InvalidOperationException($"Specify a maintenance database in {Variable}.");
        var name = $"fsusv2_test_{Guid.NewGuid():N}";
        await using (var maintenance = new NpgsqlConnection(settings.ConnectionString))
        {
            await maintenance.OpenAsync(ct);
            await using var create = new NpgsqlCommand($"CREATE DATABASE {name} TEMPLATE template0", maintenance);
            await create.ExecuteNonQueryAsync(ct);
        }

        var database = new ScratchDatabase(settings.ConnectionString, name);
        try
        {
            var schema = SchemaDirectory();
            var supplements = Directory.EnumerateFiles(schema, "*.sql").Where(file => Path.GetFileName(file) != "schema-1.sql")
                .Order(StringComparer.Ordinal);
            await using var connection = await database.DataSource.OpenConnectionAsync(ct);
            await using (var tx = await connection.BeginTransactionAsync(ct))
            {
                foreach (var file in supplements.Prepend(Path.Combine(schema, "schema-1.sql")))
                {
                    var sql = await File.ReadAllTextAsync(file, ct);
                    await using var command = new NpgsqlCommand(sql, connection, tx);
                    await command.ExecuteNonQueryAsync(ct);
                }

                await using var marker = new NpgsqlCommand("INSERT INTO public.v2_schema VALUES (true, $1)", connection, tx);
                marker.Parameters.AddWithValue(CurrentSchema.Version);
                await marker.ExecuteNonQueryAsync(ct);
                await tx.CommitAsync(ct);
            }
            await CurrentSchema.VerifyAsync(connection, ct);
            return database;
        }
        catch (Exception error)
        {
            try { await database.DisposeAsync(); }
            catch (Exception cleanup) { throw new AggregateException(error, cleanup); }
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        await DataSource.DisposeAsync();
        // Separate server instances created by tests may own their own pool. Drop only our generated database.
        await using var maintenance = new NpgsqlConnection(_maintenanceConnectionString);
        await maintenance.OpenAsync();
        await using var drop = new NpgsqlCommand($"DROP DATABASE {_database} WITH (FORCE)", maintenance);
        await drop.ExecuteNonQueryAsync();
    }

    private static string SchemaDirectory()
    {
        for (DirectoryInfo? path = new(AppContext.BaseDirectory); path is not null; path = path.Parent)
        {
            var schema = Path.Combine(path.FullName, "src", "Migrate");
            if (File.Exists(Path.Combine(schema, "schema-1.sql"))) return schema;
        }
        throw new DirectoryNotFoundException("Could not locate the checked-in PostgreSQL schema.");
    }
}

internal sealed class PostgresFactAttribute : FactAttribute
{
    public PostgresFactAttribute()
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)))
            Skip = $"Set {ScratchDatabase.Variable} to a PostgreSQL server with permission to create a disposable test database.";
    }
}
