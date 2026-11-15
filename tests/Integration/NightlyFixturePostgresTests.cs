using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Operations;
using FsusBlogV2.Storage;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;
using Xunit.Abstractions;

namespace FsusBlog.V2.Integration.Tests;

public sealed class NightlyFixturePostgresTests(ITestOutputHelper output)
{
    private const int BatchSize = 64;
    private const string Header = "id\tkind\tcategory\ttag\ttitle\tbody\treplacement_title\treplacement_body";
    private static readonly Guid Owner = Guid.Parse("72654af7-cd13-4fe0-8bce-9a0c0266d908");
    private static readonly TimeSpan WriterBudget = TimeSpan.FromMinutes(90);

    [NightlyFixtureFact]
    public async Task WritePlannedArticles()
    {
        var count = int.Parse(Required("COUNT"), NumberStyles.None, CultureInfo.InvariantCulture);
        if (count is not (20 or 100_000))
            throw new InvalidOperationException("Expected the 20-article pilot or the 100,000-article plan.");
        var due = long.Parse(Required("DUE_UNIX_MS"), NumberStyles.None, CultureInfo.InvariantCulture);
        var dueAt = DateTimeOffset.FromUnixTimeMilliseconds(due);
        var site = Guid.ParseExact(Required("SITE"), "D");
        if (site == Guid.Empty) throw new InvalidOperationException("Expected a fresh fixture recovery-site UUID.");
        var dataDirectory = PrivateDirectory(Required("DATA_DIR"));
        var planPath = Required("ARTICLES");
        if (!Path.IsPathFullyQualified(planPath)) throw new InvalidOperationException("Expected an absolute fixture plan path.");
        await using var stream = new FileStream(planPath, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        if (stream.Length is <= 0 or > 512L * 1024 * 1024)
            throw new InvalidOperationException("Fixture plan exceeds the file budget.");

        var settings = ReadConnectionSettings();
        using var timeout = new CancellationTokenSource(WriterBudget);
        var ct = timeout.Token;
        var plan = new PlanReader(stream);
        if (await plan.Read(ct) != Header) throw new InvalidOperationException("Unexpected article plan header.");

        await using var db = new NpgsqlConnection(settings.ConnectionString);
        await db.OpenAsync(ct);
        await using (var probe = Store.Sql(db, null, """
            select current_database()::text=$1 and inet_server_addr() is null and current_setting('listen_addresses')=''
                   and current_setting('data_directory')=$2 and not pg_is_in_recovery(),clock_timestamp()
            """, settings.Database!, dataDirectory))
        await using (var row = await probe.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct) || !row.GetBoolean(0))
                throw new InvalidOperationException("Fixture target does not match the private PostgreSQL cluster.");
            var untilDue = dueAt - row.GetFieldValue<DateTimeOffset>(1) - TimeSpan.FromSeconds(15);
            if (untilDue <= TimeSpan.Zero) throw new InvalidOperationException("Fixture schedule must stay in the future.");
            if (untilDue < WriterBudget) timeout.CancelAfter(untilDue);
        }

