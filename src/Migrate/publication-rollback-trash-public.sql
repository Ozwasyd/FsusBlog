DO $restore$
DECLARE previous_action name;
BEGIN
    SELECT conname INTO STRICT previous_action FROM pg_catalog.pg_constraint
    WHERE conrelid='public.admin_article_rollback_step_up'::regclass AND contype='c'
      AND regexp_replace(pg_get_expr(conbin,conrelid,true),'[[:space:]]','','g')='action=ANY(ARRAY[3,7,8])';
    EXECUTE format('ALTER TABLE public.admin_article_rollback_step_up DROP CONSTRAINT %I', previous_action);
END $restore$;

ALTER TABLE public.admin_article_rollback_step_up
    ADD CONSTRAINT admin_article_rollback_step_up_action_check CHECK (action IN (3,7,8,11));

ALTER TABLE public.admin_article_rollback ADD COLUMN from_trash boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT admin_article_rollback_trash_destination CHECK (NOT from_trash OR destination=2),
    ADD CONSTRAINT admin_article_rollback_disjoint_restore CHECK (NOT from_trash OR NOT from_archive);
