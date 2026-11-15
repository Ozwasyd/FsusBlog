DO $archive$
DECLARE
    existing_name name;
BEGIN
    SELECT conname INTO STRICT existing_name
    FROM pg_catalog.pg_constraint
    WHERE conrelid='public.admin_article_rollback'::regclass AND contype='c'
      AND regexp_replace(pg_get_expr(conbin,conrelid,true),'[[:space:]]','','g')='destination=ANY(ARRAY[0,2])';
    EXECUTE format('ALTER TABLE public.admin_article_rollback DROP CONSTRAINT %I', existing_name);

    SELECT conname INTO STRICT existing_name
    FROM pg_catalog.pg_constraint
    WHERE conrelid='public.admin_article_rollback_step_up'::regclass AND contype='c'
      AND regexp_replace(pg_get_expr(conbin,conrelid,true),'[[:space:]]','','g')='action=ANY(ARRAY[3,7])';
    EXECUTE format('ALTER TABLE public.admin_article_rollback_step_up DROP CONSTRAINT %I', existing_name);
END $archive$;

ALTER TABLE public.admin_article_rollback
    ADD COLUMN from_archive boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT admin_article_rollback_destination_check CHECK (destination IN (0, 2, 3)),
    ADD CONSTRAINT admin_article_rollback_archive_exit_check CHECK (NOT from_archive OR destination=2);

ALTER TABLE public.admin_article_rollback_step_up
    ADD CONSTRAINT admin_article_rollback_step_up_action_check CHECK (action IN (3, 7, 8));
