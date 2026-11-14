CREATE TABLE public.site_page_content (
    slug text PRIMARY KEY CHECK (slug = 'about' OR slug = 'privacy' OR slug = 'guidelines' OR slug = 'copyright'),
    revision bigint NOT NULL,
    markdown text CHECK (octet_length(markdown) <= 600000),
    CHECK ((revision = 0 AND markdown IS NULL) OR (revision > 0 AND markdown IS NOT NULL))
);
INSERT INTO public.site_page_content (slug, revision)
    VALUES ('about', 0), ('privacy', 0), ('guidelines', 0), ('copyright', 0);

CREATE TABLE public.site_page_publish_audit (
    slug text NOT NULL REFERENCES public.site_page_content (slug),
    revision bigint NOT NULL CHECK (revision > 0),
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    previous_digest bytea NOT NULL CHECK (octet_length(previous_digest) = 32),
    next_digest bytea NOT NULL CHECK (octet_length(next_digest) = 32),
    happened_at timestamptz NOT NULL,
    PRIMARY KEY (slug, revision)
);

CREATE TABLE public.admin_site_page_step_up (
    digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    session_digest bytea NOT NULL REFERENCES public.admin_session (digest) ON DELETE CASCADE
        CHECK (octet_length(session_digest) = 32),
    generation bigint NOT NULL CHECK (generation > 0),
    action integer NOT NULL CHECK (action = 2),
    body_digest bytea NOT NULL CHECK (octet_length(body_digest) = 32),
    options text CHECK (octet_length(options) BETWEEN 1 AND 8192),
    expires_at timestamptz NOT NULL,
    kind smallint NOT NULL,
    UNIQUE (session_digest, kind),
    CHECK ((kind = 1 AND options IS NOT NULL) OR (kind = 2 AND options IS NULL))
);
