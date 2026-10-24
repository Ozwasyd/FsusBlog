using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using Npgsql;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;

namespace FsusBlog.Migration;

// Native historical value transforms, not a second current schema descriptor.
// Entity property owners and all physical names/types/defaults come from the
// actual current owner artifact retained by the structural-stage capability.
internal sealed partial class PgLegacyNonArticlePreparation
{
    private readonly PgLegacyCurrentSchemaPreparation? _stage;
    private readonly OwnedCurrentSchemaTarget _owned;
    private readonly OfflineMigrationSourceObservation _source;
    private readonly string _schemaName;
    private readonly IReadOnlyList<LegacyTableProgram> _programs;
    private readonly LegacyTableProgram _users;
    private readonly Dictionary<string, string> _currentDigests = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _currentCounts = new(StringComparer.Ordinal);
    private bool _removed;
    private long? _userMinimumNext;

    private PgLegacyNonArticlePreparation(PgLegacyCurrentSchemaPreparation stage, IReadOnlyList<LegacyTableProgram> programs)
        : this(stage, stage.OwnedTarget, stage.OriginalSource, stage.RequireRetainedSchemaName(), programs)
    {
    }

    private PgLegacyNonArticlePreparation(PgLegacyCurrentSchemaPreparation? stage, OwnedCurrentSchemaTarget owned,
        OfflineMigrationSourceObservation source, string schemaName, IReadOnlyList<LegacyTableProgram> programs)
    {
        _stage = stage;
        _owned = owned;
        _source = source;
        _schemaName = schemaName;
        _programs = programs;
        _users = programs.Single(static program => program.Owner == EntityOwner("User"));
    }

    private PgLegacyCurrentSchemaPreparation Stage => _stage
        ?? throw new InvalidOperationException("legacy_nonarticle_recovered_capability_is_read_only");

    internal static async Task<PgLegacyNonArticlePreparation> MigrateAsync(
        PgLegacyCurrentSchemaPreparation stage, DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(stage);
        string schema = stage.RequireOriginalSession(connection, transaction);
        await stage.RevalidateSourceAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        await stage.OwnedTarget.RevalidateRetainedArtifactAsync(cancellationToken).ConfigureAwait(false);
        await stage.ReadStagedCurrentTargetAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        IReadOnlyList<LegacyTableProgram> programs = Compile(stage.OwnedTarget.ReadBoundInput(), schema);
        var result = new PgLegacyNonArticlePreparation(stage, programs);
        await result.RequireLosslessInputsAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        foreach (LegacyTableProgram program in programs)
            await RequireNoRowsAsync(connection, transaction, program.InputValidationSql,
                "legacy_current_string_cannot_be_preserved:" + program.Owner, cancellationToken).ConfigureAwait(false);
        foreach (LegacyTableProgram program in programs)
            await ExecuteAsync(connection, transaction, program.InsertSql, cancellationToken).ConfigureAwait(false);
        await result.PopulateAccountSubjectsAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        await result.RestartUserSequenceAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        await result.RevalidateAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        foreach (LegacyTableProgram program in programs)
            result._currentDigests.Add(program.Owner, await ReadCurrentDataDigestAsync(program, connection, transaction, cancellationToken,
                rows => result._currentCounts.Add(program.Owner, rows)).ConfigureAwait(false));
        return result;
    }

    internal async Task RevalidateAsync(DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        if (_removed)
            throw new InvalidOperationException("legacy_nonarticle_domain_already_removed");
        _ = Stage.RequireOriginalSession(connection, transaction);
        await _owned.RevalidateRetainedArtifactAsync(cancellationToken).ConfigureAwait(false);
        await Stage.RevalidateSourceAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        foreach (LegacyTableProgram program in _programs)
        {
            object? value = await ScalarAsync(connection, transaction, program.VerifySql, cancellationToken).ConfigureAwait(false);
            if (!Convert.ToBoolean(value, CultureInfo.InvariantCulture))
                throw new InvalidOperationException("legacy_nonarticle_readback_mismatch:" + program.Owner);
        }
        await VerifyAccountSubjectsAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        await VerifyUserSequenceAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        await Stage.ReadStagedCurrentTargetAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
    }

