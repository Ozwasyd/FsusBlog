namespace FsusBlog.V2.Integration.Tests;

internal sealed class ScratchDatabase : IAsyncDisposable
{
    internal const string Variable = "FSUSBLOG_TEST_DB";

    private readonly string _database;
    private readonly string _maintenanceConnectionString;
    private CancellationTokenSource? _deadline;
    private CancellationToken _defaultToken;
    internal string ConnectionString { get; }
    internal NpgsqlDataSource DataSource { get; }
    private CancellationToken DefaultToken => _deadline?.Token ?? _defaultToken;

    internal Task<int> Exec(string sql, params object[] args) => ExecAsync(DefaultToken, sql, args);
    internal Task<int> ExecAsync(CancellationToken ct, string sql, params object[] args) =>
        WithConnection(db => FixtureSql.ExecuteAsync(db, null, ct, sql, args), ct);

    internal Task<object?> Scalar(string sql, params object[] args) => ScalarAsync(DefaultToken, sql, args);
    internal Task<object?> ScalarAsync(CancellationToken ct, string sql, params object[] args) =>
        WithConnection(db => FixtureSql.ScalarAsync(db, null, ct, sql, args), ct);

    internal async Task<T> Scalar<T>(string sql, params object[] args) => (T)(await Scalar(sql, args))!;
    internal async Task<T> ScalarAsync<T>(CancellationToken ct, string sql, params object[] args) =>
        (T)(await ScalarAsync(ct, sql, args))!;

    internal async Task WithConnection(Func<NpgsqlConnection, Task> action, CancellationToken? ct = null)
    {
        await using var db = await DataSource.OpenConnectionAsync(ct ?? DefaultToken);
        await action(db);
    }

    internal async Task<T> WithConnection<T>(Func<NpgsqlConnection, Task<T>> action, CancellationToken? ct = null)
    {
        await using var db = await DataSource.OpenConnectionAsync(ct ?? DefaultToken);
        return await action(db);
    }

    internal Task InTx(Func<NpgsqlConnection, NpgsqlTransaction, Task> action, CancellationToken? ct = null) =>
        InTx(async (db, tx) => { await action(db, tx); return 0; }, ct);

    internal async Task<T> InTx<T>(Func<NpgsqlConnection, NpgsqlTransaction, Task<T>> action, CancellationToken? ct = null)
    {
        var token = ct ?? DefaultToken;
        await using var db = await DataSource.OpenConnectionAsync(token);
        await using var tx = await db.BeginTransactionAsync(token);
        var result = await action(db, tx);
        await tx.CommitAsync(token);
        return result;
    }

    internal Task<T> QueryRow<T>(string sql, Func<NpgsqlDataReader, T> read, params object[] args) =>
        QueryRowAsync(DefaultToken, sql, read, args);

    internal Task<T> QueryRowAsync<T>(CancellationToken ct, string sql, Func<NpgsqlDataReader, T> read, params object[] args) =>
        WithConnection(async db =>
        {
            await using var cmd = Store.Sql(db, null, sql, args);
            await using var row = await cmd.ExecuteReaderAsync(ct);
            Assert.True(await row.ReadAsync(ct));
            return read(row);
        }, ct);

    internal Task<List<T>> QueryRows<T>(string sql, Func<NpgsqlDataReader, T> read, params object[] args) =>
        QueryRowsAsync(DefaultToken, sql, read, args);

    internal Task<List<T>> QueryRowsAsync<T>(CancellationToken ct, string sql, Func<NpgsqlDataReader, T> read, params object[] args) =>
        WithConnection(async db =>
        {
            await using var cmd = Store.Sql(db, null, sql, args);
            await using var rows = await cmd.ExecuteReaderAsync(ct);
            List<T> result = [];
            while (await rows.ReadAsync(ct)) result.Add(read(rows));
            return result;
        }, ct);

    internal Task<(Guid Id, string Token, byte[] Digest)> AdminAsync(string handle, int minutes = 5,
        byte[]? credential = null, byte[]? key = null, CancellationToken? ct = null, Guid? id = null)
    {
        var token = ct ?? DefaultToken;
        return WithConnection(db => FixtureSql.AdminAsync(db, token, handle, minutes,
            credential ?? RandomNumberGenerator.GetBytes(16), key ?? RandomNumberGenerator.GetBytes(32), id), token);
    }

