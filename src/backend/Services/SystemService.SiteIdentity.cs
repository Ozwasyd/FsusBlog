using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;

namespace FsusBlog.Server.Services;

public partial class SystemService : ISystemSiteIdentityReader
{
    private const string SiteIdentityPrefix = "SiteIdentity_";
    private const string InstallationPrefix = SiteIdentityPrefix + "Installation_";
    private const string ScopePrefix = SiteIdentityPrefix + "Scope_";
    private const int MaxGenerations = 16;
    private const int MaxScopeEvents = 1024;
    private const int MaxIdentityRows = MaxGenerations * (MaxScopeEvents + 1);

    /// <inheritdoc />
    public async Task<SystemSiteIdentityReadModel> ReadCurrentSiteIdentityAsync(CancellationToken cancellationToken = default)
    {
        DbConnection connection = SiteIdentityConnection();
        bool opened = connection.State != ConnectionState.Open;
        try
        {
            if (opened)
            {
                await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
            }
            IdentityJournal journal = await LoadIdentityJournalAsync(connection, cancellationToken).ConfigureAwait(false);
            if (journal.State == SystemSiteIdentityState.Absent
                && await HasInstallationDataAsync(connection, false, cancellationToken).ConfigureAwait(false))
            {
                return IdentityRefusal(SystemSiteIdentityState.MigrationRequired);
            }
            return journal.ReadModel;
        }
        finally
        {
            if (opened)
            {
                await connection.CloseAsync().ConfigureAwait(false);
            }
        }
    }

    /// <summary>Trusted provisioning only: requires an empty public schema and a caller-owned READ COMMITTED transaction.</summary>
    public Task<SystemSiteIdentityReadModel> InitializeSiteIdentityAsync(
        Guid intent, string scope, CancellationToken cancellationToken = default)
        => CreateInstallationIdentityAsync(intent, scope, "Fresh", 0, 0, cancellationToken);

    /// <summary>Trusted migration only: binds the explicitly reviewed legacy scope without rewriting old facts.</summary>
    public Task<SystemSiteIdentityReadModel> MigrateLegacySiteIdentityAsync(
        Guid intent, string reviewedLegacyScope, CancellationToken cancellationToken = default)
        => CreateInstallationIdentityAsync(intent, reviewedLegacyScope, "Legacy", 0, 0, cancellationToken);

    /// <summary>Trusted independent clone: appends a new identity and leaves all predecessor facts foreign.</summary>
    public Task<SystemSiteIdentityReadModel> CloneSiteIdentityAsync(
        Guid intent, int expectedGeneration, int expectedRevision, string independentScope,
        SystemSiteIdentityCloneDisposition disposition, CancellationToken cancellationToken = default)
    {
        if (disposition != SystemSiteIdentityCloneDisposition.RetainAsForeign)
        {
            throw new ArgumentException("An explicit retained-foreign disposition is required.", nameof(disposition));
        }
        return CreateInstallationIdentityAsync(intent, independentScope, "Clone", expectedGeneration, expectedRevision, cancellationToken);
    }

    /// <summary>Appends a reviewed URL mapping; rejects drift, collisions and removal of the last scope.</summary>
    public Task<SystemSiteIdentityReadModel> ChangeSiteIdentityScopeAsync(
        Guid intent, int expectedGeneration, int expectedRevision, string scope, bool add,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentityInput(intent, scope);
        string action = add ? "Add" : "Remove";
        string digest = IdentityDigest(action, intent, expectedGeneration, expectedRevision, scope);
        return MutateIdentityAsync(async (connection, journal) =>
        {
            if (TryIdentityReplay(journal, intent, digest, out SystemSiteIdentityReadModel? replay))
            {
                return replay!;
            }
            RequireCurrentIdentity(journal, expectedGeneration, expectedRevision);
            Dictionary<string, int> active = journal.ActiveScopes;
            if (add ? active.ContainsKey(scope) || journal.ForeignScopes.Contains(scope) : !active.ContainsKey(scope) || active.Count == 1)
            {
                throw new InvalidOperationException("site_identity_mapping_transition_refused");
            }
            int revision = journal.Revision + 1;
            if (revision > MaxScopeEvents)
            {
                throw new InvalidOperationException("site_identity_history_capacity_exhausted");
            }
            await InsertIdentityRowAsync(connection, ScopeKey(journal.Generation, revision),
                $"1|{intent:N}|{digest}|{action}|{scope}", cancellationToken).ConfigureAwait(false);
            return (await LoadIdentityJournalAsync(connection, cancellationToken).ConfigureAwait(false)).ReadModel;
        }, cancellationToken);
    }

