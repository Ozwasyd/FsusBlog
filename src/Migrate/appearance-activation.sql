CREATE TABLE public.appearance_activation (
    singleton boolean PRIMARY KEY CHECK (singleton),
    revision bigint NOT NULL CHECK (revision >= 0),
    theme_digest text NOT NULL CHECK (theme_digest = '' OR theme_digest ~ '^[0-9a-f]{64}$'),
    font_digest text NOT NULL CHECK (font_digest = '' OR font_digest ~ '^[0-9a-f]{64}$')
);
INSERT INTO public.appearance_activation VALUES (true, 0, '', '');

CREATE TABLE public.appearance_activation_audit (
    revision bigint PRIMARY KEY CHECK (revision > 0),
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    rollback boolean NOT NULL,
    previous_theme_digest text NOT NULL,
    previous_font_digest text NOT NULL,
    theme_digest text NOT NULL,
    font_digest text NOT NULL,
    happened_at timestamptz NOT NULL
);

CREATE TABLE public.admin_appearance_step_up (
    digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    session_digest bytea NOT NULL REFERENCES public.admin_session (digest) ON DELETE CASCADE
        CHECK (octet_length(session_digest) = 32),
    generation bigint NOT NULL CHECK (generation > 0),
    action integer NOT NULL CHECK (action = 4),
    body_digest bytea NOT NULL CHECK (octet_length(body_digest) = 32),
    options text CHECK (octet_length(options) BETWEEN 1 AND 8192),
    expires_at timestamptz NOT NULL,
    kind smallint NOT NULL,
    UNIQUE (session_digest, kind),
    CHECK ((kind = 1 AND options IS NOT NULL) OR (kind = 2 AND options IS NULL))
);
