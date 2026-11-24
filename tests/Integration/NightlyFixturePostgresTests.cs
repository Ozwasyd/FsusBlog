using System.Text.RegularExpressions;

namespace FsusBlog.V2.Integration.Tests;

public sealed partial class NightlyFixturePostgresTests(ITestOutputHelper output)
{
    private const int BatchSize = 64;
    private const string Header = "id\tkind\tcategory\ttag\ttitle\tbody\treplacement_title\treplacement_body";
    private const string ArchiveReason = "Archive the reviewed nightly source release";
    private static readonly Guid Owner = Guid.Parse("72654af7-cd13-4fe0-8bce-9a0c0266d908");
    private static readonly Guid ArchiveAdministrator = Guid.Parse("cb7c1f2b-fd4e-4cce-9b22-31e36b475c28");
    private static readonly TimeSpan WriterBudget = TimeSpan.FromMinutes(90);

    [NightlyFixtureFact]
    public async Task WritePlannedArticles()
    {
        bool scale = Environment.GetEnvironmentVariable("FSUSBLOG_NIGHTLY_FIXTURE_ARTICLE_SCALE") == "1";
        try
        {
            await WriteArticles(scale);
        }
        catch (NpgsqlException error) when (scale && error.IsTransient)
        {
            output.WriteLine("checkpoint_worker_retry_allowed=transient_connection_failure");
            throw;
        }
    }

    private async Task WriteArticles(bool scale)
    {
        var count = int.Parse(Required("COUNT"), NumberStyles.None, CultureInfo.InvariantCulture);
        if (scale ? count != MillionArticleCount : count is not (20 or 100_000))
            throw new InvalidOperationException("Unexpected article count for the selected owned fixture profile.");
        long deadline = scale
            ? long.Parse(Required("DEADLINE_UNIX_MS"), NumberStyles.None, CultureInfo.InvariantCulture)
            : 0;
        var budget = scale ? DateTimeOffset.FromUnixTimeMilliseconds(deadline) - DateTimeOffset.UtcNow : WriterBudget;
        if (budget <= TimeSpan.Zero || budget > WriterBudget)
            throw new InvalidOperationException("The article writer is outside its original 90-minute deadline.");
        var due = long.Parse(Required("DUE_UNIX_MS"), NumberStyles.None, CultureInfo.InvariantCulture);
        var dueAt = DateTimeOffset.FromUnixTimeMilliseconds(due);
        var site = Guid.ParseExact(Required("SITE"), "D");
        if (site == Guid.Empty) throw new InvalidOperationException("Expected a fresh fixture recovery-site UUID.");
        var dataDirectory = PrivateDirectory(Required("DATA_DIR"));
        var planPath = Required("ARTICLES");
        if (!Path.IsPathFullyQualified(planPath)) throw new InvalidOperationException("Expected an absolute fixture plan path.");
        using var timeout = new CancellationTokenSource(budget);
        var ct = timeout.Token;
        var checkpoint = scale || Environment.GetEnvironmentVariable("FSUSBLOG_NIGHTLY_FIXTURE_CHECKPOINT_PILOT") == "1"
            ? new CheckpointBinding(site, due, Required("CHECKPOINT_PLAN_SHA256"), Required("CHECKPOINT_MANIFEST_SHA256"), count, deadline)
            : null;
        await using Stream stream = checkpoint is null
            ? new FileStream(planPath, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024,
                FileOptions.Asynchronous | FileOptions.SequentialScan)
            : await OpenShardedArticleInputAsync(planPath, count, due, checkpoint.ManifestHash, checkpoint.PlanHash, ct);
        if (stream.Length <= 0 || !scale && stream.Length > 512L * 1024 * 1024)
            throw new InvalidOperationException("Fixture plan exceeds the file budget.");

        var settings = ReadConnectionSettings();
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
            if (scale)
            {
                var remaining = DateTimeOffset.FromUnixTimeMilliseconds(deadline) - DateTimeOffset.UtcNow;
                if (remaining <= TimeSpan.Zero) throw new InvalidOperationException("The article writer deadline elapsed.");
                timeout.CancelAfter(untilDue < remaining ? untilDue : remaining);
            }
            else if (untilDue < WriterBudget) timeout.CancelAfter(untilDue);
        }

