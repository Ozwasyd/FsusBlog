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
    private CancellationTokenSource? _deadline;
    internal string ConnectionString { get; }
    internal NpgsqlDataSource DataSource { get; }

    internal Task<(Guid Id, string Token, string Handle)> SignIn(string name, CancellationToken ct,
        bool canAuthor = true, int minutes = 2) =>
        canAuthor ? SignInAdmin(name, ct, minutes: minutes) : SignInSiteUser(name, ct, minutes: minutes);

    internal async Task<(Guid Id, string Token, string Handle)> SignInSiteUser(string name, CancellationToken ct, int minutes = 2)
    {
        var (id, ticket) = await IssueTicket(name, ct, canAuthor: false, minutes: minutes);
        return await Redeem(id, ticket, ct);
    }

    internal async Task SignOutAdmin(string token, CancellationToken ct)
    {
        if (Store.TokenDigest(token) is not { } digest) return;
        await using var connection = await DataSource.OpenConnectionAsync(ct);
        await FixtureSql.ExecuteAsync(connection, null, ct, "delete from public.admin_session where digest=$1", digest);
    }

    internal async Task<(Guid Id, string Token, string Handle)> SignInAdmin(string name, CancellationToken ct,
        int minutes = 2)
    {
        await using var connection = await DataSource.OpenConnectionAsync(ct);
        var id = Guid.NewGuid();
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var digest = Store.TokenDigest(token)!;
        var handle = AdminHandle(name, id);
        await using var tx = await connection.BeginTransactionAsync(ct);
        await FixtureSql.ExecuteAsync(connection, tx, ct, FixtureSql.AdminSessionSql, FixtureSql.AdminSessionArguments(
            id, handle, RandomNumberGenerator.GetBytes(32), RandomNumberGenerator.GetBytes(8), [1], digest, minutes));
        await tx.CommitAsync(ct);
        return (id, token, SiteSessions.Id(id, digest));
    }

    internal async Task<(Guid Id, string Token, string Handle)> SignIn(Guid id, CancellationToken ct, int minutes = 2)
    {
        await using var connection = await DataSource.OpenConnectionAsync(ct);
        if (await FixtureSql.ScalarAsync(connection, null, ct,
                "select generation from public.admin_principal where id=$1 and enabled", id) is long generation)
        {
            var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
            var digest = Store.TokenDigest(token)!;
            await FixtureSql.ExecuteAsync(connection, null, ct, """
                insert into public.admin_session(digest,principal_id,generation,expires_at)
                values($1,$2,$3,clock_timestamp()+$4*interval '1 minute')
                on conflict (principal_id) do update
                    set digest=excluded.digest,generation=excluded.generation,expires_at=excluded.expires_at
                """, digest, id, generation, minutes);
            return (id, token, SiteSessions.Id(id, digest));
        }
        return await Redeem(id, await IssueTicket(id, ct, minutes), ct);
    }

    internal static string AdminHandle(string name, Guid id)
    {
        var normalized = new string(name.ToLowerInvariant().Select(c => char.IsAsciiLetterOrDigit(c) ? c : '-').ToArray()).Trim('-');
        if (normalized.Length == 0 || !char.IsAsciiLetter(normalized[0])) normalized = "a-" + normalized;
        var suffix = "-" + id.ToString("N")[..8];
        var maxPrefix = 64 - suffix.Length;
        return (normalized.Length > maxPrefix ? normalized[..maxPrefix] : normalized) + suffix;
    }

    internal async Task<(Guid Id, string Ticket)> IssueTicket(string name, CancellationToken ct, bool canAuthor = true, int minutes = 2)
    {
        var id = Guid.NewGuid();
        await using var connection = await DataSource.OpenConnectionAsync(ct);
        var secret = RandomNumberGenerator.GetBytes(32);
        await FixtureSql.ExecuteAsync(connection, null, ct, """
            with account as (
                insert into public.blog_user(id,name,enabled,generation)
                values($1,$2,true,1) returning id
            )
            insert into public.login_ticket(digest,user_id,expires_at)
            select $3,id,now()+make_interval(mins => $4) from account
            """, id, name, SHA256.HashData(secret), minutes);
        return (id, Convert.ToHexStringLower(secret));
    }

    internal async Task<string> IssueTicket(Guid id, CancellationToken ct, int minutes = 2)
    {
        await using var connection = await DataSource.OpenConnectionAsync(ct);
        return await FixtureSql.IssueLoginTicketAsync(connection, null, ct, id, minutes);
    }

    private async Task<(Guid Id, string Token, string Handle)> Redeem(Guid id, string ticket, CancellationToken ct)
    {
        var token = (await new Store(DataSource).SignIn(ticket, ct)).Token;
        return (id, token, SiteSessions.Id(id, Store.TokenDigest(token)!));
    }

    private ScratchDatabase(string maintenanceConnectionString, string database)
    {
        _database = database;
        _maintenanceConnectionString = maintenanceConnectionString;
        ConnectionString = new NpgsqlConnectionStringBuilder(maintenanceConnectionString) { Database = database }.ConnectionString;
        DataSource = NpgsqlDataSource.Create(ConnectionString);
    }

    internal static Task<ScratchDatabase> CreateTimed(out CancellationToken ct, TimeSpan? timeout = null)
    {
        var deadline = new CancellationTokenSource(timeout ?? TimeSpan.FromMinutes(2));
        ct = deadline.Token;
        return CreateWithDeadline(deadline);
    }

    private static async Task<ScratchDatabase> CreateWithDeadline(CancellationTokenSource deadline)
    {
        try
        {
            var fixture = await Create(Environment.GetEnvironmentVariable(Variable)!, deadline.Token);
            fixture._deadline = deadline;
            return fixture;
        }
        catch
        {
            deadline.Dispose();
            throw;
        }
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
            var files = Directory.EnumerateFiles(schema, "*.sql").Order(StringComparer.Ordinal);
            await using var connection = await database.DataSource.OpenConnectionAsync(ct);
            await using (var tx = await connection.BeginTransactionAsync(ct))
            {
                foreach (var file in files)
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
        try
        {
            await DataSource.DisposeAsync();
            // Separate server instances created by tests may own their own pool. Drop only our generated database.
            await using var maintenance = new NpgsqlConnection(_maintenanceConnectionString);
            await maintenance.OpenAsync();
            await using var drop = new NpgsqlCommand($"DROP DATABASE {_database} WITH (FORCE)", maintenance);
            await drop.ExecuteNonQueryAsync();
        }
        finally { _deadline?.Dispose(); }
    }

    private static string SchemaDirectory()
    {
        for (DirectoryInfo? path = new(AppContext.BaseDirectory); path is not null; path = path.Parent)
        {
            var schema = Path.Combine(path.FullName, "src", "Cli", "Schema");
            if (File.Exists(Path.Combine(schema, "01-core.sql"))) return schema;
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