    private Task<SystemSiteIdentityReadModel> CreateInstallationIdentityAsync(
        Guid intent, string scope, string kind, int expectedGeneration, int expectedRevision,
        CancellationToken cancellationToken)
    {
        ValidateIdentityInput(intent, scope);
        string digest = IdentityDigest(kind, intent, expectedGeneration, expectedRevision, scope);
        return MutateIdentityAsync(async (connection, journal) =>
        {
            if (TryIdentityReplay(journal, intent, digest, out SystemSiteIdentityReadModel? replay))
            {
                return replay!;
            }
            if (kind == "Clone")
            {
                RequireCurrentIdentity(journal, expectedGeneration, expectedRevision);
                if (journal.AllScopes.Contains(scope))
                {
                    throw new InvalidOperationException("site_identity_clone_old_scope_refused");
                }
            }
            else
            {
                if (journal.State != SystemSiteIdentityState.Absent)
                {
                    throw new InvalidOperationException("site_identity_already_present_or_invalid");
                }
                bool nonempty = await HasInstallationDataAsync(connection, true, cancellationToken).ConfigureAwait(false);
                if (nonempty != (kind == "Legacy"))
                {
                    throw new InvalidOperationException("site_identity_initialization_kind_mismatch");
                }
            }
            int generation = journal.Generation + 1;
            if (generation > MaxGenerations)
            {
                throw new InvalidOperationException("site_identity_history_capacity_exhausted");
            }
            string identity = "fsus-site:" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
            string predecessor = kind == "Clone" ? journal.Identity! : "-";
            string disposition = kind == "Clone" ? "RetainAsForeign" : "-";
            await InsertIdentityRowAsync(connection, InstallationKey(generation),
                $"1|{identity}|{intent:N}|{digest}|{kind}|{predecessor}|{disposition}", cancellationToken).ConfigureAwait(false);
            await InsertIdentityRowAsync(connection, ScopeKey(generation, 1),
                $"1|{intent:N}|{digest}|Add|{scope}", cancellationToken).ConfigureAwait(false);
            return (await LoadIdentityJournalAsync(connection, cancellationToken).ConfigureAwait(false)).ReadModel;
        }, cancellationToken);
    }

    private async Task<SystemSiteIdentityReadModel> MutateIdentityAsync(
        Func<DbConnection, IdentityJournal, Task<SystemSiteIdentityReadModel>> mutation,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DbConnection connection = SiteIdentityConnection();
        DbTransaction transaction = SiteIdentityTransaction()
            ?? throw new InvalidOperationException("site_identity_caller_transaction_required");
        if (transaction.IsolationLevel != IsolationLevel.ReadCommitted || connection.State != ConnectionState.Open)
        {
            throw new InvalidOperationException("site_identity_open_read_committed_transaction_required");
        }
        string savepoint = "site_identity_" + Guid.NewGuid().ToString("N");
        await ExecuteIdentitySqlAsync(connection, "SAVEPOINT " + savepoint, cancellationToken).ConfigureAwait(false);
        try
        {
            await ExecuteIdentitySqlAsync(connection,
                "LOCK TABLE public.sys_systemconfig IN SHARE ROW EXCLUSIVE MODE", cancellationToken).ConfigureAwait(false);
            IdentityJournal journal = await LoadIdentityJournalAsync(connection, cancellationToken).ConfigureAwait(false);
            SystemSiteIdentityReadModel result = await mutation(connection, journal).ConfigureAwait(false);
            if (result.State != SystemSiteIdentityState.Current)
            {
                throw new InvalidOperationException("site_identity_write_readback_refused");
            }
            cancellationToken.ThrowIfCancellationRequested();
            await ExecuteIdentitySqlAsync(connection, "RELEASE SAVEPOINT " + savepoint, cancellationToken).ConfigureAwait(false);
            return result;
        }
        catch
        {
            using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await ExecuteIdentitySqlAsync(connection, "ROLLBACK TO SAVEPOINT " + savepoint, cleanup.Token).ConfigureAwait(false);
            await ExecuteIdentitySqlAsync(connection, "RELEASE SAVEPOINT " + savepoint, cleanup.Token).ConfigureAwait(false);
            throw;
        }
    }

