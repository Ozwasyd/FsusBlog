CREATE TABLE public.admin_sign_in (
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    id bigint GENERATED ALWAYS AS IDENTITY,
    started_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > started_at),
    ended_at timestamptz CHECK (ended_at >= started_at AND ended_at <= expires_at),
    PRIMARY KEY (principal_id, id)
);

ALTER TABLE public.admin_session ADD COLUMN sign_in_id bigint;
ALTER TABLE public.admin_session ADD CONSTRAINT admin_session_sign_in_fkey
    FOREIGN KEY (principal_id, sign_in_id) REFERENCES public.admin_sign_in (principal_id, id);

ALTER TABLE public.admin_identity_schema DROP CONSTRAINT admin_identity_schema_version_check;
UPDATE public.admin_identity_schema SET version = 8 WHERE singleton AND version = 7;
ALTER TABLE public.admin_identity_schema ADD CONSTRAINT admin_identity_schema_version_check CHECK (version = 8);