        await using var lease = new InstanceLease(settings.ConnectionString);
        await lease.Start(NullLogger.Instance, ct);
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct, lease.Stopped);
        ct = stop.Token;
        var actor = new Identity(Owner, "Nightly fixture author", 1, true, dueAt);
        var elapsed = Stopwatch.StartNew();
        int batches = 0;
        for (int first = 1; first <= count; first += BatchSize)
        {
            int last = Math.Min(first + BatchSize - 1, count);
            var rows = new List<PlannedArticle>(last - first + 1);
            for (int id = first; id <= last; id++)
                rows.Add(Parse(await plan.Read(ct), id, count));
            if (last == count && await plan.Read(ct) is not null)
                throw new InvalidOperationException("Unexpected rows after the declared article plan.");

            await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
            if (first == 1) await Prepare(db, tx, site, actor, ct);
            foreach (var article in rows) await Write(db, tx, actor, article, due, ct);
            await InstanceLease.CommitProtected(tx, lease, ct);
            batches++;
        }
        output.WriteLine("Committed {0} article plans in {1} PostgreSQL transactions in {2}.", count, batches, elapsed.Elapsed);
    }

    private static NpgsqlConnectionStringBuilder ReadConnectionSettings()
    {
        var settings = new NpgsqlConnectionStringBuilder(Required("DB"))
        {
            Pooling = false, Enlist = false, Multiplexing = false, Timeout = 5, CommandTimeout = 30, IncludeErrorDetail = false
        };
        if (settings.Database is not { } database ||
            !Regex.IsMatch(database, "^fsusv2_nightly_[0-9a-f]{32}$", RegexOptions.CultureInvariant) ||
            settings.Host is not { } host || host.Contains(',') || string.IsNullOrEmpty(settings.Username))
            throw new InvalidOperationException("Expected the named nightly database through its private Unix socket.");
        settings.Host = PrivateDirectory(host);
        return settings;
    }

    private static string PrivateDirectory(string path)
    {
        if (OperatingSystem.IsWindows() || !Path.IsPathFullyQualified(path) || !Directory.Exists(path))
            throw new InvalidOperationException("Expected an existing private Unix fixture directory.");
        const UnixFileMode others = UnixFileMode.GroupRead | UnixFileMode.GroupWrite | UnixFileMode.GroupExecute |
            UnixFileMode.OtherRead | UnixFileMode.OtherWrite | UnixFileMode.OtherExecute;
        if ((File.GetUnixFileMode(path) & others) != 0)
            throw new InvalidOperationException("Fixture directory must be private to the owner.");
        return Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
    }

    private static string Required(string suffix) =>
        Environment.GetEnvironmentVariable($"FSUSBLOG_NIGHTLY_FIXTURE_{suffix}") is { Length: > 0 } value
            ? value : throw new InvalidOperationException($"Missing FSUSBLOG_NIGHTLY_FIXTURE_{suffix}.");

    private static async Task Prepare(NpgsqlConnection db, NpgsqlTransaction tx, Guid site, Identity actor, CancellationToken ct)
    {
        if (await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct) != site ||
            !await CurrentSchema.HasPublicationCanonicalAsync(db, tx, ct))
            throw new InvalidOperationException("Fixture target does not match the attested site and publication schema.");
        await using var empty = Store.Sql(db, tx, """
            select not exists (select from public.article) and not exists (select from public.blog_user)
               and not exists (select from public.comment) and not exists (select from public.blog_outbox)
               and (select last_value=1 and not is_called from public.article_id_seq)
               and (select last_value=1 and not is_called from public.article_publication_publication_id_seq)
               and (select count(*)=32 and bool_and(id between 1 and 32 and name='Nightly category ' || lpad(id::text,2,'0'))
                    from public.category)
               and (select count(*)=128 and bool_and(id between 1 and 128 and name='Nightly tag ' || lpad(id::text,3,'0'))
                    from public.tag)
            """);
        if (await empty.ExecuteScalarAsync(ct) is not true)
            throw new InvalidOperationException("Fixture target has existing business rows, incompatible taxonomy, or allocated IDs.");
        await using var user = Store.Sql(db, tx, """
            insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,true,true,$3)
            """, actor.Id, actor.Name, actor.Generation);
        await user.ExecuteNonQueryAsync(ct);
    }

    private static async Task Write(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, PlannedArticle article,
        long due, CancellationToken ct)
    {
        var id = article.Id;
        await Mutate(ArticleAction.Save, 0, 0, 1, article.Title, article.Body);
        var taxonomy = await Store.AssignTaxonomy(db, tx, actor, new(id, 1, Command(id, 2), article.Category, [article.Tag]), ct);
        Assert.Equal((id, 2L, article.Category, article.Tag),
            (taxonomy.Id, taxonomy.Revision, taxonomy.CategoryId, Assert.Single(taxonomy.TagIds)));
        if (article.Kind == "scheduled")
        {
            await Schedule(2, 3, 0);
            return;
        }

        var published = await Mutate(ArticleAction.Publish, id, 2, 3);
        Assert.Equal<long?>(3, published.PublishedRevision);
        switch (article.Kind)
        {
            case "scheduled-update":
                var privateDraft = await Mutate(ArticleAction.Save, id, 3, 4, article.ReplacementTitle, article.ReplacementBody);
                Assert.Equal<long?>(3, privateDraft.PublishedRevision);
                await Schedule(4, 5, 3);
                break;
            case "retracted":
            case "deleted":
                var deleted = article.Kind == "deleted";
                var hidden = await Mutate(deleted ? ArticleAction.Delete : ArticleAction.Retract, id, 3, 4);
                Assert.Null(hidden.PublishedRevision);
                Assert.Equal(deleted, hidden.Deleted);
                break;
        }

        async Task<ArticleState> Mutate(ArticleAction action, int requestedId, long revision, byte step, string title = "", string body = "")
        {
            var edit = Publishing.Validate(action, new(requestedId, revision, Command(id, step), title, body));
            var (state, changed) = await Store.Execute(db, tx, actor, action, edit, ct);
            Assert.True(changed);
            Assert.Equal((id, revision + 1), (state.Id, state.Revision));
            return state;
        }

        async Task Schedule(long revision, byte step, long expectedPublic)
        {
            var pending = await Store.Schedule(db, tx, actor, new(id, revision, Command(id, step), due), ct);
            Assert.Equal((id, revision + 1, expectedPublic, due),
                (pending.Id, pending.Revision, pending.PublishedRevision, pending.DueUnixMs));
        }
    }

    private static Guid Command(int article, byte step) => new(article, 0x3f55, 0x4000, 0x80, 0, 0, 0, 0, 0, 0, step);

    private static PlannedArticle Parse(string? line, int id, int count)
    {
        var fields = line?.Split('\t');
        if (fields is not { Length: 8 } || !int.TryParse(fields[0], NumberStyles.None, CultureInfo.InvariantCulture, out var key) || key != id ||
            !int.TryParse(fields[2], NumberStyles.None, CultureInfo.InvariantCulture, out var category) || category is < 1 or > 32 ||
            !int.TryParse(fields[3], NumberStyles.None, CultureInfo.InvariantCulture, out var tag) || tag is < 1 or > 128)
            throw new InvalidOperationException($"Malformed nightly article plan row for article {id}.");
        var band = count / 20;
        string kind = ((id - 1) / band) switch
        {
            < 16 => "published",
            16 => "scheduled",
            17 => "scheduled-update",
            18 => "retracted",
            19 => "deleted",
            _ => throw new InvalidOperationException("Unexpected article plan ordinal.")
        };
        if (fields[1] != kind || string.IsNullOrWhiteSpace(fields[4]) || string.IsNullOrWhiteSpace(fields[5]) ||
            (kind == "scheduled-update" ? string.IsNullOrWhiteSpace(fields[6]) || string.IsNullOrWhiteSpace(fields[7]) ||
                (fields[4], fields[5]) == (fields[6], fields[7]) : fields[6].Length != 0 || fields[7].Length != 0))
            throw new InvalidOperationException($"Unexpected lifecycle or content fields for article {id}.");
        return new(id, kind, category, tag, fields[4], fields[5], fields[6], fields[7]);
    }

    private sealed record PlannedArticle(int Id, string Kind, int Category, int Tag, string Title, string Body,
        string ReplacementTitle, string ReplacementBody);

    private sealed class PlanReader(FileStream stream)
    {
        private static readonly UTF8Encoding Utf8 = new(false, true);
        private readonly byte[] _buffer = new byte[64 * 1024];
        private readonly byte[] _line = new byte[64 * 1024];
        private int _start;
        private int _end;

        internal async ValueTask<string?> Read(CancellationToken ct)
        {
            int length = 0;
            while (true)
            {
                if (_start == _end)
                {
                    _end = await stream.ReadAsync(_buffer, ct);
                    _start = 0;
                    if (_end == 0)
                        return length == 0 ? null : throw new InvalidOperationException("Fixture plan is missing its final LF.");
                }
                int newline = Array.IndexOf(_buffer, (byte)'\n', _start, _end - _start);
                int next = newline < 0 ? _end : newline;
                int size = next - _start;
                if (length + size > _line.Length)
                    throw new InvalidOperationException("Fixture plan record exceeds 64 KiB.");
                Array.Copy(_buffer, _start, _line, length, size);
                length += size;
                _start = newline < 0 ? _end : next + 1;
                if (newline < 0) continue;
                if (Array.IndexOf(_line, (byte)'\r', 0, length) >= 0 || Array.IndexOf(_line, (byte)0, 0, length) >= 0)
                    throw new InvalidOperationException("Fixture plan records must use LF and contain no NUL.");
                return Utf8.GetString(_line, 0, length);
            }
        }
    }
}

internal sealed class NightlyFixtureFactAttribute : FactAttribute
{
    public NightlyFixtureFactAttribute()
    {
        if (Environment.GetEnvironmentVariable("FSUSBLOG_NIGHTLY_FIXTURE") != "1")
            Skip = "The standalone nightly fixture runner must opt in with its disposable database.";
    }
}
