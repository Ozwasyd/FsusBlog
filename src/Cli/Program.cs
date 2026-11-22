using System.Data;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Cli;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;
using Npgsql;

return await (PlatformPluginCommand.IsWorker(args) ? PlatformPluginCommand.Worker() : Cli.RunAsync(args));

internal static partial class Cli
{
    private const string DatabaseVariable = "FSUSBLOG_DB";
    private const string SchemaResourcePrefix = "FsusBlog.V2.Cli.Schema.";
    private const string BootstrapLock = "SELECT pg_catalog.pg_advisory_xact_lock(4815262471654073021)";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private static readonly IReadOnlyDictionary<(string Command, string? Subcommand),
        Func<NpgsqlConnection, CancellationToken, Task>> FixedDatabaseCommands =
        new Dictionary<(string, string?), Func<NpgsqlConnection, CancellationToken, Task>>
        {
            [("plan", null)] = PlanAsync,
            [("media-webp", "schema")] = UpgradeMediaFormatsAsync,
            [("publication-transparency", "enable")] = EnablePublicationTransparencyAsync,
        };

    internal static async Task<int> RunAsync(string[] arguments)
    {
        if (arguments is ["help"] or ["--help"] or [])
        {
            Console.WriteLine("""
                FsusBlog V2 offline operations CLI
                Set FSUSBLOG_DB to the Npgsql connection string.
                  inventory              Read PostgreSQL relations, columns and keys from the target
                  inventory --counts     Include exact row counts for each ordinary business relation
                  plan                   Print a fresh-schema plan without changing the database
                  apply PLAN.json        Apply that plan atomically to an empty database
                  verify                 Check the current marker, shape and publication coordinates
                  init-secrets           Generate fresh independent 32-byte deployment secrets (TOTP, recovery pepper, subscription HMAC)
                  admin-identity bootstrap HANDLE
                                         Create a unified administrator and issue a one-use Passkey invitation
                  admin-identity rotate-passkey HANDLE
                                         Revoke existing administrator access and issue a replacement invitation
                  admin-identity revoke-all HANDLE
                                         End administrator sessions and cancel pending invitations
                  admin-identity disable HANDLE
                                         Disable an administrator and remove authentication credentials
                  operator NAME [--reader]
                                         Create a reader account and issue an expiring one-use login ticket
                  ticket NAME            Issue a new expiring one-use ticket for an existing enabled user
                  revoke NAME            End all sessions and pending tickets for an existing user
                  notify ACCOUNT_ID EVENT_ID
                                         Send an idempotent system notice from a UTF-8 JSON object on stdin
                  comment handle ACCOUNT_ID DISPLAY_NAME
                                         Assign an explicit public comment display name to an enabled account
                  comment policy ARTICLE_ID enable|disable
                                         Allow or deny moderated public submissions on the article
                  comment moderate ARTICLE_ID COMMENT_ID EXPECTED_STATUS approve|reject|hide REASON
                                         Change comment status and append the trusted database role audit event
                  site-subscription issue-cancel rss|email
                                         Issue a short-lived cancellation proof for an email read from stdin
                  media-webp schema      Enable limited static WebP media with the server stopped
                  article-public-media verify|rebuild SITE_UUID PRIVATE_ROOT PUBLIC_ROOT WEB_ROOT
                                         Check historical image objects or rebuild missing objects from retained private bytes
                  article-responsibility record ARTICLE REVISION
                                         Record explicit historical responsibility JSON from stdin
                  publication-canonical verify [PUBLICATION_ID]
                                         Recompute native publication digests from retained PostgreSQL facts
                  publication-transparency enable
                                         Start a native proof issuance ledger from an empty genesis
                  publication-transparency checkpoint-release HTTPS_ORIGIN KEYS_JSON HEAD_JSON RELEASE_ID FROM_SEQ TO_SEQ [INCLUDE_SEQ]
                                         Sign a release checkpoint from a pinned native log with the server stopped
                  publication-transparency checkpoint-daily HTTPS_ORIGIN KEYS_JSON HEAD_JSON YYYY-MM-DD [INCLUDE_SEQ]
                                         Sign a closed UTC day within the witnessed native log prefix
                  publication-transparency checkpoint-daily-auto HTTPS_ORIGIN KEYS_JSON ANCHOR_SEQ ANCHOR_SHA256 OUTPUT_ROOT [YYYY-MM-DD]
                                         Seal a closed UTC day from a live primary with a separate checkpoint key
                  publication-transparency verify HTTPS_ORIGIN KEYS_JSON [PREFIX_SEQ PREFIX_SHA256]
                                         Verify a local issuance ledger with a trusted public key manifest
                  backup measure         Fingerprint an offline v2 PostgreSQL site and its media metadata
                  extension --help       Manage an offline signed authoring extension store
                  platform-plugin --help Invoke one approved pure Markdown hook in an offline worker
                """);
            return 0;
        }

        if (arguments is ["init-secrets"])
        {
            Console.WriteLine($"FSUSBLOG_TOTP_KEY_HEX={Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32))}");
            Console.WriteLine($"FSUSBLOG_RECOVERY_KEY_PEPPER_HEX={Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32))}");
            Console.WriteLine($"{SubscriptionIdentity.KeySetting}={Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32))}");
            return 0;
        }

        using var cancelled = new CancellationTokenSource();
        ConsoleCancelEventHandler cancel = (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancelled.Cancel();
        };
        Console.CancelKeyPress += cancel;
        try
        {
            if (arguments is ["platform-plugin", .. var pluginArguments])
                return await PlatformPluginCommand.RunAsync(pluginArguments, cancelled.Token);
            if (arguments is ["backup", "measure"] or ["backup", "measure", "--hold-snapshot"])
                return await MeasureBackupAsync(arguments.Length == 3, cancelled.Token);
            if (arguments is ["extension", .. var extensionArguments])
                return await ExtensionMaintenance.RunAsync(extensionArguments, cancelled.Token);
            if (arguments is ["legacy", ..])
                throw new ArgumentException("V1 data migration commands have been removed.");

            var connectionString = Environment.GetEnvironmentVariable(DatabaseVariable);
            if (string.IsNullOrWhiteSpace(connectionString))
                throw new ArgumentException($"Set {DatabaseVariable} before using the database tool.");

            var connectionSettings = new NpgsqlConnectionStringBuilder(connectionString);
            if (string.IsNullOrWhiteSpace(connectionSettings.Database))
                throw new ArgumentException($"Set the database name explicitly in {DatabaseVariable}.");

            var token = cancelled.Token;
            await using var connection = new NpgsqlConnection(connectionString);
            await connection.OpenAsync(token);
            var fixedHandler = arguments switch
            {
                [var command] => FixedDatabaseCommands.GetValueOrDefault((command, null)),
                [var command, var subcommand] => FixedDatabaseCommands.GetValueOrDefault((command, subcommand)),
                _ => null
            };
            if (fixedHandler is not null)
            {
                await fixedHandler(connection, token);
                return 0;
            }

            switch (arguments)
            {
                case ["inventory"]:
                    await WriteInventoryAsync(connection, countRows: false, token);
                    break;
                case ["inventory", "--counts"]:
                    await WriteInventoryAsync(connection, countRows: true, token);
                    break;
                case ["apply", var path]:
                    await ApplyAsync(connection, path, token);
                    break;
                case ["verify"]:
                    await CurrentSchema.VerifyAsync(connection, token);
                    await VerifyPublicationsAsync(connection, token);
                    Console.WriteLine($"Verified FsusBlog V2 schema version {CurrentSchema.Version}.");
                    break;
                case ["publication-canonical", "verify"]:
                    await VerifyPublicationCanonicalAsync(connection, null, token);
                    break;
                case ["publication-canonical", "verify", var canonicalPublication]:
                    await VerifyPublicationCanonicalAsync(connection, canonicalPublication, token);
                    break;
                case ["publication-transparency", "checkpoint-release", .. var checkpointArgs]:
                    await CreatePublicationCheckpointAsync(connection, checkpointArgs, PublicationCheckpointKind.Release, token);
                    break;
                case ["publication-transparency", "checkpoint-daily", .. var dailyCheckpointArgs]:
                    await CreatePublicationCheckpointAsync(connection, dailyCheckpointArgs, PublicationCheckpointKind.Daily, token);
                    break;
                case ["publication-transparency", "checkpoint-daily-auto", .. var automaticCheckpointArgs]:
                    await SealDailyPublicationCheckpointAsync(connection, automaticCheckpointArgs, token);
                    break;
                case ["publication-transparency", "verify", var transparencyOrigin, var transparencyKeys, .. var transparencyAnchor]:
                    await VerifyPublicationTransparencyAsync(connection, transparencyOrigin, transparencyKeys, transparencyAnchor, token);
                    break;
                case ["article-responsibility", "record", var responsibilityArticle, var responsibilityRevision]:
                    await RecordArticleResponsibilityAsync(connection, responsibilityArticle, responsibilityRevision, token);
                    break;
                case ["article-public-media", var mediaOperation, var mediaSite, var privateMediaRoot, var publicMediaRoot, var mediaWebRoot]
                    when mediaOperation is "verify" or "rebuild":
                    await VerifyOrRebuildPublicationMediaAsync(connection, mediaOperation == "rebuild", mediaSite,
                        privateMediaRoot, publicMediaRoot, mediaWebRoot, token);
                    break;
                case ["site-subscription", "issue-cancel", var channel]:
                    await IssueSubscriptionCancelAsync(connection, channel, token);
                    break;
                case ["admin-identity", .. var adminArguments]:
                    await AdminIdentityAsync(connection, adminArguments, token);
                    break;
                case ["operator", var name]:
                    await IssueAsync(connection, name, create: true, token);
                    break;
                case ["operator", var name, "--reader"]:
                    await IssueAsync(connection, name, create: true, token);
                    break;
                case ["ticket", var name]:
                    await IssueAsync(connection, name, create: false, token);
                    break;
                case ["revoke", var name]:
                    await RevokeAsync(connection, name, token);
                    break;
                case ["notify", var recipient, var eventId]:
                    await NotifyAsync(connection, recipient, eventId, Console.OpenStandardInput(), token);
                    break;
                case ["comment", "handle", var account, var displayName]:
                    await CommentMaintenance.AssignHandle(connection, account, displayName, token);
                    break;
                case ["comment", "policy", var article, var state]:
                    await CommentMaintenance.SetArticlePolicy(connection, article, state, token);
                    break;
                case ["comment", "moderate", var article, var comment, var expected, var decision, var reason]:
                    await CommentMaintenance.Moderate(connection, article, comment, expected, decision, reason, token);
                    break;
                default:
                    throw new ArgumentException("Unrecognized arguments. Run with --help for usage.");
            }

            return 0;
        }
        catch (OperationCanceledException) when (cancelled.IsCancellationRequested)
        {
            Console.Error.WriteLine("Database command cancelled.");
            return 130;
        }
        catch (PostgresException error)
        {
            Console.Error.WriteLine($"PostgreSQL rejected the operation ({error.SqlState}): {error.MessageText}");
            return 1;
        }
        catch (Exception error) when (error is InvalidOperationException or NpgsqlException or IOException or
            UnauthorizedAccessException or JsonException or ArgumentException)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
        finally
        {
            Console.CancelKeyPress -= cancel;
        }
    }

