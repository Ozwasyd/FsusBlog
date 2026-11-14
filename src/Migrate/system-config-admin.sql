ALTER TABLE public.admin_permission DROP CONSTRAINT admin_permission_permission_check;
ALTER TABLE public.admin_permission ADD CONSTRAINT admin_permission_permission_check
    CHECK (permission = 'admin.manage' OR permission = 'audit.read' OR permission = 'comment.moderate' OR permission = 'article.write' OR permission = 'system.config');

ALTER TABLE public.admin_identity_schema DROP CONSTRAINT admin_identity_schema_version_check;
UPDATE public.admin_identity_schema SET version = 7 WHERE singleton AND version = 6;
ALTER TABLE public.admin_identity_schema ADD CONSTRAINT admin_identity_schema_version_check CHECK (version = 7);
