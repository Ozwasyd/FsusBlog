using System.Globalization;
using FsusBlog.V2.Core.Content;
using Npgsql;

internal static partial class Migration
{
    private sealed record ProjectionRelation(string Name, string Columns, string Query, bool Identity = false,
        string[]? TagKeys = null, int[]? TagIds = null);
    private static readonly (string Name, string Source, string Column, long Limit)[] ProjectionSequences =
    [
        ("article_id_seq", "shadow_article", "id", int.MaxValue),
        ("category_id_seq", "shadow_category", "id", int.MaxValue),
        ("tag_id_seq", "shadow_tag", "id", int.MaxValue),
        ("article_publication_publication_id_seq", "shadow_publication", "source_publication_id", long.MaxValue),
        ("article_publication_rights_id_seq", "shadow_publication", "source_rights_snapshot_id", long.MaxValue)
    ];

    private static async Task<ProjectionRelation[]> BuildProjectionRelationsAsync(NpgsqlConnection target,
        NpgsqlTransaction tx, CancellationToken token)
    {
        const string shadow = ImportSchema;
        var aliases = new Dictionary<string, int>(StringComparer.Ordinal);
        await using (var names = new NpgsqlCommand($"""
            SELECT name,id,false FROM {shadow}.shadow_tag
            UNION ALL
            SELECT normalized_name,tag_id,true FROM {shadow}.shadow_tag_url_alias
            """, target, tx))
        await using (var rows = await names.ExecuteReaderAsync(token))
        {
            while (await rows.ReadAsync(token))
            {
                var spelling = rows.GetString(0);
                var key = rows.GetBoolean(2) ? spelling : TaxonomyNames.TagLookupKey(spelling);
                if (key is null) throw new InvalidOperationException("A legacy tag has no exact current URL lookup identity.");
                var id = checked((int)rows.GetInt64(1));
                if (!aliases.TryAdd(key, id) && aliases[key] != id)
                    throw new InvalidOperationException("Legacy tag aliases cannot be projected without an explicit collision resolution.");
            }
        }

        // Parameter arrays are constructed from the same sorted vocabulary for insertion and independent readback.
        var sortedAliases = aliases.OrderBy(entry => entry.Key, StringComparer.Ordinal).ToArray();
        return [
            new("category", "id,name,description", $"SELECT id::int,name,description FROM {shadow}.shadow_category"),
            new("tag", "id,name,description", $"SELECT id::int,name,description FROM {shadow}.shadow_tag"),
            new("tag_url_name", "name_key,tag_id",
                "SELECT name_key,tag_id FROM unnest(@tag_keys::text[],@tag_ids::int[]) AS links(name_key,tag_id)",
                TagKeys: sortedAliases.Select(entry => entry.Key).ToArray(),
                TagIds: sortedAliases.Select(entry => entry.Value).ToArray()),
            new("article", "id,owner_id,revision,title,body,published_revision,publication_count,deleted,created_at,updated_at", $"""
                SELECT id::int,owner_id::uuid,current_revision,title,body,current_public_revision_candidate,
                    last_publication_number::int,deleted=1,created_at::timestamptz,updated_at::timestamptz
                FROM {shadow}.shadow_article
                """, Identity: true),
            new("article_revision", "article_id,revision,title,body,happened_at", $"""
                SELECT article_id::int,revision,title,body,happened_at::timestamptz FROM {shadow}.shadow_revision
                """),
            new("article_revision_category", "article_id,revision,category_id", $"""
                SELECT article_id::int,revision,source_category_id::int FROM {shadow}.shadow_revision WHERE source_category_id>0
                """),
            new("article_revision_tag", "article_id,revision,tag_id", $"""
                SELECT r.article_id::int,r.revision,t.tag_id::int
                FROM {shadow}.shadow_revision r JOIN {shadow}.shadow_revision_tag t USING (source_revision_id)
                """),
            new("article_publication", "article_id,publication_id,revision,publication_no,published_at", $"""
                SELECT a.id::int,p.source_publication_id,p.revision,p.publication_number::int,p.published_at::timestamptz
                FROM {shadow}.shadow_article a JOIN {shadow}.shadow_publication p ON p.source_publication_id=a.current_publication_id
                WHERE a.current_public_revision_candidate IS NOT NULL
                """),
            new("article_publication_history",
                "article_id,event_no,revision,publication_no,publication_id,supersedes_id,kind,reason,happened_at,recorded_at,actor_id,command_id", $"""
                SELECT a.id::int,1,coalesce(p.revision,a.current_revision),a.last_publication_number::int,p.source_publication_id,
                    NULL::bigint,CASE WHEN p.source_publication_id IS NULL THEN 'retained-hidden' ELSE 'retained-active' END,
                    'pre-history',p.published_at::timestamptz,coalesce(p.source_created_at,a.updated_at)::timestamptz,
                    NULL::uuid,NULL::uuid
                FROM {shadow}.shadow_article a
                LEFT JOIN {shadow}.shadow_publication p ON p.source_publication_id=a.current_publication_id
                    AND a.current_public_revision_candidate IS NOT NULL
                WHERE a.last_publication_number>0
                """),
            new("article_revision_rights",
                "article_id,revision,enabled,license_type,copyright_holder,copyright_year,rights_statement,attribution_template," +
                "copy_policy,max_excerpt_chars,allow_code_copy,show_public_badge,proof_binding_enabled", $"""
                SELECT p.article_id::int,p.revision,s.enabled=1,s.license_type,coalesce(s.copyright_holder,''),
                    coalesce(s.copyright_year,0)::int,coalesce(s.rights_statement,''),coalesce(s.attribution_template,''),
                    s.copy_policy,s.max_excerpt_chars::int,s.allow_code_copy=1,s.show_public_badge=1,s.proof_binding_enabled=1
                FROM {shadow}.shadow_publication p JOIN {shadow}.shadow_article_rights_snapshot s ON s.id=p.source_rights_snapshot_id
                """),
            new("article_publication_rights", "id,article_id,publication_id,revision", $"""
                SELECT source_rights_snapshot_id,article_id::int,source_publication_id,revision
                FROM {shadow}.shadow_publication
                """, Identity: true)
        ];
    }

