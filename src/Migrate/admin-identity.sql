CREATE TABLE public.admin_identity_schema (
    singleton boolean PRIMARY KEY CHECK (singleton),
    version integer NOT NULL CHECK (version = 6)
);
INSERT INTO public.admin_identity_schema (singleton, version) VALUES (true, 6);

CREATE TABLE public.admin_principal (
    id uuid PRIMARY KEY,
    handle text NOT NULL UNIQUE CHECK (handle ~ '^[a-z][a-z0-9_.-]{0,63}$'),
    user_handle bytea NOT NULL UNIQUE CHECK (octet_length(user_handle) = 32),
    enabled boolean NOT NULL,
    generation bigint NOT NULL CHECK (generation > 0),
    generation_changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.admin_permission (
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    permission text NOT NULL CHECK (permission = 'admin.manage' OR permission = 'audit.read' OR permission = 'comment.moderate' OR permission = 'article.write'),
    PRIMARY KEY (principal_id, permission)
);

CREATE TABLE public.admin_passkey_credential (
    credential_id bytea PRIMARY KEY CHECK (octet_length(credential_id) BETWEEN 1 AND 1023),
    principal_id uuid NOT NULL UNIQUE REFERENCES public.admin_principal (id),
    public_key bytea NOT NULL CHECK (octet_length(public_key) BETWEEN 1 AND 16384),
    sign_count bigint NOT NULL CHECK (sign_count BETWEEN 0 AND 4294967295),
    backup_eligible boolean NOT NULL,
    backed_up boolean NOT NULL CHECK (NOT backed_up OR backup_eligible)
);

CREATE TABLE public.admin_invitation (
    digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
    principal_id uuid NOT NULL UNIQUE REFERENCES public.admin_principal (id),
    generation bigint NOT NULL CHECK (generation > 0),
    expires_at timestamptz NOT NULL
);

CREATE TABLE public.admin_challenge (
    digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
    principal_id uuid REFERENCES public.admin_principal (id),
    generation bigint,
    binding_digest bytea NOT NULL CHECK (octet_length(binding_digest) = 32),
    kind integer NOT NULL,
    options text NOT NULL CHECK (octet_length(options) BETWEEN 1 AND 8192),
    expires_at timestamptz NOT NULL,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((kind = 1 AND principal_id IS NULL AND generation IS NULL) OR
           (kind = 2 AND principal_id IS NOT NULL AND generation IS NOT NULL AND generation > 0))
);
CREATE INDEX admin_challenge_expires ON public.admin_challenge (expires_at);
CREATE INDEX admin_challenge_principal ON public.admin_challenge (principal_id);

CREATE TABLE public.admin_session (
    digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
    principal_id uuid NOT NULL UNIQUE REFERENCES public.admin_principal (id),
    generation bigint NOT NULL CHECK (generation > 0),
    expires_at timestamptz NOT NULL
);

CREATE TABLE public.admin_identity_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    action text NOT NULL CHECK (octet_length(action) BETWEEN 1 AND 48),
    happened_at timestamptz NOT NULL,
    actor text NOT NULL CHECK (octet_length(actor) BETWEEN 1 AND 255)
);
