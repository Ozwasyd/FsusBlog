using System.Data;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlogV2.Storage;
using FsusBlogV2.Migrate;
using Npgsql;

return await (PlatformPluginCommand.IsWorker(args) ? PlatformPluginCommand.Worker() : Migration.RunAsync(args));

internal static partial class Migration
{
    private const string DatabaseVariable = "FSUSBLOG_DB";
    private const string SchemaResourcePrefix = "FsusBlogV2.Schema.";
    private const string BootstrapLock = "SELECT pg_catalog.pg_advisory_xact_lock(4815262471654073021)";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    internal static async Task<int> RunAsync(string[] arguments)
    {
        if (arguments is ["help"] or ["--help"] or [])
        {
            Console.WriteLine("""
                FsusBlog V2 offline database tool
                Set FSUSBLOG_DB to the Npgsql connection string.
                  inventory              Read PostgreSQL relations, columns and keys from the target
                  inventory --counts     Include exact row counts for each ordinary business relation
                  plan                   Print a fresh-schema plan without changing the database
                  apply PLAN.json        Apply that plan atomically to an empty database
                  verify                 Check the current marker, shape and publication coordinates
                  canvas-graph check|apply-empty
                                        Inspect preview Canvas provenance or upgrade its exact empty schema offline
                  recovery-scope         Initialize the durable draft recovery site ID on a matching existing database
                  recovery-key schema    Add site Recovery Key storage with the server stopped
                  site-page-editor schema
                                        Add optional site page publication storage with the server stopped
                  appearance schema      Add signed appearance activation storage with the server stopped
                  site-refresh schema    Add site refresh storage with the server stopped
                  revision-history      Add rollback provenance to a matching existing database with the server stopped
                  publication-history   Retain current publication coordinates and add event history with the server stopped
                  publication-rights    Add rights storage while leaving missing publication rights private
                  publication-canonical schema
                                        Install native publication canonical storage offline, without backfill
                  publication-canonical verify [PUBLICATION_ID]
                                        Recompute native publication digests from retained PostgreSQL facts
                  publication-proof schema  Add native proof storage with the server stopped
                  publication-transparency enable
                                        Start a native proof issuance ledger from an empty genesis
                  publication-transparency head-schema
                                        Install optional native public head storage with the server stopped
                  publication-transparency checkpoint-release HTTPS_ORIGIN KEYS_JSON HEAD_JSON RELEASE_ID FROM_SEQ TO_SEQ [INCLUDE_SEQ]
                                        Sign a release checkpoint from a pinned native log with the server stopped
                  publication-transparency checkpoint-daily HTTPS_ORIGIN KEYS_JSON HEAD_JSON YYYY-MM-DD [INCLUDE_SEQ]
                                        Sign a closed UTC day within the witnessed native log prefix
                  publication-transparency verify HTTPS_ORIGIN KEYS_JSON [PREFIX_SEQ PREFIX_SHA256]
                                        Verify a local issuance ledger with a trusted public key manifest
                  admin-article-rollback schema
                                        Add independent published rollback storage with the server stopped
                  article-responsibility record ARTICLE REVISION
                                        Record explicit historical responsibility JSON from stdin
                  article-schedule      Add pending publication and command receipts with the server stopped
                  article read-proof-schema
                                        Add optional article read aggregates with the server stopped
                  private-media-upload schema
                                        Add private resumable upload staging with the server stopped
                  article-private-media Add article revision attachment storage with the server stopped
                  article-public-media  Add explicit publication attachment storage with the server stopped
                  article-public-media verify|rebuild SITE_UUID PRIVATE_ROOT PUBLIC_ROOT WEB_ROOT
                                        Check historical image objects or rebuild missing objects from retained private bytes
                  authoring-workspace Add private workspace layout storage with the server stopped
                  author-recent-opens Add private recent article opens with the server stopped
                  saved-views          Add private author saved views with the server stopped
                  tag-metadata        Add the administrator tag metadata schema with the server stopped
                  admin-inbox-replies   Add administrator reply attribution with the server stopped
                  admin-inbox-status    Add administrator status auditing with the server stopped
                  admin-inbox-notice    Add targeted administrator notice auditing with the server stopped
                  admin-inbox-read      Add shared administrator inbox read tracking with the server stopped
                  site-subscription schema
                                        Add optional subscription storage with the server stopped
                  site-subscription issue-cancel rss|email
                                        Issue a short-lived cancellation proof for an email read from stdin
                  admin-identity schema Add the independent administrator schema with the server stopped
                  admin-identity bootstrap HANDLE admin.manage
                                        Create an administrator and issue a one-use Passkey invitation
                  admin-identity grant|revoke HANDLE audit.read|comment.moderate|article.write|system.config
                                        Change an administrator permission and retire the prior session
                  admin-identity rotate-passkey HANDLE
                                        Revoke existing administrator access and issue a replacement invitation
                  admin-identity revoke-all HANDLE
                                        End administrator sessions and cancel pending invitations
                  admin-identity disable HANDLE
                                        Disable an administrator and remove authentication credentials
                  operator NAME         Create an author and issue an expiring one-use login ticket
                  operator NAME --reader
                                        Create a reader and issue an expiring one-use login ticket
                  ticket NAME           Issue a new expiring one-use ticket for an existing enabled user
                  revoke NAME           End all sessions and pending tickets for an existing user
                  notify ACCOUNT_ID EVENT_ID
                                        Send an idempotent system notice from a UTF-8 JSON object on stdin
                  comment author-delete-schema  Add signed-in comment deletion storage with the server stopped
                  comment author-edit-schema  Add signed-in comment edit storage with the server stopped
                  comment report-schema  Add signed-in comment report storage with the server stopped
                  comment appeal-schema  Add signed-in comment appeals with the server stopped
                  comment replies-schema  Add signed-in comment reply notices with the server stopped
                  comment bulk-schema    Add administrator comment batch moderation storage with the server stopped
                  comment handle ACCOUNT_ID DISPLAY_NAME
                                        Assign an explicit public comment display name to an enabled account
                  comment policy ARTICLE_ID enable|disable
                                        Allow or deny moderated public submissions on the article
                  comment moderate ARTICLE_ID COMMENT_ID EXPECTED_STATUS approve|reject|hide REASON
                                        Change comment status and append the trusted database role audit event
                  extension --help      Manage an offline signed authoring extension store
                  platform-plugin --help
                                        Invoke one approved pure Markdown hook in an offline worker
                  backup measure        Fingerprint an offline v2 PostgreSQL site and its media metadata
                  legacy inventory postgres|mysql|sqlite
                                        Inspect the v1 article catalog and exact table counts
                  legacy plan postgres|mysql|sqlite
                                        Audit v1 article coordinates and report import blockers
                  legacy rehearse postgres|mysql|sqlite OWNER_MAP.json
                                        Transform and verify article rows in a disposable offline database
                  legacy import plan PROVIDER OWNER_MAP.json BACKUP_DIR MANIFEST_SHA256
                  legacy import apply PROVIDER OWNER_MAP.json BACKUP_DIR MANIFEST_SHA256 PLAN.json
                                        Validate and stage supported v1 rows into FSUSBLOG_IMPORT_DB
                  legacy import project|verify PLAN.json PLAN_SHA256 BACKUP_DIR MANIFEST_SHA256
                                        Project or verify staged articles under permanent quarantine
                                        Add --evaluate-schedules-at UTC to retain original first-release schedules as evidence
                  legacy assets PROVIDER PUBLIC_ROOT PRIVATE_ROOT
                                        Verify frozen legacy attachment metadata, references and file bytes
                  legacy assets rehearsal plan PROVIDER PUBLIC_ROOT PRIVATE_ROOT SOURCE_SITE_UUID TARGET_SITE_UUID
                  legacy assets rehearsal copy PROVIDER PUBLIC_ROOT PRIVATE_ROOT REVIEWED_JSON REVIEWED_SHA256 OUTPUT_PARENT NAME
                  legacy assets rehearsal verify PACKAGE MANIFEST_SHA256
                                        Rehearse an offline, quarantined attachment copy
                  legacy identity PROVIDER
                                        Audit account and administrator compatibility without activating credentials
                  legacy admin plan PROVIDER SOURCE_SITE_UUID TARGET_SITE_UUID BACKUP_DIR MANIFEST_SHA256 ADMIN_ID...
                  legacy admin stage REVIEW_JSON REVIEW_SHA256 BACKUP_DIR MANIFEST_SHA256
                  legacy admin verify REVIEW_JSON REVIEW_SHA256 BACKUP_DIR MANIFEST_SHA256 CANDIDATE_SHA256
                                        Rehearse reviewed administrator identities without enabling login
                """);
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
            if (arguments is ["legacy", "assets", var assetProvider, var publicAssets, var privateAssets])
                return await VerifyLegacyAssetsAsync(assetProvider, publicAssets, privateAssets, cancelled.Token);
            if (arguments is ["legacy", "assets", "rehearsal", .. var mediaArguments])
                return await RunLegacyMediaRehearsalAsync(mediaArguments, cancelled.Token);
            if (arguments is ["legacy", "identity", var identityProvider])
                return await VerifyLegacyIdentityAsync(identityProvider, cancelled.Token);
            if (arguments is ["legacy", "admin", .. var legacyAdminArguments])
                return await RunLegacyAdminRehearsalAsync(legacyAdminArguments, cancelled.Token);
            if (arguments is ["legacy", "import", .. var importArguments])
            {
                return await RunLegacyImportAsync(importArguments, cancelled.Token);
            }
            if (arguments is ["backup", "measure"] or ["backup", "measure", "--hold-snapshot"])
            {
                return await MeasureBackupAsync(arguments.Length == 3, cancelled.Token);
            }
            if (arguments is ["extension", .. var extensionArguments])
            {
                return await ExtensionMaintenance.RunAsync(extensionArguments, cancelled.Token);
            }
            if (arguments is ["legacy", var mode, var provider])
            {
                return await RunLegacyAsync(mode, provider, ownerMap: null, cancelled.Token);
            }
            if (arguments is ["legacy", "rehearse", var rehearsalProvider, var ownerMap])
            {
                return await RunLegacyAsync("rehearse", rehearsalProvider, ownerMap, cancelled.Token);
            }

            var connectionString = Environment.GetEnvironmentVariable(DatabaseVariable);
            if (string.IsNullOrWhiteSpace(connectionString))
            {
                throw new ArgumentException($"Set {DatabaseVariable} before using the database tool.");
            }

            var connectionSettings = new NpgsqlConnectionStringBuilder(connectionString);
            if (string.IsNullOrWhiteSpace(connectionSettings.Database))
            {
                throw new ArgumentException($"Set the database name explicitly in {DatabaseVariable}.");
            }

            var token = cancelled.Token;
            await using var connection = new NpgsqlConnection(connectionString);
            await connection.OpenAsync(token);
            switch (arguments)
            {
                case ["inventory"]:
                    await WriteInventoryAsync(connection, countRows: false, token);
                    break;
                case ["inventory", "--counts"]:
                    await WriteInventoryAsync(connection, countRows: true, token);
                    break;
                case ["plan"]:
                    await PlanAsync(connection, token);
                    break;
                case ["apply", var path]:
                    await ApplyAsync(connection, path, token);
                    break;
                case ["verify"]:
                    await CurrentSchema.VerifyAsync(connection, token);
                    await VerifyPublicationsAsync(connection, token);
                    Console.WriteLine($"Verified FsusBlog V2 schema version {CurrentSchema.Version}.");
                    break;
                case ["canvas-graph", "check"]:
                    await CheckCanvasGraphAsync(connection, token);
                    break;
                case ["canvas-graph", "apply-empty"]:
                    await UpgradeEmptyCanvasGraphAsync(connection, token);
                    break;
                case ["recovery-scope"]:
                    await InitializeRecoveryScopeAsync(connection, token);
                    break;
                case ["recovery-key", "schema"]:
                    await InitializeSiteRecoveryKeyAsync(connection, token);
                    break;
                case ["appearance", "schema"]:
                    await InitializeAppearanceActivationAsync(connection, token);
                    break;
                case ["site-refresh", "schema"]:
                    await InitializeSiteRefreshAsync(connection, token);
                    break;
                case ["site-page-editor", "schema"]:
                    await InitializeSitePageEditorAsync(connection, token);
                    break;
                case ["revision-history"]:
                    await InitializeRevisionHistoryAsync(connection, token);
                    break;
                case ["publication-history"]:
                    await InitializePublicationHistoryAsync(connection, token);
                    break;
                case ["publication-rights"]:
                    await InitializePublicationRightsAsync(connection, token);
                    break;
                case ["publication-canonical", "schema"]:
                    await InitializePublicationCanonicalAsync(connection, token);
                    break;
                case ["publication-canonical", "verify"]:
                    await VerifyPublicationCanonicalAsync(connection, null, token);
                    break;
                case ["publication-canonical", "verify", var canonicalPublication]:
                    await VerifyPublicationCanonicalAsync(connection, canonicalPublication, token);
                    break;
                case ["publication-proof", "schema"]:
                    await InitializePublicationProofAsync(connection, token);
                    break;
                case ["publication-transparency", "enable"]:
                    await EnablePublicationTransparencyAsync(connection, token);
                    break;
                case ["publication-transparency", "head-schema"]:
                    await InitializePublicationHeadAsync(connection, token);
                    break;
                case ["publication-transparency", "checkpoint-release", .. var checkpointArgs]:
                    await CreatePublicationCheckpointAsync(connection, checkpointArgs, PublicationCheckpointKind.Release, token);
                    break;
                case ["publication-transparency", "checkpoint-daily", .. var dailyCheckpointArgs]:
                    await CreatePublicationCheckpointAsync(connection, dailyCheckpointArgs, PublicationCheckpointKind.Daily, token);
                    break;
                case ["publication-transparency", "verify", var transparencyOrigin, var transparencyKeys, .. var transparencyAnchor]:
                    await VerifyPublicationTransparencyAsync(connection, transparencyOrigin, transparencyKeys, transparencyAnchor, token);
                    break;
                case ["admin-article-rollback", "schema"]:
                    await InitializeAdminArticleRollbackAsync(connection, token);
                    break;
                case ["article-responsibility", "record", var responsibilityArticle, var responsibilityRevision]:
                    await RecordArticleResponsibilityAsync(connection, responsibilityArticle, responsibilityRevision, token);
                    break;
                case ["article-schedule"]:
                    await InitializeArticleScheduleAsync(connection, token);
                    break;
                case ["article", "read-proof-schema"]:
                    await InitializeArticleReadSchemaAsync(connection, token);
                    break;
                case ["private-media-upload", "schema"]:
                    await InitializeMediaUploadAsync(connection, token);
                    break;
                case ["article-private-media"]:
                    await InitializeArticleMediaAsync(connection, token);
                    break;
                case ["article-public-media"]:
                    await InitializePublicationMediaAsync(connection, token);
                    break;
                case ["article-public-media", var mediaOperation, var mediaSite, var privateMediaRoot, var publicMediaRoot, var mediaWebRoot]
                    when mediaOperation is "verify" or "rebuild":
                    await VerifyOrRebuildPublicationMediaAsync(connection, mediaOperation == "rebuild", mediaSite,
                        privateMediaRoot, publicMediaRoot, mediaWebRoot, token);
                    break;
                case ["authoring-workspace"]:
                    await InitializeAuthoringWorkspaceAsync(connection, token);
                    break;
                case ["author-recent-opens"]:
                    await InitializeAuthorRecentOpensAsync(connection, token);
                    break;
                case ["saved-views"]:
                    await InitializeSavedViewsAsync(connection, token);
                    break;
                case ["tag-metadata"]:
                    await InitializeAdminTagMetadataAsync(connection, token);
                    break;
                case ["admin-inbox-replies"]:
                    await InitializeAdminInboxRepliesAsync(connection, token);
                    break;
                case ["admin-inbox-status"]:
                    await InitializeAdminInboxStatusAsync(connection, token);
                    break;
                case ["admin-inbox-notice"]:
                    await InitializeAdminInboxNoticeAsync(connection, token);
                    break;
                case ["admin-inbox-read"]:
                    await InitializeAdminInboxReadAsync(connection, token);
                    break;
                case ["site-subscription", "schema"]:
                    await InitializeSiteSubscriptionAsync(connection, token);
                    break;
                case ["site-subscription", "issue-cancel", var channel]:
                    await IssueSubscriptionCancelAsync(connection, channel, token);
                    break;
                case ["admin-identity", .. var adminArguments]:
                    await AdminIdentityAsync(connection, adminArguments, token);
                    break;
                case ["operator", var name]:
                    await IssueAsync(connection, name, create: true, author: true, token);
                    break;
                case ["operator", var name, "--reader"]:
                    await IssueAsync(connection, name, create: true, author: false, token);
                    break;
                case ["ticket", var name]:
                    await IssueAsync(connection, name, create: false, author: false, token);
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
                case ["comment", "author-delete-schema"]:
                    await InitializeCommentAuthorDeleteAsync(connection, token);
                    break;
                case ["comment", "author-edit-schema"]:
                    await InitializeCommentAuthorEditAsync(connection, token);
                    break;
                case ["comment", "report-schema"]:
                    await InitializeCommentReportAsync(connection, token);
                    break;
                case ["comment", "appeal-schema"]:
                    await InitializeCommentAppealAsync(connection, token);
                    break;
                case ["comment", "replies-schema"]:
                    await InitializeCommentReplyAsync(connection, token);
                    break;
                case ["comment", "bulk-schema"]:
                    await InitializeAdminCommentBatchAsync(connection, token);
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
        {
            throw new InvalidOperationException("The plan targets a different schema artifact. Generate a fresh plan.");
        }

        await using var transaction = await connection.BeginTransactionAsync(token);
        await ExecuteAsync(connection, transaction, "SET LOCAL search_path TO pg_catalog", token);
        await ExecuteAsync(connection, transaction, BootstrapLock, token);
        if (plan.Target != await ReadTargetAsync(connection, transaction, token))
        {
            throw new InvalidOperationException("The plan targets a different database.");
        }

        await RequireEmptyAsync(connection, transaction, token);
        await ExecuteAsync(connection, transaction, schema, token);
        if (!await CurrentSchema.HasCommentAuthorDeleteSchemaAsync(connection, transaction, token))
            throw new InvalidOperationException("Comment author deletion schema was not installed.");
        if (!await CurrentSchema.HasCommentAppealSchemaAsync(connection, transaction, token))
            throw new InvalidOperationException("Comment appeal schema was not installed.");
        if (!await CurrentSchema.HasCommentReplySchemaAsync(connection, transaction, token))
            throw new InvalidOperationException("Comment reply notice schema was not installed.");
        if (!await CurrentSchema.HasAuthoringWorkspaceLayoutAsync(connection, transaction, token))
            throw new InvalidOperationException("Authoring workspace layout was not installed.");
        await CurrentSchema.VerifyCatalogAsync(connection, transaction, token, requireArticleMedia: true,
            requireSubscription: true, requireRecoveryKey: true, requireAuthoringWorkspace: true, requireAdminInboxReply: true, requireAdminInboxStatus: true, requireAdminInboxNotice: true, requireAdminInboxRead: true, requireSiteRefresh: true,
            requireSitePageEditor: true, requireAdminArticleRollback: true, requireSavedViews: true, requireSavedViewPlacement: true, requireAdminTagMetadata: true,
            requireAppearanceActivation: true, requireAuthorRecentOpens: true, requirePublicationCanonical: true, requirePublicationProof: true, requirePublicationMedia: true,
            requireAuthoringWorkspaceGroups: true, requireAdminCommentBatch: true, requireArticleRead: true,
            requirePublicationTransparency: true, requirePublicationHead: true, requireCommentAuthorEdit: true, requireCommentReport: true);
        await ExecuteAsync(connection, transaction,
            $"INSERT INTO public.v2_schema (singleton, version) VALUES (true, {CurrentSchema.Version})", token);
        await transaction.CommitAsync(token);
        Console.WriteLine($"Applied FsusBlog V2 schema version {CurrentSchema.Version}.");
    }

    private static async Task VerifyPublicationsAsync(NpgsqlConnection connection, CancellationToken token)
    {
        await using var transaction = await BeginReadOnlyAsync(connection, token);
        await VerifyActivePublicationsAsync(connection, transaction, token);
        await ReportMissingPublicationRights(connection, transaction, token);
        await VerifyPublicationHistoryAsync(connection, transaction, token);
        await VerifyArticleScheduleAsync(connection, transaction, token);
        await VerifyPublicationMediaAsync(connection, transaction, token);
        await using (var pending = new NpgsqlCommand("""
            select count(*) from public.article a where a.publication_count>0 and not exists (
                select from public.article_publication_history h where h.article_id=a.id
            )
            """, connection, transaction))
            if (await pending.ExecuteScalarAsync(token) is long count && count != 0)
                Console.WriteLine($"Publication history has {count} articles awaiting a retained boundary. Run publication-history after direct imports.");
        await transaction.CommitAsync(token);
    }

    private static async Task VerifyActivePublicationsAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        CancellationToken token)
    {
        await using var command = new NpgsqlCommand("""
            SELECT a.id
            FROM public.article a LEFT JOIN public.article_publication p ON a.id = p.article_id
            WHERE a.published_revision IS DISTINCT FROM p.revision
               OR (p.publication_id IS NOT NULL AND p.publication_no <> a.publication_count)
               OR (a.deleted AND p.article_id IS NOT NULL)
            LIMIT 1
            """, connection, transaction);
        if (await command.ExecuteScalarAsync(token) is int id)
        {
            throw new InvalidOperationException($"Article {id} has inconsistent publication coordinates.");
        }

    }

    private static async Task IssueAsync(NpgsqlConnection connection, string name, bool create, bool author,
        CancellationToken token)
    {
        CheckName(name);
        await CurrentSchema.VerifyAsync(connection, token);
        await using var transaction = await connection.BeginTransactionAsync(token);
        Guid userId;
        if (create)
        {
            userId = Guid.NewGuid();
            await using var insertUser = new NpgsqlCommand("""
                INSERT INTO public.blog_user (id, name, can_author, enabled, generation)
                VALUES ($1, $2, $3, true, 1)
                """, connection, transaction);
            insertUser.Parameters.Add(new NpgsqlParameter<Guid> { TypedValue = userId });
            insertUser.Parameters.Add(new NpgsqlParameter<string> { TypedValue = name });
            insertUser.Parameters.Add(new NpgsqlParameter<bool> { TypedValue = author });
            await insertUser.ExecuteNonQueryAsync(token);
        }
        else
        {
            userId = await FindUserAsync(connection, transaction, name, requireEnabled: true, token);
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
        {
            throw new ArgumentException("Expected a trimmed operator name of 1 to 96 characters without control characters.");
        }
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
        {
            throw new InvalidOperationException("Could not identify the target database.");
        }

        return new DatabaseTarget(connection.Host ?? "", connection.Port, reader.GetInt64(0), reader.GetString(1),
            reader.GetFieldValue<DateTime>(2));
    }

    private static async Task RequireEmptyAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        CancellationToken token)
    {
        if ((await RelationsAsync(connection, transaction, token)).Count != 0)
        {
            throw new InvalidOperationException("Fresh schema creation requires an empty database. Inspect with inventory.");
        }
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
        {
            relations.Add(new Relation(reader.GetString(0), reader.GetString(1), reader.GetString(2)));
        }

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
        var bootstrap = SchemaResourcePrefix + "schema-1.sql";
        var resources = assembly.GetManifestResourceNames()
            .Where(name => name.StartsWith(SchemaResourcePrefix, StringComparison.Ordinal))
            .Order(StringComparer.Ordinal);
        var sql = new StringBuilder();
        foreach (var resource in resources.Prepend(bootstrap).Distinct(StringComparer.Ordinal))
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