    // Cleanup requires the original article/media owner's privately produced
    // stage, and actively runs its native/artifact verification again. A caller
    // boolean or a receipt row count cannot authorize removal of historical data.
    internal async Task CompleteAsync(PgArticlePreservationOperation.PgArticlePreservationStage actualArticleStage,
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(actualArticleStage);
        if (!ReferenceEquals(actualArticleStage.OriginalStage, _stage) || actualArticleStage.Database != _source.Database)
            throw new InvalidOperationException("legacy_cleanup_article_stage_binding_changed");
        await actualArticleStage.RevalidateAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        await RevalidateAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        await VerifyCurrentDigestsAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        await VerifyUserSequenceAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        string schema = Stage.RequireOriginalSession(connection, transaction);
        foreach (OfflineMigrationSourceFingerprints.LegacyTable table in OfflineMigrationSourceFingerprints.LegacyTables
                     .OrderBy(static table => table.Name, StringComparer.Ordinal))
            await ExecuteAsync(connection, transaction, "DROP TABLE " + schema + "." + Quote(table.Name), cancellationToken).ConfigureAwait(false);
        // No CASCADE and no wildcard: additional/dependent objects refuse the
        // cleanup, leaving rollback and the final commit to the original core.
        await ExecuteAsync(connection, transaction, "DROP SCHEMA " + schema, cancellationToken).ConfigureAwait(false);
        _removed = true;
        await RevalidateCurrentAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
    }

    // The expected digests were captured by this private capability only after
    // complete original-source/target readback on the original transaction, not
    // loaded from a caller JSON. Cross-process reconstruction additionally needs
    // the actual committed journal and retained original producer/input bytes;
    // publication alone never creates a durable recovery grant.
    internal async Task RevalidateCurrentAsync(DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        if (!_removed)
            throw new InvalidOperationException("legacy_current_cleanup_not_completed");
        OfflineMigrationSourceObserver.RequirePostgreSqlStageSession(connection, transaction);
        var database = await OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        if (database != _source.Database)
            throw new InvalidOperationException("legacy_current_database_changed");
        await _owned.RevalidateRetainedArtifactAsync(cancellationToken).ConfigureAwait(false);
        await RevalidateRecoveryPublicationAsync(cancellationToken).ConfigureAwait(false);
        await new PgCurrentSchemaOwnedTargetObserver(_owned).ObserveAsync(connection, transaction, database, cancellationToken).ConfigureAwait(false);
        string schema = _schemaName;
        object? absent = await WithResourceAsync(Command(connection, transaction,
            "SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=@schema)"), async command =>
        {
            Parameter(command, "schema", schema);
            return await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
        }).ConfigureAwait(false);
        if (!Convert.ToBoolean(absent, CultureInfo.InvariantCulture))
            throw new InvalidOperationException("legacy_current_isolated_domain_still_present");
        await VerifyCurrentDigestsAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        await VerifyUserSequenceAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
    }

    private async Task VerifyCurrentDigestsAsync(DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        if (_currentDigests.Count != _programs.Count || _currentCounts.Count != _programs.Count)
            throw new InvalidOperationException("legacy_current_target_capture_missing");
        foreach (LegacyTableProgram program in _programs)
            if (!_currentDigests.TryGetValue(program.Owner, out string? expected)
                || expected != await ReadCurrentDataDigestAsync(program, connection, transaction, cancellationToken,
                    rows => { if (rows != _currentCounts[program.Owner]) throw new InvalidOperationException("legacy_current_row_count_changed"); }).ConfigureAwait(false))
                throw new InvalidOperationException("legacy_current_data_changed:" + program.Owner);
    }

