CREATE TABLE public.admin_comment_batch (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    session_reference bytea NOT NULL CHECK (octet_length(session_reference) = 32),
    decision smallint NOT NULL CHECK (decision BETWEEN 1 AND 2),
    item_count integer NOT NULL CHECK (item_count BETWEEN 2 AND 20),
    decided_at timestamptz NOT NULL
);

CREATE INDEX admin_comment_batch_principal ON public.admin_comment_batch (principal_id, id DESC);

CREATE TABLE public.admin_comment_batch_item (
    batch_id bigint NOT NULL REFERENCES public.admin_comment_batch (id),
    moderation_id bigint NOT NULL UNIQUE REFERENCES public.admin_comment_moderation (id),
    PRIMARY KEY (batch_id, moderation_id)
);

CREATE TABLE public.admin_comment_batch_step_up (
    digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    session_digest bytea NOT NULL REFERENCES public.admin_session (digest) ON DELETE CASCADE
        CHECK (octet_length(session_digest) = 32),
    generation bigint NOT NULL CHECK (generation > 0),
    action integer NOT NULL CHECK (action = 6),
    body_digest bytea NOT NULL CHECK (octet_length(body_digest) = 32),
    options text CHECK (octet_length(options) BETWEEN 1 AND 8192),
    expires_at timestamptz NOT NULL,
    kind smallint NOT NULL,
    UNIQUE (session_digest, kind),
    CHECK ((kind = 1 AND options IS NOT NULL) OR (kind = 2 AND options IS NULL))
);