    private static NpgsqlCommand ProjectionQuery(NpgsqlConnection target, NpgsqlTransaction tx, ProjectionRelation relation,
        string sql)
    {
        var command = new NpgsqlCommand(sql, target, tx);
        if (relation.TagKeys is not null)
        {
            command.Parameters.AddWithValue("tag_keys", relation.TagKeys);
            command.Parameters.AddWithValue("tag_ids", relation.TagIds!);
        }
        return command;
    }

    private static async Task VerifyProjectionCoverageAsync(NpgsqlConnection target, NpgsqlTransaction tx, ImportBackup backup,
        ProjectionRelation[] projection, bool already, CancellationToken ct)
    {
        var (observed, media) = await ReadBackupSiteAsync(target, tx, ct, excludedSchema: ImportSchema);
        var original = backup.Site.Relations.ToDictionary(row => row.Name, StringComparer.Ordinal);
        var touched = projection.Select(row => row.Name).Concat(ProjectionSequences.Select(row => row.Name)).ToHashSet(StringComparer.Ordinal);
        if (media.Count != 0 || observed.Count != original.Count || backup.Site.PostgreSqlMajor !=
            target.PostgreSqlVersion.Major.ToString(CultureInfo.InvariantCulture))
            throw new InvalidOperationException("The quarantined candidate no longer matches its pre-projection backup coverage.");
        foreach (var relation in observed)
            if (!original.TryGetValue(relation.Name, out var expected) || relation.Kind != expected.Kind ||
                relation.Name == "v2_schema" && relation.Rows != expected.Rows ||
                relation.Name != "v2_schema" && (!already || !touched.Contains(relation.Name)) && relation != expected ||
                relation.Kind == "r" && expected.Rows > 0 && relation.Name != "blog_user" &&
                    !await IsPristineLegacyCandidateSeedAsync(target, tx, relation.Name, ct))
                throw new InvalidOperationException($"Candidate relation {relation.Name} differs from its permitted empty backup baseline.");
    }

    private static async Task InsertLegacyProjectionAsync(NpgsqlConnection target, NpgsqlTransaction tx,
        ProjectionRelation[] projection, CancellationToken ct)
    {
        foreach (var relation in projection)
        {
            var explicitId = relation.Identity ? "OVERRIDING SYSTEM VALUE" : "";
            try
            {
                await using var insert = ProjectionQuery(target, tx, relation,
                    $"INSERT INTO public.{relation.Name} ({relation.Columns}) {explicitId} {relation.Query}");
                await insert.ExecuteNonQueryAsync(ct);
            }
            catch (PostgresException error)
            {
                throw new InvalidOperationException($"Projection of {relation.Name} was rejected ({error.SqlState}).");
            }
        }
        // Unlike setval, ALTER RESTART rolls back with the rest of the rehearsal transaction.
        foreach (var sequence in ProjectionSequences)
        {
            long next = await ProjectionSequenceNextAsync(target, tx, sequence, ct);
            await ExecuteAsync(target, tx, $"ALTER SEQUENCE public.{sequence.Name} RESTART WITH {next.ToString(CultureInfo.InvariantCulture)}", ct);
        }
        await ExecuteAsync(target, tx, "SET CONSTRAINTS ALL IMMEDIATE", ct);
    }

    private static async Task VerifyProjectionReadbackAsync(NpgsqlConnection target, NpgsqlTransaction tx,
        ProjectionRelation[] projection, CancellationToken ct)
    {
        foreach (var relation in projection)
        {
            var stored = $"SELECT {relation.Columns} FROM public.{relation.Name}";
            var wanted = relation.Query;
            await using var difference = ProjectionQuery(target, tx, relation, $"""
                SELECT EXISTS (({stored} EXCEPT ALL {wanted}) UNION ALL ({wanted} EXCEPT ALL {stored}))
                """);
            if (await difference.ExecuteScalarAsync(ct) is not false)
                throw new InvalidOperationException($"Projected current relation {relation.Name} differs from the verified legacy coordinates.");
        }
        foreach (var sequence in ProjectionSequences)
        {
            var wanted = await ProjectionSequenceNextAsync(target, tx, sequence, ct);
            await using var command = new NpgsqlCommand($"SELECT last_value,is_called FROM public.{sequence.Name}", target, tx);
            await using var row = await command.ExecuteReaderAsync(ct);
            if (!await row.ReadAsync(ct) || row.GetInt64(0) != wanted || row.GetBoolean(1) || await row.ReadAsync(ct))
                throw new InvalidOperationException($"The isolated projection sequence {sequence.Name} no longer reserves all legacy IDs.");
        }
    }

    private static async Task<long> ProjectionSequenceNextAsync(NpgsqlConnection target, NpgsqlTransaction tx,
        (string Name, string Source, string Column, long Limit) sequence, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand($"SELECT coalesce(max({sequence.Column}),0) FROM {ImportSchema}.{sequence.Source}", target, tx);
        if (await command.ExecuteScalarAsync(ct) is not long maximum || maximum < 0 || maximum >= sequence.Limit)
            throw new InvalidOperationException($"Legacy identities exhaust the current sequence {sequence.Name}.");
        return maximum + 1;
    }
}