    private static async Task PlanAsync(NpgsqlConnection connection, CancellationToken token)
    {
        await using var transaction = await BeginReadOnlyAsync(connection, token);
        await RequireEmptyAsync(connection, transaction, token);
        var target = await ReadTargetAsync(connection, transaction, token);
        var schema = await SchemaSqlAsync(token);
        await transaction.CommitAsync(token);
        Console.WriteLine(JsonSerializer.Serialize(new BootstrapPlan(CurrentSchema.Version, target, Digest(schema)), Json));
    }

    private static async Task ApplyAsync(NpgsqlConnection connection, string path, CancellationToken token)
    {
        var planJson = await File.ReadAllTextAsync(path, token);
        var plan = JsonSerializer.Deserialize<BootstrapPlan>(planJson, Json) ??
            throw new InvalidOperationException("Expected a fresh-schema plan.");
        var schema = await SchemaSqlAsync(token);
        if (plan.Version != CurrentSchema.Version || plan.SchemaSha256 != Digest(schema))
            throw new InvalidOperationException("The plan targets a different schema artifact. Generate a fresh plan.");

        await using var transaction = await connection.BeginTransactionAsync(token);
        await ExecuteAsync(connection, transaction, "SET LOCAL search_path TO pg_catalog", token);
        await ExecuteAsync(connection, transaction, BootstrapLock, token);
        if (plan.Target != await ReadTargetAsync(connection, transaction, token))
            throw new InvalidOperationException("The plan targets a different database.");

        await RequireEmptyAsync(connection, transaction, token);
        await ExecuteAsync(connection, transaction, schema, token);
        if (!await CurrentSchema.HasCommentAuthorDeleteSchemaAsync(connection, transaction, token))
            throw new InvalidOperationException("Comment author deletion schema was not installed.");
        if (!await CurrentSchema.HasCommentAppealSchemaAsync(connection, transaction, token))
            throw new InvalidOperationException("Comment appeal schema was not installed.");
        if (!await CurrentSchema.HasCommentReplySchemaAsync(connection, transaction, token))
            throw new InvalidOperationException("Comment reply notice schema was not installed.");
        if (!await CurrentSchema.HasSitePasskeyNamesAsync(connection, transaction, token))
            throw new InvalidOperationException("The site Passkey names schema was not installed.");
        if (!await CurrentSchema.HasAuthoringWorkspaceLayoutAsync(connection, transaction, token))
            throw new InvalidOperationException("Authoring workspace layout was not installed.");
        if (!await CurrentSchema.HasArticleBodyInsertionOperationsAsync(connection, transaction, token))
            throw new InvalidOperationException("Article body insertion operations were not installed.");
        if (!await CurrentSchema.HasArticleBodyEditsAsync(connection, transaction, token))
            throw new InvalidOperationException("Article body edits were not installed.");
        await CurrentSchema.VerifyCatalogAsync(connection, transaction, token, new CatalogVerificationOptions
        {
            Site = new()
            {
                Subscription = true,
                RecoveryKey = true,
                Refresh = true,
                PageEditor = true,
                ConfigEditor = true,
                AppearanceActivation = true
            },
            AdminInbox = new()
            {
                Reply = true,
                Status = true,
                Notice = true,
                Read = true
            },
            AdminContent = new()
            {
                TagMetadata = true,
                CategoryMetadata = true,
                ArticleRollback = true
            },
            Comments = new()
            {
                RootPowPolicy = true,
                AuthorEdit = true,
                Report = true,
                AdminBatch = true
            },
            Authoring = new()
            {
                Workspace = true,
                WorkspaceGroups = true,
                SavedViews = true,
                SavedViewPlacement = true,
                RecentOpens = true,
                ArticleSummary = true,
                DocumentExports = true
            },
            AuthorText = new()
            {
                Index = true,
                SummaryIndex = true,
                HeadingIndex = true,
                PropertyIndex = true,
                Rebuild = true
            },
            Media = new()
            {
                ArticleMedia = true,
                PublicationMedia = true
            },
            Publication = new()
            {
                Canonical = true,
                Proof = true,
                Transparency = true,
                Head = true,
                ArticleRead = true
            }
        });
        await ExecuteAsync(connection, transaction,
            $"INSERT INTO public.v2_schema (singleton, version) VALUES (true, {CurrentSchema.Version})", token);
        await transaction.CommitAsync(token);
        Console.WriteLine($"Applied FsusBlog V2 schema version {CurrentSchema.Version}.");
    }