    private async Task RestartUserSequenceAsync(DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        SchemaTableModel physical = _owned.ProjectExpectedPhysicalTarget(SchemaProviderKind.PostgreSql).Tables.Tables[_users.Table.Name];
        SchemaColumnModel id = physical.Columns[_users.Properties["Id"].Name];
        SchemaOwnedSequenceModel sequence = id.OwnedSequence ?? throw new InvalidOperationException("legacy_current_account_sequence_unowned");
        if (!id.IsIdentity || sequence.Schema != "public" || sequence.OwnedTable != physical.Name
            || sequence.OwnedColumn != id.Name || sequence.IncrementBy != 1 || sequence.IsCyclic)
            throw new InvalidOperationException("legacy_current_account_sequence_changed");
        string schema = Stage.RequireOriginalSession(connection, transaction);
        long legacyNext = await WithResourceAsync(Command(connection, transaction,
            "SELECT last_value,is_called FROM " + schema + ".sys_user_id_seq"), async command =>
        {
            return await WithResourceAsync(await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false), async reader =>
            {
                if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    throw new InvalidOperationException("legacy_account_sequence_missing");
                long next = checked(reader.GetInt64(0) + (reader.GetBoolean(1) ? 1 : 0));
                if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    throw new InvalidOperationException("legacy_account_sequence_ambiguous");
                return next;
            }).ConfigureAwait(false);
        }).ConfigureAwait(false);
        object? maximumValue = await ScalarAsync(connection, transaction,
            "SELECT MAX(" + Quote(id.Name) + ") FROM public." + Quote(physical.Name), cancellationToken).ConfigureAwait(false);
        long next = Math.Max(sequence.StartValue, legacyNext);
        if (maximumValue is not null and not DBNull)
            next = Math.Max(next, checked(Convert.ToInt64(maximumValue, CultureInfo.InvariantCulture) + 1));
        if (next < sequence.MinValue || next > sequence.MaxValue)
            throw new InvalidOperationException("legacy_account_sequence_next_value_unavailable");
        await ExecuteAsync(connection, transaction, "ALTER SEQUENCE public." + Quote(sequence.Name)
            + " RESTART WITH " + next.ToString(CultureInfo.InvariantCulture), cancellationToken).ConfigureAwait(false);
        _userMinimumNext = next;
    }

    private async Task VerifyUserSequenceAsync(DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        if (_userMinimumNext is null)
            throw new InvalidOperationException("legacy_account_sequence_capture_missing");
        SchemaOwnedSequenceModel sequence = _owned.ProjectExpectedPhysicalTarget(SchemaProviderKind.PostgreSql)
            .Tables.Tables[_users.Table.Name].Columns[_users.Properties["Id"].Name].OwnedSequence
            ?? throw new InvalidOperationException("legacy_current_account_sequence_unowned");
        await WithResourceAsync(Command(connection, transaction, "SELECT last_value,is_called FROM public." + Quote(sequence.Name)), async command =>
        {
            return await WithResourceAsync(await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false), async reader =>
            {
                if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    throw new InvalidOperationException("legacy_current_account_sequence_missing");
                long next = checked(reader.GetInt64(0) + (reader.GetBoolean(1) ? 1 : 0));
                if (next < _userMinimumNext.Value || await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    throw new InvalidOperationException("legacy_current_account_sequence_rewound");
                return true;
            }).ConfigureAwait(false);
        }).ConfigureAwait(false);
    }

    private static async Task<string> ReadCurrentDataDigestAsync(LegacyTableProgram program,
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken, Action<long>? captureRows = null)
    {
        SchemaColumnModel[] columns = program.Table.Columns.Values.OrderBy(static column => column.Name, StringComparer.Ordinal).ToArray();
        string projection = string.Join(',', columns.Select(static column => column.DataType is "timestamp" or "datetime"
            ? "pg_catalog.timestamp_send(" + Quote(column.Name) + ")" : column.DataType == "date"
            ? "pg_catalog.date_send(" + Quote(column.Name) + ")" : Quote(column.Name)));
        string order = string.Join(',', columns.Where(static column => column.IsPrimaryKey).Select(static column => Quote(column.Name)
            + (column.DataType == "string" ? " COLLATE \"C\"" : "")));
        if (order.Length == 0)
            throw new InvalidOperationException("legacy_current_data_key_missing");
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(Encoding.ASCII.GetBytes("fsusblog.legacy-current-data.v1\0"));
        foreach (SchemaColumnModel column in columns)
        {
            using var name = new StringReader(column.Name + ":" + column.DataType);
            await OfflineMigrationSourceObserver.AppendTextAsync(hash, name, cancellationToken).ConfigureAwait(false);
        }
        return await WithResourceAsync(Command(connection, transaction, "SELECT " + projection + " FROM public."
            + Quote(program.Table.Name) + " ORDER BY " + order), async command =>
        {
            return await WithResourceAsync(await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, cancellationToken).ConfigureAwait(false), async reader =>
            {
                long rows = 0;
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    hash.AppendData([1]);
                    for (int index = 0; index < columns.Length; index++)
                    {
                        if (await reader.IsDBNullAsync(index, cancellationToken).ConfigureAwait(false))
                        {
                            hash.AppendData([0]);
                            continue;
                        }
                        hash.AppendData([1]);
                        string type = columns[index].DataType;
                        if (type == "string")
                        {
                            await WithTextReaderAsync(await ((NpgsqlDataReader)reader).GetTextReaderAsync(index, cancellationToken).ConfigureAwait(false), async text =>
                        {
                            await OfflineMigrationSourceObserver.AppendTextAsync(hash, text, cancellationToken).ConfigureAwait(false);
                            return true;
                        }).ConfigureAwait(false);
                        }
                        else if (type is "datetime" or "timestamp" or "date")
                        {
                            byte[] bytes = reader.GetFieldValue<byte[]>(index);
                            if (bytes.Length != (type == "date" ? 4 : 8))
                                throw new InvalidOperationException("legacy_current_calendar_storage_invalid");
                            hash.AppendData(bytes);
                        }
                        else
                        {
                            long scalar = type switch
                            {
                                "int16" => reader.GetInt16(index),
                                "int32" => reader.GetInt32(index),
                                "int64" => reader.GetInt64(index),
                                "boolean" => reader.GetBoolean(index) ? 1 : 0,
                                _ => throw new InvalidOperationException("legacy_current_data_type_unavailable")
                            };
                            byte[] bytes = new byte[8];
                            System.Buffers.Binary.BinaryPrimitives.WriteInt64LittleEndian(bytes, scalar);
                            hash.AppendData(bytes);
                        }
                    }
                    rows = checked(rows + 1);
                }
                byte[] count = new byte[8];
                System.Buffers.Binary.BinaryPrimitives.WriteInt64LittleEndian(count, rows);
                hash.AppendData([255]);
                hash.AppendData(count);
                captureRows?.Invoke(rows);
                return Convert.ToHexStringLower(hash.GetHashAndReset());
            }).ConfigureAwait(false);
        }).ConfigureAwait(false);
    }

    private async Task RequireLosslessInputsAsync(DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        string schema = Stage.RequireOriginalSession(connection, transaction);
        LegacyTableProgram conversation = _programs.Single(static item => item.Owner == EntityOwner("MessageConversation"));
        SchemaColumnModel subject = conversation.Properties["Subject"];
        if (subject.MaxLength is null)
            throw new InvalidOperationException("legacy_message_subject_bound_missing");
        await RequireNoRowsAsync(connection, transaction,
            "SELECT COUNT(*) FROM " + schema + ".sys_message WHERE char_length(title)>" + subject.MaxLength.Value.ToString(CultureInfo.InvariantCulture),
            "legacy_message_title_cannot_be_preserved", cancellationToken).ConfigureAwait(false);
        await RequireNoRowsAsync(connection, transaction,
            "SELECT COUNT(*) FROM " + schema + ".sys_user_message WHERE userid < -2147483648 OR userid > 2147483647",
            "legacy_message_account_cannot_be_preserved", cancellationToken).ConfigureAwait(false);
        LegacyTableProgram page = _programs.Single(static item => item.Owner == EntityOwner("PageContent"));
        string pages = page.SourceSql;
        await RequireNoRowsAsync(connection, transaction,
            "SELECT COUNT(*) FROM (" + pages + ") pages WHERE char_length(slug)>"
                + page.Properties["Slug"].MaxLength!.Value.ToString(CultureInfo.InvariantCulture),
            "legacy_page_slug_cannot_be_preserved", cancellationToken).ConfigureAwait(false);
        await RequireNoRowsAsync(connection, transaction,
            "SELECT COUNT(*) FROM (SELECT slug FROM (" + pages + ") pages GROUP BY slug HAVING COUNT(*)>1) collisions",
            "legacy_page_slug_collision", cancellationToken).ConfigureAwait(false);
    }

    private async Task PopulateAccountSubjectsAsync(DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        string schema = Stage.RequireOriginalSession(connection, transaction);
        int? previous = null;
        while (true)
        {
            var ids = new List<int>(AccountSubjectHashBackfillStep.BatchSize);
            await WithResourceAsync(Command(connection, transaction,
                "SELECT id FROM " + schema + ".sys_user WHERE @previous IS NULL OR id>@previous ORDER BY id LIMIT "
                    + AccountSubjectHashBackfillStep.BatchSize.ToString(CultureInfo.InvariantCulture)), async read =>
            {
                DbParameter parameter = read.CreateParameter();
                parameter.ParameterName = "previous";
                parameter.DbType = DbType.Int32;
                parameter.Value = previous.HasValue ? previous.Value : DBNull.Value;
                read.Parameters.Add(parameter);
                return await WithResourceAsync(await read.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false), async reader =>
                {
                    while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                        ids.Add(reader.GetInt32(0));
                    return true;
                }).ConfigureAwait(false);
            }).ConfigureAwait(false);
            if (ids.Count == 0)
                break;
            string[] subjects = ids.Select(AccountSubjectHashOnlineBackfillHandler.ComputeLegacyAnonymousAccountSubject).ToArray();
            int changed = await WithResourceAsync(Command(connection, transaction, "UPDATE public." + Quote(_users.Table.Name)
                + " target SET " + Quote(_users.Properties["AccountSubjectHash"].Name) + "=batch.subject"
                + " FROM unnest(@ids::integer[],@subjects::text[]) batch(id,subject)"
                + " WHERE target." + Quote(_users.Properties["Id"].Name) + "=batch.id"), async write =>
            {
                Parameter(write, "ids", ids.ToArray());
                Parameter(write, "subjects", subjects);
                return await write.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
            }).ConfigureAwait(false);
            if (changed != ids.Count)
                throw new InvalidOperationException("legacy_account_subject_write_count_changed");
            previous = ids[^1];
        }
    }

    private async Task VerifyAccountSubjectsAsync(DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        string schema = Stage.RequireOriginalSession(connection, transaction);
        await WithResourceAsync(Command(connection, transaction,
            "SELECT source.id,target." + Quote(_users.Properties["AccountSubjectHash"].Name)
            + " FROM " + schema + ".sys_user source LEFT JOIN public." + Quote(_users.Table.Name)
            + " target ON target." + Quote(_users.Properties["Id"].Name) + "=source.id ORDER BY source.id"), async command =>
        {
            return await WithResourceAsync(await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, cancellationToken).ConfigureAwait(false), async reader =>
            {
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    if (await reader.IsDBNullAsync(1, cancellationToken).ConfigureAwait(false)
                        || reader.GetString(1) != AccountSubjectHashOnlineBackfillHandler.ComputeLegacyAnonymousAccountSubject(reader.GetInt32(0)))
                        throw new InvalidOperationException("legacy_account_subject_readback_mismatch");
                return true;
            }).ConfigureAwait(false);
        }).ConfigureAwait(false);
    }

    internal static IReadOnlyList<LegacyTableProgram> Compile(CurrentSchemaBootstrapInput input, string quotedSchema)
    {
        string Old(string table) => quotedSchema + "." + Quote(table);
        string NonPage() => "s.\"key\" NOT LIKE 'Page_%' AND s.\"key\" NOT LIKE 'sys:page:%'";
        var programs = new List<LegacyTableProgram>
        {
            Bind(input, "User", "SELECT * FROM " + Old("sys_user"), new()
            {
                ["Id"] = "s.id", ["Status"] = "s.status", ["BanReason"] = "s.banreason", ["CreateTime"] = "s.createtime",
                // This historical profile has no passkey/recovery/session active
                // evidence: use the original enrollment migration's CASE result.
                ["RegistrationState"] = "CASE WHEN s.status=2 THEN 'closed' ELSE 'suspended' END"
            }, verifyExcluded: ["AccountSubjectHash"]),
            Bind(input, "Comment", "SELECT * FROM " + Old("comment"), new()
            {
                ["Id"] = "s.id", ["ArticleId"] = "s.article_id", ["Content"] = "s.content", ["CreateTime"] = "s.create_time",
                ["UserId"] = "s.user_id", ["AuthorMode"] = "'public'", ["Depth"] = "0", ["IsDeleted"] = "false",
                ["ModerationStatus"] = "1", ["ModeratedByAdminPrincipalId"] = "s.moderated_by_user_id::bigint", ["CurrentVersion"] = "1"
            }),
            Bind(input, "CommentRevision", "SELECT * FROM " + Old("comment"), new()
            {
                ["CommentId"] = "s.id", ["Version"] = "1", ["Content"] = "s.content",
                ["ContentSha256"] = "pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(s.content,'UTF8')),'hex')",
                ["Operation"] = "'created'", ["CreatedAtUtc"] = "s.create_time", ["ActorAccountId"] = "s.user_id",
                ["ActorMode"] = "'public'"
            }, generatedIdentity: "Id"),
            Bind(input, "SystemConfig", "SELECT * FROM " + Old("sys_systemconfig") + " s WHERE " + NonPage(),
                new() { ["Key"] = "s.\"key\"", ["Value"] = "s.value" }, replaceSeedValues: true),
            Bind(input, "PageContent",
                "SELECT lower(replace(substr(\"key\",6),'_','-')) slug,value content FROM " + Old("sys_systemconfig") + " WHERE \"key\" LIKE 'Page_%'"
                + " UNION ALL SELECT lower(replace(substr(\"key\",10),'_','-')),value FROM " + Old("sys_systemconfig") + " WHERE \"key\" LIKE 'sys:page:%'",
                new() { ["Slug"] = "s.slug", ["Content"] = "s.content", ["UpdatedAt"] = "now() AT TIME ZONE 'utc'" }),
            Bind(input, "MessageConversation", "SELECT * FROM " + Old("sys_message"), new()
            {
                ["Id"] = "s.id", ["Subject"] = "s.title", ["Status"] = "0", ["IsSystemSource"] = "true",
                ["SourceMessageId"] = "s.id", ["CreatedByType"] = "2",
                ["CreatedAt"] = "s.createtime", ["UpdatedAt"] = "s.createtime", ["LastMessageAt"] = "s.createtime"
            }),
            Bind(input, "ConversationMessage", "SELECT * FROM " + Old("sys_message"), new()
            {
                ["Id"] = "s.id", ["ConversationId"] = "s.id", ["SenderType"] = "2", ["Body"] = "s.content",
                ["IsInternalNote"] = "false", ["CreatedAt"] = "s.createtime"
            }),
            Bind(input, "ConversationParticipantState", "SELECT * FROM " + Old("sys_user_message"), new()
            {
                ["ConversationId"] = "s.messageid", ["AccountId"] = "s.userid::integer",
                ["LastReadMessageId"] = "CASE WHEN s.isread THEN s.messageid ELSE NULL END",
                ["UnreadCount"] = "CASE WHEN s.isread THEN 0 ELSE 1 END",
                ["LastReadAt"] = "s.readtime", ["UpdatedAt"] = "COALESCE(s.readtime,now() AT TIME ZONE 'utc')"
            }),
            Bind(input, "ArticleViewSeed", "SELECT * FROM " + Old("article"), new()
            {
                ["ArticleId"] = "s.id", ["LegacyViews"] = "s.views", ["SeededAtUtc"] = "now() AT TIME ZONE 'utc'"
            }),
            BindRecipe(input, "daily_read_stats", "SELECT createtime::date stat_date,COUNT(*)::bigint total_reads FROM "
                + Old("sys_visit_log") + " GROUP BY createtime::date", new()
            {
                ["stat_date"] = "s.stat_date", ["total_reads"] = "s.total_reads", ["human_verified_reads"] = "0",
                ["unique_viewer_estimate"] = "0", ["updated_at_utc"] = "now() AT TIME ZONE 'utc'"
            }),
            BindRecipe(input, "event_type_read_stats", "SELECT COUNT(*)::bigint read_count FROM " + Old("sys_visit_log")
                + " HAVING COUNT(*)>0", new()
            {
                ["event_type"] = "'site_read'", ["read_count"] = "s.read_count", ["updated_at_utc"] = "now() AT TIME ZONE 'utc'"
            })
        };
        return programs;
    }

    private static LegacyTableProgram Bind(CurrentSchemaBootstrapInput input, string entity, string sourceSql,
        Dictionary<string, string> expressions, string? generatedIdentity = null, string[]? verifyExcluded = null, bool replaceSeedValues = false)
    {
        string owner = EntityOwner(entity);
        SchemaTableModel[] tables = input.EntityProjection.Schema.Tables.Values.Where(table => table.Owner?.Owner == owner).ToArray();
        if (tables.Length != 1)
            throw new InvalidOperationException("legacy_current_owner_table_missing_or_duplicate:" + owner);
        return BindTable(tables[0], owner, sourceSql, expressions, generatedIdentity, verifyExcluded ?? [], replaceSeedValues, input);
    }

    private static LegacyTableProgram BindRecipe(CurrentSchemaBootstrapInput input, string role, string sourceSql, Dictionary<string, string> expressions)
    {
        CurrentSchemaRequiredRecipeReference[] references = input.RequiredRecipes.Where(reference => reference.TableName == role).ToArray();
        if (references.Length != 1 || references[0].SemanticDescription is null || references[0].Provider != SchemaProviderKind.PostgreSql)
            throw new InvalidOperationException("legacy_current_recipe_missing_or_duplicate:" + role);
        return BindTable(references[0].SemanticDescription!.Table, "current-runtime-recipe/" + role, sourceSql,
            expressions, null, [], false, input, recipe: true);
    }

    internal static LegacyTableProgram BindTable(SchemaTableModel table, string owner, string sourceSql,
        IReadOnlyDictionary<string, string> expressions, string? generatedIdentity, string[] verifyExcluded,
        bool replaceSeedValues, CurrentSchemaBootstrapInput input, bool recipe = false)
    {
        var properties = new Dictionary<string, SchemaColumnModel>(StringComparer.Ordinal);
        foreach ((string key, SchemaColumnModel column) in table.Columns)
        {
            string property = recipe ? column.Name : column.Owner?.Owner.StartsWith(owner + ".", StringComparison.Ordinal) == true
                ? column.Owner.Owner[(owner.Length + 1)..] : throw new InvalidOperationException("legacy_current_property_owner_missing");
            if (key != column.Name || !properties.TryAdd(property, column)
                || column.ComputedExpression is not null || column.Conversion is not (null or "none"))
                throw new InvalidOperationException("legacy_current_field_binding_changed");
        }
        if (expressions.Keys.Any(property => !properties.ContainsKey(property))
            || verifyExcluded.Any(property => !properties.ContainsKey(property)))
            throw new InvalidOperationException("legacy_current_property_missing");
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach ((string property, SchemaColumnModel column) in properties)
        {
            if (property == generatedIdentity)
            {
                if (!column.IsIdentity || !column.IsPrimaryKey)
                    throw new InvalidOperationException("legacy_current_generated_identity_changed");
                continue;
            }
            string expression = expressions.TryGetValue(property, out string? assigned) ? assigned
                : column.DefaultValue is not null ? CurrentSchemaBootstrapCompiler.EntityDefaultValue(column)
                : column.IsNullable ? "NULL" : throw new InvalidOperationException("legacy_current_required_value_missing:" + property);
            values.Add(column.Name, expression);
        }
        string[] keys = values.Keys.Where(name => table.Columns[name].IsPrimaryKey).ToArray();
        if (keys.Length == 0 && generatedIdentity is null)
            throw new InvalidOperationException("legacy_current_key_missing");
        string[] compared = values.Keys.Where(name => !verifyExcluded.Any(property => properties[property].Name == name)).ToArray();
        string SelectedValue(string name, string expression)
            => "CAST((" + expression + ") AS " + SchemaPhysicalTypeProjection.ToPhysical(
                SchemaProviderKind.PostgreSql, table.Columns[name].DataType, table.Columns[name].MaxLength,
                table.Columns[name].PhysicalType) + ") AS " + Quote(name);
        string selected = string.Join(',', values.Select(pair => SelectedValue(pair.Key, pair.Value)));
        string[] overflow = values.Where(pair => table.Columns[pair.Key].DataType == "string" && table.Columns[pair.Key].MaxLength is not null)
            .Select(pair => "char_length((" + pair.Value + ")::text)>" + table.Columns[pair.Key].MaxLength!.Value.ToString(CultureInfo.InvariantCulture)).ToArray();
        string inputValidation = "SELECT COUNT(*) FROM (" + sourceSql + ") s WHERE "
            + (overflow.Length == 0 ? "false" : string.Join(" OR ", overflow));
        string expected = "SELECT " + selected + " FROM (" + sourceSql + ") s";
        // Only original owned bootstrap seed rows may coexist with migrated
        // values. The historical key wins; nothing is hidden by an allowlist.
        foreach (CurrentSchemaRecipeOperation seed in input.RequiredRecipes.SelectMany(reference => reference.SemanticDescription!.AdditionalOperations)
                     .Where(operation => operation.Kind == CurrentSchemaRecipeOperationKind.InsertIfAbsent && operation.Table == table.Name))
        {
            if (seed.Columns is null || seed.Values is null || seed.Columns.Count != seed.Values.Count || seed.ConflictColumn is null
                || seed.Columns.Any(name => !values.ContainsKey(name)))
                throw new InvalidOperationException("legacy_current_seed_binding_changed");
            var seedValues = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach ((string name, string value) in seed.Columns.Zip(seed.Values))
                seedValues.Add(name, value);
            string seedSelect = string.Join(',', values.Keys.Select(name => SelectedValue(name, seedValues.TryGetValue(name, out string? value) ? value
                : table.Columns[name].DefaultValue is not null ? CurrentSchemaBootstrapCompiler.EntityDefaultValue(table.Columns[name])
                : table.Columns[name].IsNullable ? "NULL" : throw new InvalidOperationException("legacy_current_seed_required_value_missing"))));
            string conflictValue = seedValues[seed.ConflictColumn];
            expected += " UNION ALL SELECT " + seedSelect + " WHERE NOT EXISTS (SELECT 1 FROM (" + "SELECT " + selected
                + " FROM (" + sourceSql + ") s) legacy WHERE legacy." + Quote(seed.ConflictColumn) + " IS NOT DISTINCT FROM " + conflictValue + ")";
        }
        string conflict = replaceSeedValues
            ? " ON CONFLICT (" + string.Join(',', keys.Select(Quote)) + ") DO UPDATE SET "
                + string.Join(',', values.Keys.Except(keys).Select(name => Quote(name) + "=EXCLUDED." + Quote(name)))
            : " ON CONFLICT DO NOTHING";
        string insert = "INSERT INTO public." + Quote(table.Name) + " (" + string.Join(',', values.Keys.Select(Quote)) + ") "
            + "SELECT " + selected + " FROM (" + sourceSql + ") s" + conflict;
        string projection = string.Join(',', compared.Select(Quote));
        string actual = "SELECT " + projection + " FROM public." + Quote(table.Name);
        string wanted = "SELECT " + projection + " FROM expected";
        string verify = "WITH expected AS (" + expected + ") SELECT NOT EXISTS ((" + actual + " EXCEPT ALL " + wanted
            + ") UNION ALL (" + wanted + " EXCEPT ALL " + actual + "))";
        return new(owner, table, properties, sourceSql, insert, verify, inputValidation);
    }

    internal sealed record LegacyTableProgram(string Owner, SchemaTableModel Table,
        IReadOnlyDictionary<string, SchemaColumnModel> Properties, string SourceSql, string InsertSql, string VerifySql, string InputValidationSql);

    private static string EntityOwner(string entity) => "FsusBlog.Server.Entities." + entity;
    private static string Quote(string name) => SchemaMigrationSql.QuoteIdentifier(name);
    private static DbCommand Command(DbConnection connection, DbTransaction transaction, string sql)
    {
        DbCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandTimeout = 30;
        command.CommandText = sql;
        return command;
    }
    private static async Task ExecuteAsync(DbConnection connection, DbTransaction transaction, string sql, CancellationToken cancellationToken)
    {
        await WithResourceAsync(Command(connection, transaction, sql),
            command => command.ExecuteNonQueryAsync(cancellationToken)).ConfigureAwait(false);
    }
    private static Task<object?> ScalarAsync(DbConnection connection, DbTransaction transaction, string sql, CancellationToken cancellationToken)
        => WithResourceAsync(Command(connection, transaction, sql), command => command.ExecuteScalarAsync(cancellationToken));

    internal static Task<TResult> WithTextReaderAsync<TResult>(TextReader reader, Func<TextReader, Task<TResult>> operation)
        => WithResourceAsync(new TextReaderResource(reader), resource => operation(resource.Reader));

    private sealed class TextReaderResource(TextReader reader) : IAsyncDisposable
    {
        internal TextReader Reader { get; } = reader;
        public ValueTask DisposeAsync()
        {
            Reader.Dispose();
            return ValueTask.CompletedTask;
        }
    }

    // The operation error (including cancellation) remains the first cause;
    // cleanup errors are bounded type-only secondary diagnostics, not SQL/argv.
    internal static async Task<TResult> WithResourceAsync<TResource, TResult>(TResource resource, Func<TResource, Task<TResult>> operation)
        where TResource : IAsyncDisposable
    {
        Exception? primary = null;
        try
        {
            return await operation(resource).ConfigureAwait(false);
        }
        catch (Exception error) { primary = error; throw; }
        finally
        {
            try
            {
                await resource.DisposeAsync().ConfigureAwait(false);
            }
            catch (Exception cleanup) when (primary is not null)
            {
                const string Key = "legacy_nonarticle_cleanup_types";
                string prior = primary.Data[Key] as string ?? "";
                if (prior.Length < 256)
                    primary.Data[Key] = (prior + (prior.Length == 0 ? "" : ",") + cleanup.GetType().Name)[..Math.Min(256,
                    prior.Length + (prior.Length == 0 ? 0 : 1) + cleanup.GetType().Name.Length)];
            }
        }
    }
    private static async Task RequireNoRowsAsync(DbConnection connection, DbTransaction transaction, string sql, string failure, CancellationToken cancellationToken)
    {
        if (Convert.ToInt64(await ScalarAsync(connection, transaction, sql, cancellationToken).ConfigureAwait(false), CultureInfo.InvariantCulture) != 0)
            throw new InvalidOperationException(failure);
    }
    private static void Parameter(DbCommand command, string name, object value)
    {
        DbParameter parameter = command.CreateParameter();
        parameter.ParameterName = name;
        parameter.Value = value;
        command.Parameters.Add(parameter);
    }
}
