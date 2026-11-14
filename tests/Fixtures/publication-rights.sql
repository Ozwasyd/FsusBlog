-- Explicit synthetic rights for admitted fixture publications. Never use this as a production backfill.
BEGIN;
INSERT INTO public.article_revision_rights (
    article_id,revision,enabled,license_type,copyright_holder,copyright_year,rights_statement,attribution_template,
    copy_policy,max_excerpt_chars,allow_code_copy,show_public_badge,proof_binding_enabled)
SELECT article_id,revision,true,'all-rights-reserved','',0,'','','append-attribution',300,true,true,true
FROM public.article_publication
ON CONFLICT (article_id,revision) DO NOTHING;
INSERT INTO public.article_publication_rights (article_id,publication_id,revision)
SELECT article_id,publication_id,revision FROM public.article_publication
ON CONFLICT (publication_id) DO NOTHING;
COMMIT;
