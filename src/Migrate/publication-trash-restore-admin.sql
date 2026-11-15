-- Apply after the independent administrator identity schema on new installations.
CREATE TABLE public.admin_article_trash_restore (
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    command_id uuid NOT NULL,
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
    article_id integer NOT NULL,
    previous_revision bigint NOT NULL,
    revision bigint NOT NULL,
    happened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (principal_id, command_id),
    UNIQUE (article_id, revision),
    FOREIGN KEY (article_id, previous_revision) REFERENCES public.article_revision (article_id, revision),
    FOREIGN KEY (article_id, revision) REFERENCES public.article_revision (article_id, revision),
    CHECK (previous_revision = revision - 1)
);

CREATE TABLE public.admin_article_trash_step_up (
    digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    session_digest bytea NOT NULL REFERENCES public.admin_session (digest) ON DELETE CASCADE
        CHECK (octet_length(session_digest) = 32),
    generation bigint NOT NULL CHECK (generation > 0),
    action integer NOT NULL CHECK (action = 10),
    body_digest bytea NOT NULL CHECK (octet_length(body_digest) = 32),
    options text CHECK (octet_length(options) BETWEEN 1 AND 8192),
    expires_at timestamptz NOT NULL,
    kind smallint NOT NULL,
    UNIQUE (session_digest, kind),
    CHECK ((kind = 1 AND options IS NOT NULL) OR (kind = 2 AND options IS NULL))
);
