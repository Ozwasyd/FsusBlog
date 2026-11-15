using System.Globalization;
using System.Security.Cryptography;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task<bool> ReadLegacyAdminTargetAsync(NpgsqlConnection target, NpgsqlTransaction tx, Guid targetSite,
        string mode, CancellationToken ct)
    {
        await using var gate = new NpgsqlCommand($"""
            SELECT current_setting('session_replication_role'),(SELECT version FROM public.v2_schema WHERE singleton),
                pg_catalog.to_regnamespace('{ImportSchema}') IS NOT NULL
            """, target, tx);
        int version;
        bool quarantined;
        await using (var status = await gate.ExecuteReaderAsync(ct))
        {
            if (!await status.ReadAsync(ct) || status.GetString(0) != "origin" || status.IsDBNull(1))
                throw new InvalidOperationException("The administrator rehearsal candidate requires active PostgreSQL integrity controls.");
            version = status.GetInt32(1);
            quarantined = status.GetBoolean(2);
        }
        if (version != (quarantined ? ImportQuarantineVersion : CurrentSchema.Version) ||
            quarantined && mode == "plan" || !quarantined && mode == "verify")
            throw new InvalidOperationException("The target is not the required empty or permanently quarantined administrator candidate.");
        await CurrentSchema.VerifyCatalogAsync(target, tx, ct);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(target, tx, ct);
        if (await CurrentSchema.ReadRecoverySiteIdAsync(target, tx, ct) != targetSite)
            throw new InvalidOperationException("The current candidate recovery-site ID differs from the reviewed target.");
        if (quarantined) await ReadLegacyAdminRelationsAsync(target, tx, ct);
        return quarantined;
    }

    private static async Task CheckLegacyAdminBaselineAsync(NpgsqlConnection target, NpgsqlTransaction tx, ImportBackup backup,
        bool quarantined, CancellationToken ct)
    {
        var (relations, media) = await ReadBackupSiteAsync(target, tx, ct, excludedSchema: quarantined ? ImportSchema : null);
        var baseline = backup.Site.Relations.ToDictionary(relation => relation.Name, StringComparer.Ordinal);
        if (media.Count != 0 || relations.Count != baseline.Count || backup.Site.PostgreSqlMajor !=
            target.PostgreSqlVersion.Major.ToString(CultureInfo.InvariantCulture))
            throw new InvalidOperationException("The administrator rehearsal requires its exact independently verified empty backup.");
        foreach (var relation in relations)
        {
            if (!baseline.TryGetValue(relation.Name, out var original) || relation.Kind != original.Kind)
                throw new InvalidOperationException("The candidate has uncovered database relations.");
            if (relation.Kind == "r" && original.Rows != 0 &&
                !await IsPristineLegacyCandidateSeedAsync(target, tx, relation.Name, ct))
                throw new InvalidOperationException("The backup already contains operational rows; use a fresh disposable candidate.");
            if (quarantined && relation.Name is ("v2_schema" or "admin_principal")) continue;
            if (relation != original)
                throw new InvalidOperationException($"Candidate relation {relation.Name} differs from the verified empty backup.");
        }
    }

    private static async Task<bool> IsPristineLegacyCandidateSeedAsync(NpgsqlConnection target, NpgsqlTransaction tx,
        string table, CancellationToken ct)
    {
        if (table is "v2_schema" or "authoring_recovery_site" or "admin_identity_schema") return true;
        var sql = table switch
        {
            "site_page_content" => """
                SELECT count(*)=4 AND bool_and(slug IN ('about','privacy','guidelines','copyright')
                    AND revision=0 AND markdown IS NULL) FROM public.site_page_content
                """,
            "appearance_activation" => """
                SELECT count(*)=1 AND bool_and(singleton AND revision=0 AND theme_digest='' AND font_digest='')
                FROM public.appearance_activation
                """,
            "taxonomy_epoch" => """
                SELECT count(*)=1 AND bool_and(singleton AND revision=0) FROM public.taxonomy_epoch
                """,
            "article_read_epoch" => """
                SELECT count(*)=1 AND bool_and(singleton AND last_epoch IS NULL) FROM public.article_read_epoch
                """,
            "root_comment_pow_policy" => """
                SELECT count(*)=1 AND bool_and(singleton AND generation=1 AND proof_seconds=120)
                FROM public.root_comment_pow_policy
                """,
            _ => null
        };
        if (sql is null) return false;
        await using var pristine = new NpgsqlCommand(sql, target, tx);
        return await pristine.ExecuteScalarAsync(ct) is true;
    }

    private static async Task StageDisabledLegacyAdminsAsync(NpgsqlConnection target, NpgsqlTransaction tx, LegacyAdminReview approved,
        string approvedSha, CancellationToken ct)
    {
        // Quarantine, map, then write native principal rows in one transaction. No command can initialize auth while quarantined.
        await ExecuteAsync(target, tx, BootstrapLock, ct);
        await ExecuteAsync(target, tx, $"""
            CREATE SCHEMA {ImportSchema};
            CREATE TABLE {ImportSchema}.admin_rehearsal_receipt (
                singleton boolean PRIMARY KEY CONSTRAINT admin_rehearsal_singleton CHECK (singleton),
                review_sha256 text NOT NULL CONSTRAINT admin_rehearsal_review_digest CHECK (char_length(review_sha256)=64),
                candidate_sha256 text NOT NULL CONSTRAINT admin_rehearsal_candidate_digest CHECK (char_length(candidate_sha256)=64),
                target_site_id uuid NOT NULL,
                serving boolean NOT NULL CONSTRAINT admin_rehearsal_nonserving CHECK (serving=false)
            );
            CREATE TABLE {ImportSchema}.admin_rehearsal_principal (
                source_admin_id bigint PRIMARY KEY CONSTRAINT admin_rehearsal_source_id CHECK (source_admin_id>0),
                target_admin_id uuid NOT NULL UNIQUE REFERENCES public.admin_principal(id),
                source_handle text NOT NULL UNIQUE,
                source_status text NOT NULL CONSTRAINT admin_rehearsal_source_status CHECK (source_status IN ('active','disabled')),
                source_generation bigint NOT NULL CONSTRAINT admin_rehearsal_source_generation CHECK (source_generation>0),
                source_grants text[] NOT NULL,
                source_passkeys bigint NOT NULL CONSTRAINT admin_rehearsal_passkeys CHECK (source_passkeys>=0),
                source_sessions bigint NOT NULL CONSTRAINT admin_rehearsal_sessions CHECK (source_sessions>=0)
            );
            """, ct);
        await using (var marker = new NpgsqlCommand("""
            UPDATE public.v2_schema SET version=$1 WHERE singleton AND version=$2
            """, target, tx))
        {
            marker.Parameters.AddWithValue(ImportQuarantineVersion);
            marker.Parameters.AddWithValue(CurrentSchema.Version);
            if (await marker.ExecuteNonQueryAsync(ct) != 1)
                throw new InvalidOperationException("The administrator staging quarantine marker was not written.");
        }
        foreach (var principal in approved.Principals)
        {
            var targetId = principal.TargetAdminId!.Value;
            await using (var native = new NpgsqlCommand("""
                INSERT INTO public.admin_principal(id,handle,user_handle,enabled,generation)
                VALUES ($1,$2,$3,false,$4)
                """, target, tx))
            {
                native.Parameters.AddWithValue(targetId);
                native.Parameters.AddWithValue(principal.SourceHandle);
                native.Parameters.AddWithValue(RandomNumberGenerator.GetBytes(32));
                native.Parameters.AddWithValue(principal.SourceGeneration);
                await native.ExecuteNonQueryAsync(ct);
            }
            await using var map = new NpgsqlCommand($"""
                INSERT INTO {ImportSchema}.admin_rehearsal_principal
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                """, target, tx);
            foreach (var value in new object[] { principal.SourceAdminId, targetId, principal.SourceHandle, principal.SourceStatus,
                         principal.SourceGeneration, principal.SourceGrants, principal.SourcePasskeys, principal.SourceSessions })
                map.Parameters.AddWithValue(value);
            await map.ExecuteNonQueryAsync(ct);
        }
    }

    private static async Task<string> VerifyDisabledLegacyAdminsAsync(NpgsqlConnection target, NpgsqlTransaction tx,
        LegacyAdminReview approved, string approvedSha, bool quarantined, CancellationToken ct)
    {
        var quarantineCatalog = await ReadLegacyAdminRelationsAsync(target, tx, ct);
        var native = await MeasureBackupRelationAsync(target, tx, new Relation("public", "admin_principal", "r"), ct);
        if (native.Rows != approved.Principals.Length)
            throw new InvalidOperationException("The disabled candidate administrator count differs.");
        await using var read = new NpgsqlCommand($"""
            SELECT m.source_admin_id,m.target_admin_id,m.source_handle,m.source_status,m.source_generation,m.source_grants,
                m.source_passkeys,m.source_sessions,p.handle,p.enabled,p.generation,octet_length(p.user_handle)
            FROM {ImportSchema}.admin_rehearsal_principal m LEFT JOIN public.admin_principal p ON p.id=m.target_admin_id
            ORDER BY m.source_admin_id
            """, target, tx);
        await using (var rows = await read.ExecuteReaderAsync(ct))
        {
            foreach (var item in approved.Principals)
                if (!await rows.ReadAsync(ct) || rows.IsDBNull(8) || rows.GetInt64(0) != item.SourceAdminId ||
                    rows.GetGuid(1) != item.TargetAdminId || rows.GetString(2) != item.SourceHandle ||
                    rows.GetString(3) != item.SourceStatus || rows.GetInt64(4) != item.SourceGeneration ||
                    !rows.GetFieldValue<string[]>(5).SequenceEqual(item.SourceGrants) || rows.GetInt64(6) != item.SourcePasskeys ||
                    rows.GetInt64(7) != item.SourceSessions || rows.GetString(8) != item.SourceHandle || rows.GetBoolean(9) ||
                    rows.GetInt64(10) != item.SourceGeneration || rows.GetInt32(11) != 32)
                    throw new InvalidOperationException("The isolated administrator mapping or disabled principal changed.");
            if (await rows.ReadAsync(ct)) throw new InvalidOperationException("The isolated administrator mapping has unexpected rows.");
        }
        var candidateSha = DigestMediaDocument(new { format = LegacyAdminReviewFormat, approvedSha, native, quarantineCatalog });
        if (!quarantined)
        {
            await using var save = new NpgsqlCommand($"""
                INSERT INTO {ImportSchema}.admin_rehearsal_receipt VALUES (true,$1,$2,$3,false)
                """, target, tx);
            save.Parameters.AddWithValue(approvedSha);
            save.Parameters.AddWithValue(candidateSha);
            save.Parameters.AddWithValue(approved.TargetSiteId);
            await save.ExecuteNonQueryAsync(ct);
        }
        await using var readReceipt = new NpgsqlCommand($"""
            SELECT singleton,review_sha256,candidate_sha256,target_site_id,serving
            FROM {ImportSchema}.admin_rehearsal_receipt
            """, target, tx);
        await using var receipt = await readReceipt.ExecuteReaderAsync(ct);
        if (!await receipt.ReadAsync(ct) || !receipt.GetBoolean(0) || receipt.GetString(1) != approvedSha ||
            receipt.GetString(2) != candidateSha || receipt.GetGuid(3) != approved.TargetSiteId || receipt.GetBoolean(4) ||
            await receipt.ReadAsync(ct))
            throw new InvalidOperationException("The sealed administrator rehearsal receipt changed.");
        return candidateSha;
    }

    private static async Task<string> ReadLegacyAdminRelationsAsync(NpgsqlConnection target, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var shape = new NpgsqlCommand($"""
            SELECT c.relname,a.attname,t.typname,a.attnotnull
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            JOIN pg_attribute a ON a.attrelid=c.oid JOIN pg_type t ON t.oid=a.atttypid
            WHERE n.nspname='{ImportSchema}' AND c.relkind NOT IN ('i','I')
              AND a.attnum>0 AND NOT a.attisdropped AND a.atttypmod=-1 AND c.relkind='r' AND c.relpersistence='p'
              AND NOT c.relrowsecurity AND NOT c.relhasrules AND NOT EXISTS (
                  SELECT FROM pg_trigger g WHERE g.tgrelid=c.oid AND NOT g.tgisinternal)
            ORDER BY c.relname,a.attnum
            """, target, tx);
        const string expected = """
            admin_rehearsal_principal.source_admin_id:int8
            admin_rehearsal_principal.target_admin_id:uuid
            admin_rehearsal_principal.source_handle:text
            admin_rehearsal_principal.source_status:text
            admin_rehearsal_principal.source_generation:int8
            admin_rehearsal_principal.source_grants:_text
            admin_rehearsal_principal.source_passkeys:int8
            admin_rehearsal_principal.source_sessions:int8
            admin_rehearsal_receipt.singleton:bool
            admin_rehearsal_receipt.review_sha256:text
            admin_rehearsal_receipt.candidate_sha256:text
            admin_rehearsal_receipt.target_site_id:uuid
            admin_rehearsal_receipt.serving:bool
            """;
        await using (var columns = await shape.ExecuteReaderAsync(ct))
        {
            foreach (var column in expected.Split('\n'))
                if (!await columns.ReadAsync(ct) || !columns.GetBoolean(3) ||
                    $"{columns.GetString(0)}.{columns.GetString(1)}:{columns.GetString(2)}" != column)
                    throw new InvalidOperationException("The administrator candidate quarantine catalog differs.");
            if (await columns.ReadAsync(ct)) throw new InvalidOperationException("The administrator candidate has additional quarantine data.");
        }
        var relations = (await RelationsAsync(target, tx, ct)).Where(row => row.Schema == ImportSchema).ToArray();
        if (relations.Length != 2 || relations.Any(row => row.Kind != "r" ||
            row.Name is not ("admin_rehearsal_receipt" or "admin_rehearsal_principal")))
            throw new InvalidOperationException("The administrator candidate cannot share article staging or other quarantine data.");
        await using var constraints = new NpgsqlCommand($"""
            SELECT c.relname || ':' || k.contype::text || ':' ||
                CASE WHEN k.contype='c' THEN k.conname
                ELSE (SELECT string_agg(a.attname,',' ORDER BY i)
                      FROM unnest(k.conkey) WITH ORDINALITY AS key(attnum,i)
                      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=key.attnum) END ||
                CASE WHEN k.contype='f' THEN ':'||target_ns.nspname||'.'||target.relname||':'||
                    (SELECT string_agg(a.attname,',' ORDER BY i)
                      FROM unnest(k.confkey) WITH ORDINALITY AS key(attnum,i)
                      JOIN pg_attribute a ON a.attrelid=target.oid AND a.attnum=key.attnum)
                    || ':'||k.confmatchtype::text||k.confupdtype::text||k.confdeltype::text ELSE '' END,
                CASE WHEN k.contype='c' THEN pg_get_expr(k.conbin,k.conrelid,true) END
            FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
            LEFT JOIN pg_class target ON target.oid=k.confrelid LEFT JOIN pg_namespace target_ns ON target_ns.oid=target.relnamespace
            WHERE n.nspname='{ImportSchema}' AND k.convalidated AND NOT k.condeferrable
                AND k.contype IN ('c','p','u','f')
            ORDER BY c.relname,k.conname
            """, target, tx);
        var required = new HashSet<string>(StringComparer.Ordinal)
        {
            "admin_rehearsal_principal:p:source_admin_id",
            "admin_rehearsal_principal:u:target_admin_id",
            "admin_rehearsal_principal:u:source_handle",
            "admin_rehearsal_principal:c:admin_rehearsal_source_id",
            "admin_rehearsal_principal:c:admin_rehearsal_source_status",
            "admin_rehearsal_principal:c:admin_rehearsal_source_generation",
            "admin_rehearsal_principal:c:admin_rehearsal_passkeys",
            "admin_rehearsal_principal:c:admin_rehearsal_sessions",
            "admin_rehearsal_principal:f:target_admin_id:public.admin_principal:id:saa",
            "admin_rehearsal_receipt:p:singleton",
            "admin_rehearsal_receipt:c:admin_rehearsal_singleton",
            "admin_rehearsal_receipt:c:admin_rehearsal_review_digest",
            "admin_rehearsal_receipt:c:admin_rehearsal_candidate_digest",
            "admin_rehearsal_receipt:c:admin_rehearsal_nonserving"
        };
        using var catalogDigest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        await using var observed = await constraints.ExecuteReaderAsync(ct);
        while (await observed.ReadAsync(ct))
        {
            var signature = observed.GetString(0);
            if (!required.Remove(signature))
                throw new InvalidOperationException("The administrator quarantine has unexpected integrity constraints.");
            AppendLegacyValue(catalogDigest, signature);
            AppendLegacyValue(catalogDigest, observed.IsDBNull(1) ? null : observed.GetString(1));
        }
        if (required.Count != 0)
            throw new InvalidOperationException("The administrator quarantine has missing integrity constraints.");
        return Convert.ToHexStringLower(catalogDigest.GetHashAndReset());
    }
}
