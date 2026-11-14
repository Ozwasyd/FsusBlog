using Npgsql;

internal static partial class Migration
{
    private static async Task<int> VerifyLegacyPublishedRollbacksAsync(NpgsqlConnection target, NpgsqlTransaction tx,
        CancellationToken token)
    {
        const string shadow = ImportSchema;
        // The frozen production path restores one historical revision and writes a fresh revision, rights snapshot and release.
        await using var query = new NpgsqlCommand($"""
            SELECT p.published_at,p.source_created_at,r.happened_at,s.created_at,
                   original.happened_at,first.published_at,previous_head.happened_at,r.source_rollback_reason,
                   responsibility.created_at,
                   (
                       a.source_status=2 AND a.deleted=0 AND a.current_publication_id=p.source_publication_id
                       AND a.last_publication_number=p.publication_number AND a.current_source_revision_id=r.source_revision_id
                       AND r.revision=a.current_revision AND r.source_admin_id=a.legacy_admin_id AND r.source_admin_id>0
                       AND original.revision<previous_head.revision AND previous_head.revision=r.revision-1
                       AND original_release.publication_number<p.publication_number AND original_release.source_transition='immediate-publish'
                       AND s.canonical_url IS NULL AND source_rights.canonical_url IS NULL
                       AND (r.title,r.body,r.summary,r.cover_image_url,r.source_category_id,r.source_tag_ids)
                          IS NOT DISTINCT FROM
                           (original.title,original.body,original.summary,original.cover_image_url,
                            original.source_category_id,original.source_tag_ids)
                       AND (s.enabled,s.license_type,s.copyright_holder,s.copyright_year,s.rights_statement,s.attribution_template,
                            s.copy_policy,s.max_excerpt_chars,s.allow_code_copy,s.show_public_badge,s.proof_binding_enabled)
                          IS NOT DISTINCT FROM
                           (source_rights.enabled,source_rights.license_type,source_rights.copyright_holder,
                            source_rights.copyright_year,source_rights.rights_statement,source_rights.attribution_template,
                            source_rights.copy_policy,source_rights.max_excerpt_chars,source_rights.allow_code_copy,
                            source_rights.show_public_badge,source_rights.proof_binding_enabled)
                       AND responsibility.responsibility_version=1 AND responsibility.previous_snapshot_id IS NULL
                       AND source_responsibility.id IS NOT NULL
                       AND (responsibility.inherit_site_author,responsibility.authors_json,responsibility.reviewer_json,
                            responsibility.sources_json,responsibility.update_summary,responsibility.update_reason,
                            responsibility.effective_at,responsibility.conclusion_impact,responsibility.methodology,
                            responsibility.applicability,responsibility.limitations,responsibility.responsible_person_confirmed)
                          IS NOT DISTINCT FROM
                           (source_responsibility.inherit_site_author,source_responsibility.authors_json,
                            source_responsibility.reviewer_json,source_responsibility.sources_json,
                            source_responsibility.update_summary,source_responsibility.update_reason,
                            source_responsibility.effective_at,source_responsibility.conclusion_impact,source_responsibility.methodology,
                            source_responsibility.applicability,source_responsibility.limitations,
                            source_responsibility.responsible_person_confirmed)
                   ) AS exact_provenance
            FROM {shadow}.shadow_publication p
            JOIN {shadow}.shadow_article a ON a.id=p.article_id
            LEFT JOIN {shadow}.shadow_revision r ON r.source_revision_id=p.source_revision_id AND r.article_id=p.article_id
            LEFT JOIN {shadow}.shadow_revision original ON original.source_revision_id=r.source_rollback_revision_id
                    AND original.article_id=r.article_id
            LEFT JOIN {shadow}.shadow_revision previous_head ON previous_head.article_id=r.article_id AND previous_head.revision=r.revision-1
            LEFT JOIN {shadow}.shadow_publication first ON first.article_id=p.article_id AND first.publication_number=1
            LEFT JOIN {shadow}.shadow_publication original_release ON original_release.source_revision_id=original.source_revision_id
                    AND original_release.article_id=p.article_id
            LEFT JOIN {shadow}.shadow_article_rights_snapshot s ON s.id=p.source_rights_snapshot_id
            LEFT JOIN {shadow}.shadow_article_rights_snapshot source_rights ON source_rights.id=original_release.source_rights_snapshot_id
            LEFT JOIN {shadow}.shadow_article_responsibility_snapshot responsibility ON responsibility.id=p.source_responsibility_snapshot_id
            LEFT JOIN LATERAL (
                SELECT h.* FROM {shadow}.shadow_article_responsibility_snapshot h
                WHERE h.article_id=p.article_id AND h.article_revision_id=original.source_revision_id
                  AND h.created_at::timestamptz <= responsibility.created_at::timestamptz
                ORDER BY h.responsibility_version DESC LIMIT 1
            ) source_responsibility ON true
            WHERE p.source_transition='rollback'
            ORDER BY p.source_publication_id
            """, target, tx);
        await using var rows = await query.ExecuteReaderAsync(token);
        int verified = 0;
        while (await rows.ReadAsync(token))
        {
            if (rows.IsDBNull(9) || !rows.GetBoolean(9) || LegacyRightsText(rows, 7) is not { Length: >= 8 and <= 500 } reason ||
                reason != reason.Trim())
                throw new InvalidOperationException("A legacy published rollback lacks its exact historical source or cloned provenance.");
            var happened = ParseLegacyProjectionTimestamp(LegacyRightsText(rows, 0));
            if (Enumerable.Range(1, 3).Any(field => ParseLegacyProjectionTimestamp(LegacyRightsText(rows, field)) != happened) ||
                ParseLegacyProjectionTimestamp(LegacyRightsText(rows, 4)) > ParseLegacyProjectionTimestamp(LegacyRightsText(rows, 6)) ||
                ParseLegacyProjectionTimestamp(LegacyRightsText(rows, 6)) >= happened ||
                ParseLegacyProjectionTimestamp(LegacyRightsText(rows, 5)) >= happened ||
                ParseLegacyProjectionTimestamp(LegacyRightsText(rows, 8)) < happened)
                throw new InvalidOperationException("A legacy published rollback has inconsistent historical timestamps.");
            verified++;
        }
        return verified;
    }
}