    internal Task<int> AdminPrincipalAsync(Guid id, string handle, bool enabled = true, long generation = 1, CancellationToken? ct = null)
    {
        var token = ct ?? DefaultToken;
        return WithConnection(db => FixtureSql.AdminPrincipalAsync(db, null, token, id, handle, enabled, generation), token);
    }

    internal Task<int> SiteAccountAsync(Guid id, string name, bool enabled = true, CancellationToken? ct = null)
    {
        var token = ct ?? DefaultToken;
        return WithConnection(db => FixtureSql.SiteAccountAsync(db, null, token, id, name, enabled), token);
    }

    internal async Task<(string Token, byte[] Digest)> SeedStepUpProof(string table, Guid principalId, byte[] sessionDigest,
        int action, byte[] bodyDigest, int lifetimeSeconds = 45, CancellationToken? ct = null)
    {
        var token = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var digest = SHA256.HashData(Encoding.ASCII.GetBytes(token));
        await ExecAsync(ct ?? DefaultToken, $"""
            insert into public.{table}(digest,principal_id,session_digest,generation,action,body_digest,expires_at,kind)
            values($1,$2,$3,1,$4,$5,clock_timestamp()+$6 * interval '1 second',2)
            on conflict (session_digest,kind) do update set digest=excluded.digest,action=excluded.action,body_digest=excluded.body_digest,expires_at=excluded.expires_at
            """, digest, principalId, sessionDigest, action, bodyDigest, lifetimeSeconds);
        return (token, digest);
    }

    internal Task<bool> TerminateAdvisoryOwner(long key, int timeoutMs = 5000, CancellationToken? ct = null) =>
        ScalarAsync<bool>(ct ?? DefaultToken, """
            select pg_catalog.pg_terminate_backend(l.pid, $2) from pg_catalog.pg_locks l
            where l.database=(select oid from pg_catalog.pg_database where datname=current_database())
                and l.locktype='advisory' and l.mode='ExclusiveLock' and l.granted and l.objsubid=1
                and ((l.classid::bigint << 32) | l.objid::bigint)=$1
            """, key, timeoutMs);

    internal Task<(string Token, string Id, byte[] Digest)> SiteSessionAsync(Guid account, DateTimeOffset expiry,
        long generation = 1, byte[]? credential = null, bool mfa = false, CancellationToken? ct = null)
    {
        var token = ct ?? DefaultToken;
        return WithConnection(db => FixtureSql.SiteSessionAsync(db, account, expiry, token, generation, credential, mfa), token);
    }

    internal Task SitePasskeyAsync(Guid account, byte[] credential, byte[] key, CancellationToken? ct = null)
    {
        var token = ct ?? DefaultToken;
        return WithConnection(db => FixtureSql.SitePasskeyAsync(db, null, token, account, credential, key), token);
    }

    internal async Task<(Guid Id, byte[] Credential)> SitePasskeyAccountAsync(string name, byte[]? key = null, CancellationToken? ct = null)
    {
        var id = Guid.NewGuid();
        var credential = RandomNumberGenerator.GetBytes(32);
        await SiteAccountAsync(id, name, ct: ct);
        await SitePasskeyAsync(id, credential, key ?? RandomNumberGenerator.GetBytes(32), ct);
        return (id, credential);
    }

    internal async Task WaitForBlocked(int blockerPid, int count = 1, CancellationToken? ct = null)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct ?? DefaultToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(15));
        while (await ScalarAsync<long>(deadline.Token, """
            with recursive blocked(pid) as (
                select $1
                union
                select activity.pid from blocked join pg_catalog.pg_stat_activity activity
                on activity.datname=current_database() and blocked.pid=any(pg_catalog.pg_blocking_pids(activity.pid))
            )
            select count(*)-1 from blocked
            """, blockerPid) < count)
            await Task.Delay(15, deadline.Token);
    }

    internal Task<(Guid Id, string Token, string Handle)> SignIn(string name, CancellationToken ct,
        bool canAuthor = true, int minutes = 2) =>
        canAuthor ? SignInAdmin(name, ct, minutes: minutes) : SignInSiteUser(name, ct, minutes: minutes);

    internal async Task<(Guid Id, string Token, string Handle)> SignInSiteUser(string name, CancellationToken ct, int minutes = 2)
    {
        var (id, ticket) = await IssueTicket(name, ct, minutes);
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

    internal async Task<(Guid Id, string Ticket)> IssueTicket(string name, CancellationToken ct, int minutes = 2)
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

        var database = new ScratchDatabase(settings.ConnectionString, name) { _defaultToken = ct };
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