        await using var lease = new InstanceLease(settings.ConnectionString);
        await lease.Start(NullLogger.Instance, ct);
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct, lease.Stopped);
        ct = stop.Token;
        var actor = new Identity(Owner, "Nightly fixture author", 1, true, dueAt);
        var elapsed = Stopwatch.StartNew();
        int batches = 0;
        var band = count / 20;
        var archiveStart = 18 * band + 1;
        if (scale)
        {
            await WriteMillionArticleFixture(db, settings, lease, stream, plan.Position, actor, checkpoint!, archiveStart, band, ct);
            return;
        }
        long archiveOffset = 0;
        if (checkpoint is not null)
        {
            (archiveOffset, batches) = await WriteCheckpointPilot(db, settings, lease, stream, count, archiveStart, actor, checkpoint, ct);
        }
        else
        {
            for (int first = 1; first <= count; first += BatchSize)
            {
                int last = Math.Min(first + BatchSize - 1, count);
                var batch = await ReadInitialBatch(plan, first, last, count, archiveStart, archiveOffset, ct);
                archiveOffset = batch.ArchiveOffset;

                await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
                if (first == 1) await Prepare(db, tx, site, actor, ct);
                await WriteInitialBatch(db, tx, actor, batch.Rows, due, ct);
                await InstanceLease.CommitProtected(tx, lease, ct);
                batches++;
            }
        }
        output.WriteLine("Committed {0} article plans in {1} PostgreSQL transactions in {2}.", count, batches, elapsed.Elapsed);

        elapsed.Restart();
        stream.Seek(archiveOffset, SeekOrigin.Begin);
        var archivePlan = new PlanReader(stream);
        var archiveSettings = new NpgsqlConnectionStringBuilder(settings.ConnectionString) { Pooling = true, MaxPoolSize = 1 };
        await using var archiveSource = NpgsqlDataSource.Create(archiveSettings.ConnectionString);
        var archiveGate = new AdminSessionGate(archiveSource, lease);
        var archiveStore = new AdminArticleArchiveStore(archiveGate, new AdminStepUpService(archiveGate));
        var session = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var sessionDigest = Store.TokenDigest(session)!;
        await StartArchiveSession(db, lease, sessionDigest, ct);
        for (int offset = 0; offset < band; offset++)
        {
            var archived = Parse(await archivePlan.Read(ct), archiveStart + offset, count);
            var intent = ArchiveIntent(archived, count, band, offset);
            int invalidations = 0;
            AdminArticleArchiveReceipt receipt;
            if (checkpoint is null)
            {
                var proof = await PrepareArchive(db, lease, actor, archived, archived.Id - band, intent, sessionDigest, ct);
                receipt = await archiveStore.ExecuteArticleArchive(session, proof, intent, () => invalidations++, ct);
            }
            else
            {
                receipt = await ArchiveWithCheckpoint(db, lease, archiveStore, stream, actor, archived, archived.Id - band,
                    intent, sessionDigest, checkpoint, () => invalidations++, ct);
            }
            RequireArchiveReceipt(archived, intent, receipt);
            Assert.Equal(1, invalidations);
        }

        await RetireArchiveSession(db, lease, ct, checkpoint);
        output.WriteLine("Committed {0} replacements and {0} administrator archives with private release IDs in {1}.", band, elapsed.Elapsed);
    }

    private static AdminArticleArchiveIntent ArchiveIntent(PlannedArticle article, int count, int band, int offset) =>
        new(article.Id, 5, (long)count - band + 2 * offset + 1, 3, Command(article.Id, 6),
            ArchiveReason, Wire.AdminArticleArchiveStatus);

    private static async Task<(List<PlannedArticle> Rows, long ArchiveOffset)> ReadInitialBatch(PlanReader plan, int first,
        int last, int count, int archiveStart, long archiveOffset, CancellationToken ct)
    {
        var rows = new List<PlannedArticle>(last - first + 1);
        for (int id = first; id <= last; id++)
        {
            if (id == archiveStart) archiveOffset = plan.Position;
            rows.Add(Parse(await plan.Read(ct), id, count));
        }
        if (last == count && await plan.Read(ct) is not null)
            throw new InvalidOperationException("Unexpected rows after the declared article plan.");
        return (rows, archiveOffset);
    }

    private static async Task WriteInitialBatch(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        IReadOnlyList<PlannedArticle> rows, long due, CancellationToken ct)
    {
        foreach (var article in rows) await Write(db, tx, actor, article, due, ct);
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
            !await CurrentSchema.HasAdminArticleArchiveSchemaAsync(db, tx, ct))
            throw new InvalidOperationException("Fixture target does not match the attested site and publication schema.");
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, new CatalogVerificationOptions
        {
            Media = new() { ArticleMedia = true },
            AdminContent = new() { ArticleRollback = true },
            Publication = new() { Canonical = true }
        });
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        await using var empty = Store.Sql(db, tx, """
            select not exists (select from public.article) and not exists (select from public.blog_user)
               and not exists (select from public.comment) and not exists (select from public.blog_outbox)
               and not exists (select from public.admin_principal)
               and (select last_value=1 and not is_called from public.article_id_seq)
               and (select last_value=1 and not is_called from public.article_publication_publication_id_seq)
               and (select count(*)=32 and bool_and(id between 1 and 32 and name='Nightly category ' || lpad(id::text,2,'0'))
                    from public.category)
               and (select count(*)=128 and bool_and(id between 1 and 128 and name='Nightly tag ' || lpad(id::text,3,'0'))
                    from public.tag)
            """);
        if (await empty.ExecuteScalarAsync(ct) is not true)
            throw new InvalidOperationException("Fixture target has existing business rows, incompatible taxonomy, or allocated IDs.");
        await FixtureSql.AdminPrincipalAsync(db, tx, ct, actor.Id, ScratchDatabase.AdminHandle(actor.Name, actor.Id), enabled: true, generation: actor.Generation);
    }

    private static async Task StartArchiveSession(NpgsqlConnection db, InstanceLease lease, byte[] sessionDigest, CancellationToken ct)
    {
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        // The fixture exercises the native grant, session and proof consumption checks. The separate browser test exercises Passkey.
        await using var seed = Store.Sql(db, tx, FixtureSql.AdminSessionSql,
            FixtureSql.AdminSessionArguments(ArchiveAdministrator, "nightly-fixture-archive",
                RandomNumberGenerator.GetBytes(32), RandomNumberGenerator.GetBytes(32), [1], sessionDigest, 2));
        Assert.Equal(1, await seed.ExecuteNonQueryAsync(ct));
        await InstanceLease.CommitProtected(tx, lease, ct);
    }

    private static async Task<string> PrepareArchive(NpgsqlConnection db, InstanceLease lease, Identity actor, PlannedArticle article,
        long sourceRelease, AdminArticleArchiveIntent intent, byte[] sessionDigest, CancellationToken ct, CheckpointBinding? checkpoint = null)
    {
        int id = article.Id;
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        var draft = await Mutate(db, tx, actor, id, 3, ArticleAction.Save, ct, article.ReplacementTitle, article.ReplacementBody);
        Assert.Equal<long?>(3, draft.PublishedRevision);
        var replacement = await Mutate(db, tx, actor, id, 4, ArticleAction.Publish, ct);
        Assert.Equal<long?>(5, replacement.PublishedRevision);
        Assert.Equal((article.ReplacementTitle, article.ReplacementBody), (replacement.Title, replacement.Body));

        await using (var evidence = Store.Sql(db, tx, """
            with source_release as (
                select min(h.publication_id) as publication_id
                from public.article_publication_history h
                join public.article_publication_rights w on (w.publication_id,w.article_id,w.revision)=(h.publication_id,h.article_id,h.revision)
                join public.article_revision_rights r on (r.article_id,r.revision)=(w.article_id,w.revision)
                where h.article_id=$1 and h.revision=3 and h.kind in ('publish','replace','retained-active')
                having count(*)=1 and min(h.publication_id)=$2
            ), snapshot as (
                insert into public.article_revision_responsibility(article_id,revision,responsible_party,basis,reference,recorded_by)
                select $1,3,'Nightly synthetic editor','Fixture custody of first public revision',
                    'c11-nightly-archive:' || $1::text,current_user::text from source_release returning id
            )
            insert into public.article_publication_responsibility(publication_id,article_id,revision,snapshot_id)
            select publication_id,$1,3,id from source_release cross join snapshot
            """, id, sourceRelease))
            Assert.Equal(1, await evidence.ExecuteNonQueryAsync(ct));

        var proof = await IssueArchiveProof(db, tx, intent, sessionDigest, ct);
        if (checkpoint is not null)
            await RecordArchivePrepared(db, tx, intent, checkpoint, ct);
        await InstanceLease.CommitProtected(tx, lease, ct);
        return proof;
    }

    private static async Task<string> IssueArchiveProof(NpgsqlConnection db, NpgsqlTransaction tx,
        AdminArticleArchiveIntent intent, byte[] sessionDigest, CancellationToken ct)
    {
        var proof = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var proofDigest = SHA256.HashData(Encoding.ASCII.GetBytes(proof));
        var intentDigest = AdminArticleArchiveStore.ArticleArchiveIntentDigest(intent);
        await using (var step = Store.Sql(db, tx, """
            with session as (
                update public.admin_session set expires_at=clock_timestamp()+interval '2 minutes'
                where digest=$1 and principal_id=$2 and generation=1 and expires_at>clock_timestamp()
                returning digest,principal_id,generation
            )
            insert into public.admin_article_rollback_step_up(digest,principal_id,session_digest,generation,action,body_digest,expires_at,kind)
            select $3,principal_id,digest,generation,8,$4,clock_timestamp()+interval '45 seconds',2 from session
            """, sessionDigest, ArchiveAdministrator, proofDigest, intentDigest))
            Assert.Equal(1, await step.ExecuteNonQueryAsync(ct));
        return proof;
    }

    private static void RequireArchiveReceipt(PlannedArticle archived, AdminArticleArchiveIntent intent, AdminArticleArchiveReceipt receipt)
    {
        long replacementRelease = intent.ExpectedReleaseId;
        Assert.Equal((archived.Id, 6L, 3L, replacementRelease, replacementRelease + 1, 3, Wire.AdminArticleArchiveStatus),
            (receipt.ArticleId, receipt.Revision, receipt.SourceRevision, receipt.PreviousReleaseId, receipt.ReleaseId,
                receipt.PublicationNo, receipt.TargetStatus));
        Assert.True(receipt.TransitionedUnixMs > 0 && receipt.RightsSnapshotId > 0 && receipt.ResponsibilitySnapshotId > 0);
    }

    private static async Task RetireArchiveSession(NpgsqlConnection db, InstanceLease lease, CancellationToken ct,
        CheckpointBinding? checkpoint = null)
    {
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        await using (var proof = Store.Sql(db, tx,
            "select not exists (select from public.admin_article_rollback_step_up where principal_id=$1)", ArchiveAdministrator))
            Assert.True(await proof.ExecuteScalarAsync(ct) is true);
        await using var retire = Store.Sql(db, tx, """
            with sessions as (delete from public.admin_session where principal_id=$1 returning 1),
                 credentials as (delete from public.admin_passkey_credential where principal_id=$1 returning 1),
                 principal as (
                    update public.admin_principal set enabled=false,generation=2,generation_changed_at=clock_timestamp()
                    where id=$1 and enabled and generation=1 returning 1
                 )
            select (select count(*) from sessions)=1 and (select count(*) from credentials)=1 and
                   (select count(*) from principal)=1
            """, ArchiveAdministrator);
        Assert.True(await retire.ExecuteScalarAsync(ct) is true);
        if (checkpoint is not null)
        {
            var position = await ReadCheckpoint(db, tx, checkpoint, ct);
            Assert.Equal(checkpoint.Count / 20, position.Archived);
            await using var finish = Store.Sql(db, tx, """
                update fsus_nightly_fixture.article_checkpoint set finished=true
                where singleton and not finished and archive_stage=0 and committed_articles=article_count
                    and archived_articles=article_count/20
                """);
            Assert.Equal(1, await finish.ExecuteNonQueryAsync(ct));
        }
        await InstanceLease.CommitProtected(tx, lease, ct);
    }

    private static async Task Write(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, PlannedArticle article,
        long due, CancellationToken ct)
    {
        var id = article.Id;
        await Mutate(db, tx, actor, id, 0, ArticleAction.Save, ct, article.Title, article.Body);
        var taxonomy = await Store.AssignTaxonomy(db, tx, actor, new(id, 1, Command(id, 2), article.Category, [article.Tag]), ct);
        Assert.Equal((id, 2L, article.Category, article.Tag),
            (taxonomy.Id, taxonomy.Revision, taxonomy.CategoryId, Assert.Single(taxonomy.TagIds)));
        if (article.Kind == "scheduled")
        {
            await Schedule(2, 3, 0);
            return;
        }

        var published = await Mutate(db, tx, actor, id, 2, ArticleAction.Publish, ct);
        Assert.Equal<long?>(3, published.PublishedRevision);
        switch (article.Kind)
        {
            case "scheduled-update":
                var privateDraft = await Mutate(db, tx, actor, id, 3, ArticleAction.Save, ct, article.ReplacementTitle, article.ReplacementBody);
                Assert.Equal<long?>(3, privateDraft.PublishedRevision);
                await Schedule(4, 5, 3);
                break;
            case "deleted":
                var hidden = await Mutate(db, tx, actor, id, 3, ArticleAction.Delete, ct);
                Assert.Null(hidden.PublishedRevision);
                Assert.True(hidden.Deleted);
                break;
        }

        async Task Schedule(long revision, byte step, long expectedPublic)
        {
            var pending = await Store.Schedule(db, tx, actor, new(id, revision, Command(id, step), due), ct);
            Assert.Equal((id, revision + 1, expectedPublic, due),
                (pending.Id, pending.Revision, pending.PublishedRevision, pending.DueUnixMs));
        }
    }

    private static async Task<ArticleState> Mutate(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, int id,
        long revision, ArticleAction action, CancellationToken ct, string title = "", string body = "")
    {
        var key = Command(id, checked((byte)(revision + 1)));
        var edit = Publishing.Validate(action, new(revision == 0 ? 0 : id, revision, key, title, body));
        var (state, changed) = await Store.Execute(db, tx, actor, action, edit, ct);
        Assert.True(changed);
        Assert.Equal((id, revision + 1), (state.Id, state.Revision));
        return state;
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
            18 => "archived",
            19 => "deleted",
            _ => throw new InvalidOperationException("Unexpected article plan ordinal.")
        };
        if (fields[1] != kind || string.IsNullOrWhiteSpace(fields[4]) || string.IsNullOrWhiteSpace(fields[5]) ||
            (kind is "scheduled-update" or "archived" ? string.IsNullOrWhiteSpace(fields[6]) || string.IsNullOrWhiteSpace(fields[7]) ||
                (fields[4], fields[5]) == (fields[6], fields[7]) : fields[6].Length != 0 || fields[7].Length != 0))
            throw new InvalidOperationException($"Unexpected lifecycle or content fields for article {id}.");
        return new(id, kind, category, tag, fields[4], fields[5], fields[6], fields[7]);
    }

    private sealed record PlannedArticle(int Id, string Kind, int Category, int Tag, string Title, string Body,
        string ReplacementTitle, string ReplacementBody);

    private sealed class PlanReader(Stream stream)
    {
        private static readonly UTF8Encoding Utf8 = new(false, true);
        private readonly byte[] _buffer = new byte[64 * 1024];
        private readonly byte[] _line = new byte[64 * 1024];
        private int _start;
        private int _end;

        internal long Position => stream.Position - (_end - _start);
        internal long Length => stream.Length;

        internal void Seek(long position)
        {
            stream.Seek(position, SeekOrigin.Begin);
            _start = 0;
            _end = 0;
        }

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