    private static async Task<NpgsqlTransaction> BeginStoppedOperationAsync(NpgsqlConnection db, CancellationToken ct)
    {
        var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        try
        {
            await PrepareStoppedOperationAsync(db, tx, ct);
            return tx;
        }
        catch
        {
            await tx.DisposeAsync();
            throw;
        }
    }

    private static async Task PrepareStoppedOperationAsync(NpgsqlConnection connection, NpgsqlTransaction tx, CancellationToken ct)
    {
        await ExecuteAsync(connection, tx, "SET LOCAL search_path TO pg_catalog", ct);
        await ExecuteAsync(connection, tx, BootstrapLock, ct);
        await using (var acquire = new NpgsqlCommand($"select pg_try_advisory_xact_lock({PublicationLocks.Ownership})", connection, tx))
            if (await acquire.ExecuteScalarAsync(ct) is not true)
                throw new InvalidOperationException("Stop the serving process before changing the database schema.");
        await using (var handoff = new NpgsqlCommand("select pg_catalog.pg_advisory_xact_lock($1,$2)", connection, tx))
        {
            handoff.Parameters.AddWithValue(PublicationLocks.HandoffClass);
            handoff.Parameters.AddWithValue(PublicationLocks.HandoffObject);
            await handoff.ExecuteNonQueryAsync(ct);
        }

        await using var marker = new NpgsqlCommand("select version from public.v2_schema", connection, tx);
        await using var reader = await marker.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct) || reader.GetInt32(0) != CurrentSchema.Version || await reader.ReadAsync(ct))
            throw new InvalidOperationException("The database is not on the expected v2 schema revision.");
    }

    private static async Task IssueAsync(NpgsqlConnection connection, string name, bool create, CancellationToken token)
    {
        CheckName(name);
        await CurrentSchema.VerifyAsync(connection, token);
        await using var transaction = await connection.BeginTransactionAsync(token);
        Guid userId;
        if (create)
        {
            userId = Guid.NewGuid();
            await using var insertUser = new NpgsqlCommand("""
                INSERT INTO public.blog_user (id, name, enabled, generation)
                VALUES ($1, $2, true, 1)
                """, connection, transaction);
            insertUser.Parameters.Add(new NpgsqlParameter<Guid> { TypedValue = userId });
            insertUser.Parameters.Add(new NpgsqlParameter<string> { TypedValue = name });
            await insertUser.ExecuteNonQueryAsync(token);
        }
        else
        {
            userId = await FindUserAsync(connection, transaction, name, requireEnabled: true, token);
            if (await CurrentSchema.RequiresSiteRecoveryAsync(connection, transaction, userId, token))
                throw new InvalidOperationException("This account must use its Recovery Key.");
        }

        await using var ticket = new NpgsqlCommand("""
            INSERT INTO public.login_ticket (digest, user_id, expires_at)
            VALUES ($1, $2, pg_catalog.clock_timestamp() + interval '10 minutes')
            """, connection, transaction);
        var secret = RandomNumberGenerator.GetBytes(32);
        try
        {
            ticket.Parameters.Add(new NpgsqlParameter<byte[]> { TypedValue = SHA256.HashData(secret) });
            ticket.Parameters.Add(new NpgsqlParameter<Guid> { TypedValue = userId });
            await ticket.ExecuteNonQueryAsync(token);
            await transaction.CommitAsync(token);
            Console.WriteLine(Convert.ToHexStringLower(secret));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(secret);
        }
    }

    private static async Task RevokeAsync(NpgsqlConnection connection, string name, CancellationToken token)
    {
        CheckName(name);
        await CurrentSchema.VerifyAsync(connection, token);
        await using var transaction = await connection.BeginTransactionAsync(token);
        var userId = await FindUserAsync(connection, transaction, name, requireEnabled: false, token);
        await using var revoke = new NpgsqlBatch(connection, transaction);
        foreach (var statement in new[]
        {
            "UPDATE public.blog_user SET generation = generation + 1 WHERE id = $1",
            "DELETE FROM public.login_ticket WHERE user_id = $1",
            "DELETE FROM public.user_session WHERE user_id = $1"
        })
        {
            var command = new NpgsqlBatchCommand(statement);
            command.Parameters.Add(new NpgsqlParameter<Guid> { TypedValue = userId });
            revoke.BatchCommands.Add(command);
        }

        await revoke.ExecuteNonQueryAsync(token);
        await transaction.CommitAsync(token);
        Console.WriteLine("Revoked sessions and unused login tickets.");
    }

    private static async Task<Guid> FindUserAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        string name, bool requireEnabled, CancellationToken token)
    {
        await using var find = new NpgsqlCommand("""
            SELECT id FROM public.blog_user WHERE name = $1 AND (NOT $2 OR enabled) FOR UPDATE
            """, connection, transaction);
        find.Parameters.Add(new NpgsqlParameter<string> { TypedValue = name });
        find.Parameters.Add(new NpgsqlParameter<bool> { TypedValue = requireEnabled });
        return await find.ExecuteScalarAsync(token) is Guid id
            ? id
            : throw new InvalidOperationException("No matching user can perform this operation.");
    }

    private static void CheckName(string name)
    {
        if (name.Length is < 1 or > 96 || name != name.Trim() || name.Any(char.IsControl))
            throw new ArgumentException("Expected a trimmed operator name of 1 to 96 characters without control characters.");
    }

    private static async Task<NpgsqlTransaction> BeginReadOnlyAsync(NpgsqlConnection connection, CancellationToken token)
    {
        var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, token);
        try
        {
            await ExecuteAsync(connection, transaction, "SET TRANSACTION READ ONLY; SET LOCAL search_path TO pg_catalog", token);
            return transaction;
        }
        catch
        {
            await transaction.DisposeAsync();
            throw;
        }
    }

    private static async Task<DatabaseTarget> ReadTargetAsync(NpgsqlConnection connection,
        NpgsqlTransaction transaction, CancellationToken token)
    {
        await using var command = new NpgsqlCommand("""
            SELECT oid::bigint, datname, pg_catalog.pg_postmaster_start_time()
            FROM pg_catalog.pg_database
            WHERE datname = pg_catalog.current_database()
            """, connection, transaction);
        await using var reader = await command.ExecuteReaderAsync(token);
        if (!await reader.ReadAsync(token))
            throw new InvalidOperationException("Could not identify the target database.");

        return new DatabaseTarget(connection.Host ?? "", connection.Port, reader.GetInt64(0), reader.GetString(1),
            reader.GetFieldValue<DateTime>(2));
    }

    private static async Task RequireEmptyAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        CancellationToken token)
    {
        if ((await RelationsAsync(connection, transaction, token)).Count != 0)
            throw new InvalidOperationException("Fresh schema creation requires an empty database. Inspect with inventory.");
    }

    private static async Task<List<Relation>> RelationsAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        CancellationToken token)
    {
        await using var command = new NpgsqlCommand("""
            SELECT n.nspname, c.relname, c.relkind::text
            FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
              AND n.nspname !~ '^pg_(toast|temp)'
              AND c.relkind NOT IN ('i', 'I')
            ORDER BY n.nspname, c.relname
            """, connection, transaction);
        await using var reader = await command.ExecuteReaderAsync(token);
        var relations = new List<Relation>();
        while (await reader.ReadAsync(token))
            relations.Add(new Relation(reader.GetString(0), reader.GetString(1), reader.GetString(2)));

        return relations;
    }

    private static async Task ExecuteAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        string sql, CancellationToken token)
    {
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        await command.ExecuteNonQueryAsync(token);
    }

    private static async Task<string> SchemaSqlAsync(CancellationToken token)
    {
        var assembly = Assembly.GetExecutingAssembly();
        var resources = assembly.GetManifestResourceNames()
            .Where(name => name.StartsWith(SchemaResourcePrefix, StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (resources.Length == 0)
            throw new InvalidOperationException("Embedded PostgreSQL schema resources are missing.");
        var sql = new StringBuilder();
        foreach (var resource in resources)
        {
            await using var stream = assembly.GetManifestResourceStream(resource) ??
                throw new InvalidOperationException($"Schema resource {resource} is missing.");
            using var reader = new StreamReader(stream);
            sql.Append(await reader.ReadToEndAsync(token)).Append('\n');
        }

        return sql.ToString();
    }

    private static string Digest(string sql) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(sql)));

    private sealed record Relation(string Schema, string Name, string Kind);
    private sealed record DatabaseTarget(string Host, int Port, long DatabaseOid, string Database, DateTime ServerStartedAtUtc);
    private sealed record BootstrapPlan(int Version, DatabaseTarget Target, string SchemaSha256);
}
