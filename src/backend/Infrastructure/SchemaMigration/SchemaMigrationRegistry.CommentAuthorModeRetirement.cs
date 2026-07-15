namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public sealed partial class SchemaMigrationRegistry
{
    private static ISchemaMigrationDescriptor BuildCommentAuthorModeRetirementMigration()
        => new SchemaMigrationDescriptor(
            "20260716-post-comment-author-mode-retirement",
            "Retire server-visible anonymous writes and isolate historical pseudonymous comments from active identity aggregation.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    DELETE FROM comment_anonymous_nullifier n
                    WHERE EXISTS (
                        SELECT 1
                        FROM comment c
                        WHERE c.author_mode = 'anonymous'
                          AND (
                              (c.anonymous_nullifier_hash = n.nullifier_hash AND c.anonymous_scope = n.scope)
                              OR c.id = n.first_comment_id
                              OR c.id = n.last_comment_id
                          )
                    );

                    UPDATE comment
                    SET author_mode = 'legacy_server_visible_pseudonymous',
                        anonymous_nullifier_hash = NULL,
                        anonymous_scope = NULL,
                        moderation_subject_hash = NULL,
                        credential_level = NULL,
                        reputation_bucket = NULL,
                        account_age_bucket = NULL
                    WHERE author_mode = 'anonymous';

                    UPDATE anonymous_comment_policy
                    SET default_author_mode = 'zk_anonymous',
                        updated_reason = 'retired_server_visible_anonymous_mode',
                        updated_at_utc = now()
                    WHERE default_author_mode NOT IN ('public', 'zk_anonymous');

                    ALTER TABLE comment ALTER COLUMN author_mode DROP DEFAULT;

                    DO $$
                    BEGIN
                        IF NOT EXISTS (
                            SELECT 1
                            FROM pg_constraint
                            WHERE conname = 'chk_comment_author_mode_v2'
                        ) THEN
                            ALTER TABLE comment
                            ADD CONSTRAINT chk_comment_author_mode_v2
                            CHECK (author_mode IN (
                                'public',
                                'zk_anonymous',
                                'legacy_server_visible_pseudonymous'
                            ));
                        END IF;
                    END $$;
                    """)
            ]);
}
