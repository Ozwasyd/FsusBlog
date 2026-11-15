ALTER TABLE public.admin_article_rollback
    ADD COLUMN destination integer NOT NULL DEFAULT 2,
    ADD CONSTRAINT admin_article_rollback_destination_check CHECK (destination IN (0, 2));

DO $action$
DECLARE
    existing_name name;
BEGIN
    SELECT conname INTO STRICT existing_name
    FROM pg_catalog.pg_constraint
    WHERE conrelid='public.admin_article_rollback_step_up'::regclass AND contype='c'
      AND regexp_replace(pg_get_expr(conbin,conrelid,true),'[[:space:]]','','g')='action=3';
    EXECUTE format('ALTER TABLE public.admin_article_rollback_step_up DROP CONSTRAINT %I', existing_name);
END $action$;

ALTER TABLE public.admin_article_rollback_step_up
    ADD CONSTRAINT admin_article_rollback_step_up_action_check CHECK (action IN (3, 7));
