using System;
using System.Collections.Generic;
using System.Data;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const int Version = 1;

    private static readonly string[] Columns =
    [
        "v2_schema singleton:bool version:int4",
        "blog_user id:uuid name:text can_author:bool enabled:bool generation:int8",
        "login_ticket digest:bytea user_id:uuid expires_at:timestamptz",
        "user_session digest:bytea user_id:uuid generation:int8 expires_at:timestamptz passkey_credential_id:bytea? totp_verified_at:timestamptz?",
        "article id:int4:a owner_id:uuid revision:int8 title:text body:text published_revision:int8? publication_count:int4=0 deleted:bool created_at:timestamptz=now updated_at:timestamptz=now",
        "article_revision article_id:int4 revision:int8 title:text body:text happened_at:timestamptz",
        "article_command actor_id:uuid command_id:uuid fingerprint:bytea article_id:int4 revision:int8 title:text body:text published:bool",
        "article_publication article_id:int4 publication_id:int8:d revision:int8 publication_no:int4=1 published_at:timestamptz",
        "blog_outbox id:int8:a article_id:int4 revision:int8 kind:text created_at:timestamptz=now processed_at:timestamptz?"
    ];

    private static readonly string[] Constraints =
    [
        "v2_schema p singleton",
        "v2_schema c singleton singleton",
        "blog_user p id",
        "blog_user u name",
        "blog_user c generation generation>0",
        "login_ticket p digest",
        "login_ticket c digest octet_length(digest)=32",
        "login_ticket f user_id public.blog_user:id",
        "user_session p digest",
        "user_session c digest octet_length(digest)=32",
        "user_session c generation generation>0",
        "user_session f user_id public.blog_user:id",
        "article p id",
        "article c revision revision>0",
        "article c publication_count publication_count>=0",
        "article f owner_id public.blog_user:id",
        "article f id,revision public.article_revision:article_id,revision deferred",
        "article f id,published_revision public.article_revision:article_id,revision deferred",
        "article_revision p article_id,revision",
        "article_revision c revision revision>0",
        "article_revision f article_id public.article:id",
        "article_command p actor_id,command_id",
        "article_command c fingerprint octet_length(fingerprint)=32",
        "article_command f actor_id public.blog_user:id",
        "article_command f article_id public.article:id",
        "article_command f article_id,revision public.article_revision:article_id,revision",
        "article_publication p article_id",
        "article_publication u publication_id",
        "article_publication c publication_no publication_no>0",
        "article_publication f article_id public.article:id",
        "article_publication f article_id,revision public.article_revision:article_id,revision",
        "blog_outbox p id",
        "blog_outbox f article_id public.article:id",
        "blog_outbox f article_id,revision public.article_revision:article_id,revision"
    ];

    internal static async Task VerifyAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken);
        await using (var protect = new NpgsqlCommand("SET TRANSACTION READ ONLY; SET LOCAL search_path TO pg_catalog", connection, transaction))
        {
            await protect.ExecuteNonQueryAsync(cancellationToken);
        }

        await using (var role = new NpgsqlCommand("SHOW session_replication_role", connection, transaction))
        {
            if (await role.ExecuteScalarAsync(cancellationToken) is not "origin")
            {
                throw new InvalidOperationException("The PostgreSQL session must enforce local integrity triggers.");
            }
        }

        await VerifyCatalogAsync(connection, transaction, cancellationToken);
        await VerifyAdminIdentityMarkerAsync(connection, transaction, cancellationToken);
        await ReadRecoverySiteIdAsync(connection, transaction, cancellationToken);
        await using var marker = new NpgsqlCommand("SELECT version FROM public.v2_schema", connection, transaction);
        await using (var row = await marker.ExecuteReaderAsync(cancellationToken))
        {
            if (!await row.ReadAsync(cancellationToken) || row.GetInt32(0) != Version || await row.ReadAsync(cancellationToken))
            {
                throw new InvalidOperationException($"Expected a single FsusBlog V2 schema marker at version {Version}.");
            }
        }

        await transaction.CommitAsync(cancellationToken);
    }

    internal static async Task VerifyCatalogAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        CancellationToken cancellationToken, bool requireRecoveryScope = true, bool requireRevisionHistory = true,
        bool requireAdminIdentity = true, bool requirePublicationHistory = true, bool requireArticleSchedule = true,
        bool requireMediaUpload = true)
    {
        var expectedColumns = Columns.Concat(CommunicationColumns).Concat(TaxonomyColumns).Concat(CanvasColumns).Concat(PropertyColumns)
            .Concat(PasskeyColumns).Concat(MfaColumns).Concat(CommentColumns).Concat(MediaColumns)
            .Concat(requireRevisionHistory ? RevisionHistoryColumns : [])
            .Concat(requireAdminIdentity ? AdminIdentityColumns : [])
            .Concat(requirePublicationHistory ? PublicationHistoryColumns : [])
            .Concat(requireArticleSchedule ? ArticleScheduleColumns : [])
            .Concat(requireMediaUpload ? MediaUploadColumns : [])
            .Concat(requireRecoveryScope ? RecoveryScopeColumns : []).ToArray();
        var expectedConstraints = Constraints.Concat(CommunicationConstraints).Concat(TaxonomyConstraints).Concat(CanvasConstraints)
            .Concat(PropertyConstraints).Concat(PasskeyConstraints).Concat(MfaConstraints).Concat(CommentConstraints).Concat(MediaConstraints)
            .Concat(requireRevisionHistory ? RevisionHistoryConstraints : [])
            .Concat(requireAdminIdentity ? AdminIdentityConstraints : [])
            .Concat(requirePublicationHistory ? PublicationHistoryConstraints : [])
            .Concat(requireArticleSchedule ? ArticleScheduleConstraints : [])
            .Concat(requireMediaUpload ? MediaUploadConstraints : [])
            .Concat(requireRecoveryScope ? RecoveryScopeConstraints : []).ToArray();
        const string sql = """
            WITH owned AS (
                SELECT c.*
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relname::text = ANY($1)
            )
            SELECT 'column', c.relname || ' ' || string_agg(a.attname || ':' || t.typname ||
                CASE WHEN a.attnotnull THEN '' ELSE '?' END ||
                CASE WHEN a.attidentity = '' THEN '' ELSE ':' || a.attidentity::text ||
                    CASE WHEN EXISTS (
                        SELECT FROM pg_depend dep JOIN pg_sequence seq ON seq.seqrelid = dep.objid
                        WHERE dep.classid = 'pg_class'::regclass AND dep.refclassid = 'pg_class'::regclass
                          AND dep.refobjid = c.oid AND dep.refobjsubid = a.attnum AND dep.deptype = 'i'
                          AND seq.seqtypid = a.atttypid AND seq.seqincrement = 1 AND seq.seqmin = 1
                          AND seq.seqstart = 1 AND seq.seqcache = 1 AND NOT seq.seqcycle
                    ) THEN '' ELSE ' unexpected-identity-sequence' END END ||
                CASE WHEN a.atttypmod = -1 AND a.attgenerated = '' AND tn.nspname = 'pg_catalog'
                         AND a.attcollation = t.typcollation THEN '' ELSE ' unexpected-modifier' END ||
                CASE WHEN d.oid IS NULL THEN '' ELSE '=' || replace(pg_get_expr(d.adbin, d.adrelid), '()', '') END,
                ' ' ORDER BY a.attnum)
            FROM owned c JOIN pg_attribute a ON a.attrelid = c.oid
            JOIN pg_type t ON t.oid = a.atttypid JOIN pg_namespace tn ON tn.oid = t.typnamespace
            LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
            WHERE c.relkind = 'r' AND c.relpersistence = 'p' AND NOT c.relrowsecurity AND NOT c.relhasrules
               AND NOT EXISTS (SELECT FROM pg_trigger tr WHERE tr.tgrelid = c.oid AND NOT tr.tgisinternal)
               AND NOT EXISTS (SELECT FROM pg_trigger tr WHERE tr.tgrelid = c.oid AND tr.tgenabled NOT IN ('O', 'A'))
               AND NOT EXISTS (SELECT FROM pg_inherits i WHERE c.oid IN (i.inhrelid, i.inhparent))
               AND a.attnum > 0 AND NOT a.attisdropped
            GROUP BY c.relname
            UNION ALL
            SELECT 'constraint', c.relname || ' ' || k.contype::text || ' ' ||
                coalesce((SELECT string_agg(a.attname, ',' ORDER BY i)
                          FROM unnest(k.conkey) WITH ORDINALITY AS keys(attnum, i)
                          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = keys.attnum), '') ||
                CASE WHEN k.contype = 'c' THEN ' ' || regexp_replace(pg_get_expr(k.conbin, k.conrelid, true), '[[:space:]]', '', 'g')
                     WHEN k.contype = 'f' THEN ' ' || n.nspname || '.' || target.relname || ':' ||
                         (SELECT string_agg(a.attname, ',' ORDER BY i)
                          FROM unnest(k.confkey) WITH ORDINALITY AS keys(attnum, i)
                          JOIN pg_attribute a ON a.attrelid = target.oid AND a.attnum = keys.attnum) ||
                         CASE WHEN k.confdeltype = 'a' AND k.confupdtype = 'a' AND k.confmatchtype = 's'
                              THEN '' ELSE ' unexpected-action' END
                     ELSE '' END ||
                CASE WHEN NOT k.convalidated OR NOT k.conislocal
                           OR coalesce(to_jsonb(k)->>'conenforced', 'true') <> 'true' THEN ' not-validated'
                     WHEN k.contype IN ('p', 'u') AND NOT EXISTS (
                         SELECT FROM pg_index idx WHERE idx.indexrelid = k.conindid AND idx.indisvalid AND idx.indisready
                     ) THEN ' unexpected-index'
                     WHEN k.condeferrable AND k.condeferred THEN ' deferred'
                     WHEN k.condeferrable THEN ' deferrable' ELSE '' END
            FROM owned c JOIN pg_constraint k ON k.conrelid = c.oid
            LEFT JOIN pg_class target ON target.oid = k.confrelid
            LEFT JOIN pg_namespace n ON n.oid = target.relnamespace
            WHERE k.contype <> 'n'
            """;
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        command.Parameters.Add(new NpgsqlParameter<string[]>
        {
            TypedValue = expectedColumns.Select(column => column.Split(' ', 2)[0]).ToArray()
        });
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var columns = new List<string>();
        var constraints = new List<string>();
        while (await reader.ReadAsync(cancellationToken))
        {
            (reader.GetString(0) == "column" ? columns : constraints).Add(reader.GetString(1));
        }

        AssertShape("relation/column", expectedColumns, columns);
        AssertShape("constraint", expectedConstraints, constraints);
    }

    private static void AssertShape(string kind, string[] expected, List<string> observed)
    {
        if (expected.Order(StringComparer.Ordinal).SequenceEqual(observed.Order(StringComparer.Ordinal)))
        {
            return;
        }

        var missing = string.Join("; ", expected.Except(observed, StringComparer.Ordinal));
        var unexpected = string.Join("; ", observed.Except(expected, StringComparer.Ordinal));
        throw new InvalidOperationException($"FsusBlog V2 {kind} shape mismatch. Missing [{missing}]. Unexpected [{unexpected}].");
    }
}
