using NpgsqlTypes;

internal static partial class Cli
{
    private const int PublicationMediaObjectLimit = 20 * 1024 * 1024;

    private static async Task WriteInventoryAsync(NpgsqlConnection connection, bool countRows, CancellationToken token)
    {
        await using var transaction = await BeginReadOnlyAsync(connection, token);
        var target = await ReadTargetAsync(connection, transaction, token);
        var relations = await RelationsAsync(connection, transaction, token);
        var report = new List<RelationInventory>(relations.Count);
        foreach (var relation in relations)
        {
            var columns = await QueryListAsync(connection, transaction, """
                SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attidentity::text, a.attgenerated::text
                FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid
                JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
                WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum
                """, static r => new ColumnInventory(r.GetString(0), r.GetString(1), r.GetBoolean(2), r.GetString(3), r.GetString(4)),
                token, relation.Schema, relation.Name);
            var keys = await QueryListAsync(connection, transaction, """
                SELECT k.conname, k.contype::text, pg_catalog.pg_get_constraintdef(k.oid), k.convalidated
                FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid
                JOIN pg_catalog.pg_constraint k ON k.conrelid = c.oid
                WHERE n.nspname = $1 AND c.relname = $2 AND k.contype IN ('f','p','u','x') ORDER BY k.conname
                """, static r => new KeyInventory(r.GetString(0), r.GetString(1), r.GetString(2), r.GetBoolean(3)),
                token, relation.Schema, relation.Name);
            long? count = null;
            if (countRows && relation.Kind is "r" or "p")
            {
                using var names = new NpgsqlCommandBuilder();
                var table = names.QuoteIdentifier(relation.Schema) + "." + names.QuoteIdentifier(relation.Name);
                count = (long)(await ScalarAsync(connection, transaction,
                    "SELECT count(*) FROM " + (relation.Kind == "r" ? "ONLY " + table : table), token)
                    ?? throw new InvalidOperationException("Could not count the source rows."));
            }
            report.Add(new RelationInventory(relation.Schema, relation.Name, relation.Kind, count, columns, keys));
        }
        await transaction.CommitAsync(token);
        Console.WriteLine(JsonSerializer.Serialize(new { target, serverVersion = connection.ServerVersion, relations = report }, Json));
    }

    private static async Task AdminIdentityAsync(NpgsqlConnection connection, string[] arguments, CancellationToken ct)
    {
        var (action, handle) = arguments switch
        {
            ["bootstrap" or "rotate-passkey" or "revoke-all" or "disable", var name] => (arguments[0], name),
            _ => throw new ArgumentException("Use admin-identity bootstrap HANDLE, rotate-passkey HANDLE, revoke-all HANDLE, or disable HANDLE.")
        };
        if (handle.Length is < 1 or > 64 || !char.IsAsciiLetterLower(handle[0]) ||
            !handle.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c is '_' or '-' or '.'))
            throw new ArgumentException("Use a lowercase administrator handle of up to 64 ASCII letters, digits, dots, underscores or hyphens, starting with a letter.");

        await CurrentSchema.VerifyAsync(connection, ct);
        await using var tx = await connection.BeginTransactionAsync(ct);
        await ExecuteAsync(connection, tx, "SET LOCAL search_path TO pg_catalog", ct);
        if (await ScalarAsync(connection, tx, "show session_replication_role", ct) is not "origin")
            throw new InvalidOperationException("Administrator identity requires ordinary integrity triggers.");