    private DbConnection SiteIdentityConnection()
        => _db.Ado.Connection as DbConnection
            ?? throw new InvalidOperationException("site_identity_native_connection_required");

    private DbTransaction? SiteIdentityTransaction()
    {
        if (_db.Ado.Transaction is null)
        {
            return null;
        }
        return _db.Ado.Transaction as DbTransaction
            ?? throw new InvalidOperationException("site_identity_native_transaction_required");
    }

    private DbCommand IdentityCommand(DbConnection connection, string sql)
    {
        DbCommand command = connection.CreateCommand();
        command.CommandText = sql;
        command.CommandTimeout = _db.Ado.CommandTimeOut;
        command.Transaction = SiteIdentityTransaction();
        return command;
    }

    private async Task ExecuteIdentitySqlAsync(DbConnection connection, string sql, CancellationToken cancellationToken)
    {
        await using DbCommand command = IdentityCommand(connection, sql);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task InsertIdentityRowAsync(DbConnection connection, string key, string value, CancellationToken cancellationToken)
    {
        if (key.Length > 64 || value.Length > 512)
        {
            throw new InvalidOperationException("site_identity_record_bounds_exceeded");
        }
        await using DbCommand command = IdentityCommand(connection,
            "INSERT INTO public.sys_systemconfig (key, value) VALUES (@key, @value)");
        foreach ((string name, string text) in new[] { ("key", key), ("value", value) })
        {
            DbParameter parameter = command.CreateParameter();
            parameter.ParameterName = name;
            parameter.Value = text;
            command.Parameters.Add(parameter);
        }
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task<IdentityJournal> LoadIdentityJournalAsync(DbConnection connection, CancellationToken cancellationToken)
    {
        await using DbCommand command = IdentityCommand(connection,
            $"SELECT key, value FROM public.sys_systemconfig WHERE left(key, 13) = 'SiteIdentity_' ORDER BY key LIMIT {MaxIdentityRows + 1}");
        var rows = new Dictionary<string, string>(StringComparer.Ordinal);
        await using DbDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            if (reader.IsDBNull(0) || reader.IsDBNull(1) || !rows.TryAdd(reader.GetString(0), reader.GetString(1)))
            {
                return new IdentityJournal(SystemSiteIdentityState.Ambiguous);
            }
        }
        return ParseIdentityJournal(rows);
    }

    private async Task<bool> HasInstallationDataAsync(DbConnection connection, bool guardWrites, CancellationToken cancellationToken)
    {
        var tables = new List<string>();
        await using (DbCommand command = IdentityCommand(connection,
            "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename"))
        await using (DbDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                tables.Add("public.\"" + reader.GetString(0).Replace("\"", "\"\"", StringComparison.Ordinal) + "\"");
            }
        }
        if (guardWrites && tables.Count > 0)
        {
            await ExecuteIdentitySqlAsync(connection, "LOCK TABLE " + string.Join(", ", tables) + " IN SHARE MODE", cancellationToken).ConfigureAwait(false);
        }
        foreach (string table in tables)
        {
            await using DbCommand command = IdentityCommand(connection, "SELECT EXISTS (SELECT 1 FROM " + table + " LIMIT 1)");
            if ((bool)(await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false))!)
            {
                return true;
            }
        }
        return false;
    }

    private static IdentityJournal ParseIdentityJournal(IReadOnlyDictionary<string, string> rows)
    {
        if (rows.Count == 0)
        {
            return new IdentityJournal(SystemSiteIdentityState.Absent);
        }
        if (rows.Count > MaxIdentityRows || rows.Any(row => row.Key.Length > 64 || row.Value.Length > 512))
        {
            return new IdentityJournal(SystemSiteIdentityState.Malformed);
        }
        if (rows.Values.Any(value => value.Split('|')[0] != "1"))
        {
            return new IdentityJournal(SystemSiteIdentityState.UnsupportedVersion);
        }
        var journal = new IdentityJournal(SystemSiteIdentityState.Current);
        int consumed = 0;
        for (int generation = 1; generation <= MaxGenerations; generation++)
        {
            if (!rows.TryGetValue(InstallationKey(generation), out string? installation))
            {
                break;
            }
            string[] fields = installation.Split('|');
            if (fields.Length != 7 || !ValidIdentity(fields[1]) || !ValidIntent(fields[2]) || !ValidDigest(fields[3])
                || (generation == 1
                    ? fields[4] is not ("Fresh" or "Legacy") || fields[5] != "-" || fields[6] != "-"
                    : fields[4] != "Clone" || fields[5] != journal.Identity || fields[6] != "RetainAsForeign")
                || journal.Identities.Contains(fields[1]) || journal.Intents.ContainsKey(fields[2]))
            {
                return new IdentityJournal(SystemSiteIdentityState.Malformed);
            }
            consumed++;
            int predecessorRevision = journal.Revision;
            if (generation > 1)
            {
                journal.ForeignScopes.UnionWith(journal.AllScopes);
            }
            journal.Identities.Add(fields[1]);
            journal.Identity = fields[1];
            journal.Generation = generation;
            journal.Revision = 0;
            journal.ActiveScopes.Clear();
            journal.Intents.Add(fields[2], (fields[3], generation, 1));
            for (int revision = 1; revision <= MaxScopeEvents; revision++)
            {
                if (!rows.TryGetValue(ScopeKey(generation, revision), out string? mapping))
                {
                    break;
                }
                string[] parts = mapping.Split('|');
                if (parts.Length != 5 || !ValidIntent(parts[1]) || !ValidDigest(parts[2]) || !ValidScope(parts[4])
                    || parts[3] is not ("Add" or "Remove")
                    || (revision == 1
                        ? parts[1] != fields[2] || parts[2] != fields[3] || parts[3] != "Add"
                            || generation > 1 && journal.AllScopes.Contains(parts[4])
                        : journal.Intents.ContainsKey(parts[1])))
                {
                    return new IdentityJournal(SystemSiteIdentityState.Malformed);
                }
                string expectedDigest = IdentityDigest(revision == 1 ? fields[4] : parts[3],
                    Guid.ParseExact(parts[1], "N"), revision == 1 ? generation - 1 : generation,
                    revision == 1 ? predecessorRevision : revision - 1, parts[4]);
                if (parts[2] != expectedDigest || parts[3] == "Add" && journal.ForeignScopes.Contains(parts[4]))
                {
                    return new IdentityJournal(SystemSiteIdentityState.Malformed);
                }
                bool changed = parts[3] == "Add"
                    ? journal.ActiveScopes.TryAdd(parts[4], revision)
                    : journal.ActiveScopes.Count > 1 && journal.ActiveScopes.Remove(parts[4]);
                if (!changed)
                {
                    return new IdentityJournal(SystemSiteIdentityState.Malformed);
                }
                journal.AllScopes.Add(parts[4]);
                if (revision > 1)
                {
                    journal.Intents.Add(parts[1], (parts[2], generation, revision));
                }
                consumed++;
                journal.Revision = revision;
            }
            if (journal.Revision == 0)
            {
                return new IdentityJournal(SystemSiteIdentityState.Ambiguous);
            }
        }
        return consumed != rows.Count || journal.Generation == 0
            ? new IdentityJournal(SystemSiteIdentityState.Ambiguous)
            : journal;
    }

    private static void RequireCurrentIdentity(IdentityJournal journal, int generation, int revision)
    {
        if (journal.State != SystemSiteIdentityState.Current || journal.Generation != generation || journal.Revision != revision)
        {
            throw new InvalidOperationException("site_identity_binding_drift_or_refusal");
        }
    }

    private static bool TryIdentityReplay(IdentityJournal journal, Guid intent, string digest, out SystemSiteIdentityReadModel? replay)
    {
        replay = null;
        if (!journal.Intents.TryGetValue(intent.ToString("N"), out var original))
        {
            return false;
        }
        if (journal.State != SystemSiteIdentityState.Current || original.Digest != digest
            || original.Generation != journal.Generation || original.Revision != journal.Revision)
        {
            throw new InvalidOperationException("site_identity_intent_conflict_or_superseded");
        }
        replay = journal.ReadModel;
        return true;
    }

    private static void ValidateIdentityInput(Guid intent, string scope)
    {
        if (intent == Guid.Empty || !ValidScope(scope))
        {
            throw new ArgumentException("A nonempty intent and exact bounded HTTP(S) scope are required.");
        }
    }

    private static bool ValidScope(string? scope)
        => scope is { Length: > 0 and <= 256 }
            && scope.All(character => character is > ' ' and < '\u007f' && character is not ('|' or '\\' or '?' or '#'))
            && Uri.TryCreate(scope, UriKind.Absolute, out Uri? uri)
            && uri.Scheme is "http" or "https" && uri.Host.Length > 0 && uri.UserInfo.Length == 0;

    private static bool ValidIdentity(string identity)
        => identity.Length == 74 && identity.StartsWith("fsus-site:", StringComparison.Ordinal)
            && identity.AsSpan(10).IndexOfAnyExcept("0123456789abcdef") < 0;

    private static bool ValidIntent(string intent)
        => Guid.TryParseExact(intent, "N", out Guid parsed) && parsed != Guid.Empty && parsed.ToString("N") == intent;

    private static bool ValidDigest(string digest)
        => digest.Length == 64 && digest.AsSpan().IndexOfAnyExcept("0123456789abcdef") < 0;

    private static string IdentityDigest(string action, Guid intent, int generation, int revision, string scope)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            FormattableString.Invariant($"1|{action}|{intent:N}|{generation}|{revision}|{scope}"))));

    private static string InstallationKey(int generation)
        => InstallationPrefix + generation.ToString("D10", CultureInfo.InvariantCulture);

    private static string ScopeKey(int generation, int revision)
        => ScopePrefix + generation.ToString("D10", CultureInfo.InvariantCulture) + "_" + revision.ToString("D10", CultureInfo.InvariantCulture);

    private static SystemSiteIdentityReadModel IdentityRefusal(SystemSiteIdentityState state)
        => new(state, null, null, null, null, Array.Empty<SystemSiteIdentityScope>());

    private sealed class IdentityJournal(SystemSiteIdentityState state)
    {
        public SystemSiteIdentityState State { get; } = state;
        public string? Identity
        {
            get; set;
        }
        public int Generation
        {
            get; set;
        }
        public int Revision
        {
            get; set;
        }
        public Dictionary<string, int> ActiveScopes { get; } = new(StringComparer.Ordinal);
        public HashSet<string> AllScopes { get; } = new(StringComparer.Ordinal);
        public HashSet<string> ForeignScopes { get; } = new(StringComparer.Ordinal);
        public HashSet<string> Identities { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, (string Digest, int Generation, int Revision)> Intents { get; } = new(StringComparer.Ordinal);
        public SystemSiteIdentityReadModel ReadModel => State != SystemSiteIdentityState.Current
            ? IdentityRefusal(State)
            : new(State, Identity, 1, Generation, Revision,
                Array.AsReadOnly(ActiveScopes.OrderBy(pair => pair.Key, StringComparer.Ordinal)
                    .Select(pair => new SystemSiteIdentityScope(pair.Key, pair.Value)).ToArray()));
    }
}