        Guid principal;
        long generation;
        if (action == "bootstrap")
        {
            principal = Guid.NewGuid();
            generation = 1;
            await ExecuteAsync(connection, tx,
                "insert into public.admin_principal(id,handle,user_handle,enabled,generation) values($1,$2,$3,true,1)",
                ct, principal, handle, RandomNumberGenerator.GetBytes(32));
        }
        else
        {
            principal = await ScalarAsync(connection, tx,
                "select id from public.admin_principal where handle=$1 and enabled for update", ct, handle) is Guid id
                ? id : throw new InvalidOperationException("Enabled administrator principal not found.");
            generation = (long)(await ScalarAsync(connection, tx, """
                update public.admin_principal set generation=generation+1,generation_changed_at=pg_catalog.clock_timestamp(),enabled=$2
                where id=$1 returning generation
                """, ct, principal, action != "disable"))!;
            await AdminSignInHistory.RetireAsync(connection, tx, principal, null, ct);
            await ExecuteAsync(connection, tx, "delete from public.admin_invitation where principal_id=$1", ct, principal);
            await ExecuteAsync(connection, tx, "delete from public.admin_challenge where principal_id=$1", ct, principal);
            if (action is "rotate-passkey" or "disable")
                await ExecuteAsync(connection, tx, "delete from public.admin_passkey_credential where principal_id=$1", ct, principal);
        }

        await ExecuteAsync(connection, tx, """
            insert into public.admin_identity_audit(principal_id,action,happened_at,actor)
            values($1,$2,pg_catalog.clock_timestamp(),session_user::text)
            """, ct, principal, action);

        if (action is "bootstrap" or "rotate-passkey")
        {
            var secret = RandomNumberGenerator.GetBytes(32);
            try
            {
                await ExecuteAsync(connection, tx, """
                    insert into public.admin_invitation(digest,principal_id,generation,expires_at)
                    values($1,$2,$3,pg_catalog.clock_timestamp()+interval '10 minutes')
                    """, ct, SHA256.HashData(secret), principal, generation);
                await tx.CommitAsync(ct);
                Console.WriteLine(Convert.ToHexStringLower(secret));
            }
            finally { CryptographicOperations.ZeroMemory(secret); }
        }
        else
        {
            await tx.CommitAsync(ct);
            Console.WriteLine(action == "disable" ? "Disabled administrator principal." : "Revoked administrator sessions and invitations.");
        }
    }

    private static async Task UpgradeMediaFormatsAsync(NpgsqlConnection db, CancellationToken ct)
    {
        await using var tx = await BeginStoppedOperationAsync(db, ct);
        var enabled = await CurrentSchema.VerifyCatalogAsync(db, tx, ct);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct);
        if (!enabled)
        {
            await AllowWebpFormatAsync(db, tx, "private_media", ct);
            await AllowWebpFormatAsync(db, tx, "private_media_upload", ct);
            if (await CurrentSchema.HasPublicationMediaAsync(db, tx, ct))
                await AllowWebpFormatAsync(db, tx, "article_publication_media", ct);
            if (!await CurrentSchema.VerifyCatalogAsync(db, tx, ct))
                throw new InvalidOperationException("The static WebP schema was not installed.");
        }
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified static WebP media schema.");
    }

    private static async Task AllowWebpFormatAsync(NpgsqlConnection db, NpgsqlTransaction tx, string table, CancellationToken ct)
    {
        if (await ScalarAsync(db, tx, """
            select c.conname::text from pg_catalog.pg_constraint c
            join pg_catalog.pg_attribute a on a.attrelid=c.conrelid and a.attname='format'
            where c.conrelid=pg_catalog.to_regclass($1) and c.contype='c' and c.conkey=array[a.attnum]
            """, ct, "public." + table) is not string name)
            throw new InvalidOperationException("The verified media format check was not found.");
        using var identifiers = new NpgsqlCommandBuilder();
        var constraint = identifiers.QuoteIdentifier(name);
        await ExecuteAsync(db, tx, $"""
            ALTER TABLE public.{identifiers.QuoteIdentifier(table)} DROP CONSTRAINT {constraint},
              ADD CONSTRAINT {constraint} CHECK (format >= 1 AND format <= 3)
            """, ct);
    }

    private static async Task NotifyAsync(NpgsqlConnection connection, string recipient, string eventId, Stream input, CancellationToken ct)
    {
        if (!Guid.TryParseExact(recipient, "D", out var account) || account == Guid.Empty)
            throw new ArgumentException("Set ACCOUNT_ID to the intended user's database UUID.");
        using var document = await ReadInputJsonAsync(input, 96 * 1024, "Notice input exceeds 96 KiB.", ct);
        if (document.RootElement.ValueKind != JsonValueKind.Object)
            throw new ArgumentException("Expected an object with subject and body strings.");
        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var field in document.RootElement.EnumerateObject())
        {
            if (field.Value.ValueKind != JsonValueKind.String) throw new ArgumentException("Expected subject and body strings.");
            if (field.Name is not ("subject" or "body") || !fields.TryAdd(field.Name, field.Value.GetString()!))
                throw new ArgumentException("Unexpected or repeated notice field.");
        }
        if (!fields.TryGetValue("subject", out var subject) || !fields.TryGetValue("body", out var body))
            throw new ArgumentException("Set both subject and body.");
        await CurrentSchema.VerifyAsync(connection, ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);
        InboxNoticeReceipt receipt;
        try
        {
            var sent = await new InboxStore(connection, transaction, account, fenceVisibleMessages: true).SendNoticeAsync(eventId, subject, body, ct);
            receipt = new InboxNoticeReceipt(account, sent.Message.ConversationId, sent.Message.Id, sent.Replayed);
        }
        catch (BusinessException error) { throw new InvalidOperationException(error.Message, error); }
        await transaction.CommitAsync(ct);
        Console.WriteLine(JsonSerializer.Serialize(receipt, Json));
    }

    private static async Task IssueSubscriptionCancelAsync(NpgsqlConnection connection, string channelName, CancellationToken ct)
    {
        var channel = channelName switch
        {
            "rss" => SubscriptionIdentity.RssChannel, "email" => SubscriptionIdentity.EmailChannel,
            _ => throw new ArgumentException("Use site-subscription issue-cancel rss|email and provide one email address on standard input.")
        };
        var identity = SubscriptionIdentity.Read(Environment.GetEnvironmentVariable(SubscriptionIdentity.KeySetting)) ??
            throw new InvalidOperationException("Subscription preferences are disabled.");
        if (!Console.IsInputRedirected) throw new ArgumentException("Provide one email address on redirected standard input.");
        var input = new byte[SubscriptionIdentity.EmailLimit + 3];
        byte[] emailKey;
        try
        {
            using var stdin = Console.OpenStandardInput();
            var used = await stdin.ReadAtLeastAsync(input, input.Length, false, ct);
            if (used == input.Length || input.AsSpan(0, used).ContainsAnyInRange((byte)128, byte.MaxValue)) throw InvalidEmail();
            var email = Encoding.ASCII.GetString(input, 0, used);
            email = email.EndsWith("\r\n", StringComparison.Ordinal) ? email[..^2] : email.EndsWith('\n') ? email[..^1] : email;
            emailKey = identity.EmailKey(email) ?? throw InvalidEmail();
        }
        finally { CryptographicOperations.ZeroMemory(input); }

        await CurrentSchema.VerifyAsync(connection, ct, new(Subscription: true));
        var secret = RandomNumberGenerator.GetBytes(32);
        try
        {
            await using var tx = await connection.BeginTransactionAsync(ct);
            await using (var handoff = DatabaseSql.Create(connection, tx,
                "select pg_catalog.pg_advisory_xact_lock_shared($1,$2)", PublicationLocks.HandoffClass, PublicationLocks.HandoffObject))
            {
                handoff.CommandTimeout = 5;
                await handoff.ExecuteNonQueryAsync(ct);
            }
            if (await ScalarAsync(connection, tx,
                "select 1 from public.site_subscription where email_key=$1 and channel=$2 and enabled for update", ct, emailKey, channel) is not 1 ||
                await ExecuteAsync(connection, tx, """
                update public.site_subscription set proof_digest=$3, proof_expires_at=clock_timestamp()+$4
                where email_key=$1 and channel=$2 and enabled
                """, ct, emailKey, channel, SHA256.HashData(secret), SubscriptionIdentity.ProofLifetime) != 1)
                throw new InvalidOperationException("A cancellation proof could not be issued for the provided preference.");
            await tx.CommitAsync(ct);
            Console.WriteLine(Convert.ToHexStringLower(secret));
        }
        finally { CryptographicOperations.ZeroMemory(secret); }

        static ArgumentException InvalidEmail() => new("Provide one valid ASCII email address on standard input.");
    }

    private static async Task RecordArticleResponsibilityAsync(NpgsqlConnection connection, string articleId, string revisionNumber, CancellationToken ct)
    {
        if (!int.TryParse(articleId, NumberStyles.None, CultureInfo.InvariantCulture, out var article) || article <= 0 ||
            !long.TryParse(revisionNumber, NumberStyles.None, CultureInfo.InvariantCulture, out var revision) || revision <= 0)
            throw new ArgumentException("Provide a positive article ID and revision.");
        if (!Console.IsInputRedirected)
            throw new ArgumentException("Provide the historical responsibility record on redirected standard input.");
        using var input = Console.OpenStandardInput();
        var evidence = await ReadArticleResponsibilityAsync(input, ct);
        await using var tx = await BeginStoppedOperationAsync(connection, ct);
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, new CatalogVerificationOptions
        {
            Media = new() { ArticleMedia = true }, AdminContent = new() { ArticleRollback = true }
        });
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        if (await ScalarAsync(connection, tx, "SELECT id FROM public.article WHERE id=$1 AND NOT deleted FOR UPDATE", ct, article) is null)
            throw new InvalidOperationException("A live article is required to record historical responsibility.");

        var publications = await QueryListAsync(connection, tx, """
            WITH publications AS (
                SELECT h.publication_id FROM public.article_publication_history h
                WHERE h.article_id=$1 AND h.revision=$2 AND h.publication_id IS NOT NULL AND h.kind IN ('publish','replace','retained-active')
                UNION
                SELECT p.publication_id FROM public.article_publication p JOIN public.article a ON a.id=p.article_id AND a.published_revision=p.revision
                WHERE p.article_id=$1 AND p.revision=$2
            )
            SELECT p.publication_id FROM publications p JOIN public.article_publication_rights w ON w.publication_id=p.publication_id
              AND w.article_id=$1 AND w.revision=$2
            """, static r => r.GetInt64(0), ct, article, revision);
        if (publications.Count == 0)
            throw new InvalidOperationException("The revision lacks a historical publication with a matching immutable rights snapshot.");
        if (publications.Count > 1) throw new InvalidOperationException("The historical publication coordinate is ambiguous.");
        var publication = publications[0];

        var existingRows = await QueryListAsync(connection, tx, """
            SELECT r.id,p.publication_id,r.responsible_party,r.basis,r.reference
            FROM public.article_revision_responsibility r
            LEFT JOIN public.article_publication_responsibility p ON p.snapshot_id=r.id AND p.article_id=r.article_id AND p.revision=r.revision
            WHERE r.article_id=$1 AND r.revision=$2
            """, static row => row.IsDBNull(1)
                ? throw new InvalidOperationException("The immutable responsibility record lacks its publication binding.")
                : (Snapshot: row.GetInt64(0), Publication: row.GetInt64(1), Evidence: new HistoricalResponsibility(row.GetString(2), row.GetString(3), row.GetString(4))),
            ct, article, revision);
        if (existingRows.Count > 1) throw new InvalidOperationException("The immutable responsibility record has ambiguous publication bindings.");

        long snapshot;
        if (existingRows.Count == 1)
        {
            if (existingRows[0].Evidence != evidence || existingRows[0].Publication != publication)
                throw new InvalidOperationException("This historical responsibility coordinate already has different immutable evidence.");
            snapshot = existingRows[0].Snapshot;
        }
        else
        {
            snapshot = (long)(await ScalarAsync(connection, tx, """
                INSERT INTO public.article_revision_responsibility (article_id,revision,responsible_party,basis,reference,recorded_by)
                VALUES ($1,$2,$3,$4,$5,current_user::text) RETURNING id
                """, ct, article, revision, evidence.ResponsibleParty, evidence.Basis, evidence.Reference)
                ?? throw new InvalidOperationException("Could not record historical responsibility."));
            await ExecuteAsync(connection, tx, """
                INSERT INTO public.article_publication_responsibility(publication_id,article_id,revision,snapshot_id) VALUES ($1,$2,$3,$4)
                """, ct, publication, article, revision, snapshot);
        }
        await tx.CommitAsync(ct);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            articleId = article, revision, publicationId = publication, responsibilitySnapshotId = snapshot, replayed = existingRows.Count == 1
        }, Json));
    }

    private static async Task<HistoricalResponsibility> ReadArticleResponsibilityAsync(Stream input, CancellationToken ct)
    {
        using var document = await ReadInputJsonAsync(input, 64 * 1024, "Historical responsibility input exceeds 64 KiB.", ct);
        if (document.RootElement.ValueKind != JsonValueKind.Object)
            throw new ArgumentException("Provide a JSON object with responsibleParty, basis and reference strings.");
        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var field in document.RootElement.EnumerateObject())
        {
            var limit = field.Name switch { "responsibleParty" => 256, "basis" => 4000, "reference" => 1000, _ => 0 };
            if (limit == 0 || field.Value.ValueKind != JsonValueKind.String || field.Value.GetString() is not { } value ||
                value.Length == 0 || value != value.Trim() || StrictUtf8.GetByteCount(value) > limit ||
                value.Any(ch => char.IsControl(ch) && (field.Name != "basis" || ch is not ('\t' or '\r' or '\n'))) ||
                !fields.TryAdd(field.Name, value))
                throw new ArgumentException("Historical responsibility contains a missing, invalid or repeated field.");
        }
        if (fields.Count != 3) throw new ArgumentException("Provide all three historical responsibility fields.");
        return new HistoricalResponsibility(fields["responsibleParty"], fields["basis"], fields["reference"]);
    }

    private static async Task<JsonDocument> ReadInputJsonAsync(Stream input, int maximum, string limitError, CancellationToken ct)
    {
        var bytes = new byte[maximum + 1];
        var used = await input.ReadAtLeastAsync(bytes, bytes.Length, throwOnEndOfStream: false, ct);
        if (used > maximum) throw new ArgumentException(limitError);
        return JsonDocument.Parse(bytes.AsMemory(0, used), new JsonDocumentOptions { MaxDepth = 2 });
    }

    private static async Task VerifyOrRebuildPublicationMediaAsync(NpgsqlConnection db, bool rebuild,
        string site, string privateRoot, string publicRoot, string webRoot, CancellationToken ct)
    {
        if (!Guid.TryParseExact(site, "D", out var expectedSite) || expectedSite == Guid.Empty)
            throw new ArgumentException("Supply the expected durable site UUID.");
        if (!Path.IsPathFullyQualified(privateRoot) || !Path.IsPathFullyQualified(publicRoot) ||
            !Path.IsPathFullyQualified(webRoot) || !Directory.Exists(webRoot))
            throw new ArgumentException("Supply absolute existing private media, public media and web directories.");

        await using var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        if (await ScalarAsync(db, tx, "SELECT NOT pg_catalog.pg_is_in_recovery()", ct) is not true)
            throw new InvalidOperationException("Publication media recovery requires an offline primary database.");
        await PrepareStoppedOperationAsync(db, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, new CatalogVerificationOptions { Media = new() { ArticleMedia = true, PublicationMedia = true } });
        await ExecuteAsync(db, tx, """
            LOCK TABLE public.authoring_recovery_site, public.article, public.article_publication,
                public.article_publication_history, public.article_publication_media, public.article_revision_media, public.private_media
            IN SHARE MODE
            """, ct);
        if (await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct) != expectedSite)
            throw new InvalidOperationException("The database does not match the expected site.");
        await VerifyActivePublicationsAsync(db, tx, ct);
        await VerifyPublicationHistoryAsync(db, tx, ct);
        await VerifyPublicationMediaAsync(db, tx, ct);

        var forbidden = new List<string> { webRoot, Path.Combine(webRoot, "assets"), Path.Combine(webRoot, "dist") };
        if (Environment.GetEnvironmentVariable("FSUSBLOG_APPEARANCE_ROOT") is { Length: > 0 } appearance) forbidden.Add(appearance);
        using var sources = new MediaObjectDirectory(privateRoot, PublicationMediaObjectLimit, [.. forbidden, publicRoot]);
        using var objects = new MediaObjectDirectory(publicRoot, PublicationMediaObjectLimit, [.. forbidden, privateRoot]);

        var entries = await QueryListAsync(db, tx, """
            SELECT DISTINCT content_hash,asset_id,format,length,width,height
            FROM public.article_publication_media ORDER BY content_hash,asset_id
            """, static r => (Digest: r.GetFieldValue<byte[]>(0), Source: r.GetGuid(1),
                Image: new PublishedArticleImage(Convert.ToHexStringLower(r.GetFieldValue<byte[]>(0)), r.GetInt16(2), r.GetInt32(3), r.GetInt32(4), r.GetInt32(5))), ct);
        string? verifiedDigest = null;
        long checkedSources = 0, checkedObjects = 0, rebuiltObjects = 0;
        foreach (var (digest, source, image) in entries)
        {
            if (!image.Valid()) throw new InvalidOperationException("A publication media record has invalid normalized image metadata.");
            var sourceBytes = await sources.Read($"{source:N}.media", image.Length, digest, ct);
            if (sourceBytes is null || !PublishedArticleImage.MatchesFormat(sourceBytes, image.Format))
                throw new IOException("A retained private source is missing or has an unexpected format.");
            checkedSources++;
            if (string.Equals(verifiedDigest, image.Digest, StringComparison.Ordinal)) continue;
            var leaf = image.Digest + ".media";
            var publicBytes = await objects.Read(leaf, image.Length, digest, ct);
            if (publicBytes is null && rebuild)
            {
                await objects.Materialize(leaf, sourceBytes, digest, ct);
                publicBytes = await objects.Read(leaf, image.Length, digest, ct);
                rebuiltObjects++;
            }
            if (publicBytes is null || !PublishedArticleImage.MatchesFormat(publicBytes, image.Format))
                throw new IOException("A committed public media object is missing or has an unexpected format.");
            verifiedDigest = image.Digest;
            checkedObjects++;
        }
        await tx.CommitAsync(ct);
        Console.WriteLine(JsonSerializer.Serialize(new PublicationMediaRecovery(checkedSources, checkedObjects, rebuiltObjects), Json));
    }

    private static async Task VerifyPublicationCanonicalAsync(NpgsqlConnection connection, string? id, CancellationToken ct)
    {
        long? publication = null;
        if (id is not null)
        {
            if (!long.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out var value) || value <= 0)
                throw new ArgumentException("Supply a positive native publication identity.");
            publication = value;
        }
        await CurrentSchema.VerifyAsync(connection, ct);
        await using var tx = await BeginReadOnlyAsync(connection, ct);
        if (!await CurrentSchema.HasPublicationCanonicalAsync(connection, tx, ct))
            throw new InvalidOperationException("Native publication canonical storage is not installed.");
        var hasCover = await CurrentSchema.HasPublicationCoverAsync(connection, tx, ct);
        var pubParam = new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Bigint, Value = (object?)publication ?? DBNull.Value };
        long count = 0;
        var latestVersion = 2;
        string? receipt = null;
        await ReadAllAsync(connection, tx, $"""
            with canonical_outbox as materialized (
                select e.* from public.article_publication_canonical e
                join public.blog_outbox o on o.id=e.outbox_id and o.article_id=e.article_id and o.revision=e.revision and o.kind=e.outbox_kind
                where ($1 is null or e.publication_id=$1)
            )
            select {PublicationCanonicalFacts.Columns},{PublicationCanonicalFacts.CoverColumn(hasCover)},
                   e.outbox_id,e.content_sha256,e.policy_sha256,e.canonical_version
            from canonical_outbox e join public.article_publication_history h
              on h.publication_id=e.publication_id and h.article_id=e.article_id and h.revision=e.revision
              and h.publication_no=e.publication_no and h.happened_at=e.published_at and h.kind=e.transition
            {PublicationCanonicalFacts.RevisionJoins}
            where s.id=e.rights_snapshot_id order by e.publication_id
            """, row =>
        {
            var facts = PublicationCanonicalFacts.Read(row);
            if (facts.Version != row.GetInt32(26) ||
                !CryptographicOperations.FixedTimeEquals(facts.Content, row.GetFieldValue<byte[]>(24)) ||
                !CryptographicOperations.FixedTimeEquals(facts.Policy, row.GetFieldValue<byte[]>(25)))
                throw new InvalidOperationException($"Native publication {facts.Publication} canonical digests differ from retained revision and policy facts.");
            count++;
            latestVersion = Math.Max(latestVersion, facts.Version);
            if (publication.HasValue)
                receipt = JsonSerializer.Serialize(new
                {
                    canonicalVersion = facts.Version, publicationId = DecimalSequence(facts.Publication), articleId = facts.Article,
                    revision = DecimalSequence(facts.Revision), publicationNo = facts.Number,
                    publishedAtUtc = facts.PublishedAt.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", CultureInfo.InvariantCulture),
                    transition = facts.Transition, rightsSnapshotId = DecimalSequence(facts.RightsSnapshot),
                    publicationOutboxId = DecimalSequence(row.GetInt64(23)), contentSha256 = Convert.ToHexStringLower(facts.Content),
                    policySha256 = Convert.ToHexStringLower(facts.Policy),
                });
        }, ct, pubParam);
        var countParam = new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Bigint, Value = (object?)publication ?? DBNull.Value };
        if (await ScalarAsync(connection, tx, "select count(*) from public.article_publication_canonical where $1 is null or publication_id=$1", ct, countParam) is not long expectedCount || expectedCount != count)
            throw new InvalidOperationException("Native canonical storage contains incomplete publication coordinates.");
        if (publication.HasValue && receipt is null)
            throw new InvalidOperationException("The requested publication has no native canonical binding.");
        await tx.CommitAsync(ct);
        Console.WriteLine(receipt ?? JsonSerializer.Serialize(new { canonicalVersion = latestVersion, verifiedPublications = count }));
    }

    private sealed record ColumnInventory(string Name, string Type, bool NotNull, string Identity, string Generated);
    private sealed record KeyInventory(string Name, string Kind, string Definition, bool Validated);
    private sealed record RelationInventory(string Schema, string Name, string Kind, long? Rows, List<ColumnInventory> Columns, List<KeyInventory> Keys);
    private sealed record InboxNoticeReceipt(Guid AccountId, long ConversationId, long MessageId, bool Replayed);
    private sealed record HistoricalResponsibility(string ResponsibleParty, string Basis, string Reference);
    private sealed record PublicationMediaRecovery(long CheckedSources, long CheckedObjects, long RebuiltObjects);
}
