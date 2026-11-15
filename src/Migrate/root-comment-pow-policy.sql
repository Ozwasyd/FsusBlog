CREATE TABLE public.root_comment_pow_policy (
    singleton boolean PRIMARY KEY CHECK (singleton),
    generation bigint NOT NULL CHECK (generation > 0),
    proof_seconds integer NOT NULL CHECK (proof_seconds BETWEEN 60 AND 120)
);
INSERT INTO public.root_comment_pow_policy VALUES (true, 1, 120);

CREATE TABLE public.root_comment_pow_policy_audit (
    generation bigint PRIMARY KEY CHECK (generation > 1),
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    previous_seconds integer NOT NULL CHECK (previous_seconds BETWEEN 60 AND 120),
    proof_seconds integer NOT NULL CHECK (proof_seconds BETWEEN 60 AND 120),
    rollback boolean NOT NULL,
    happened_at timestamptz NOT NULL,
    CHECK (previous_seconds <> proof_seconds)
);

CREATE TABLE public.admin_root_comment_pow_step_up (
    digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
    principal_id uuid NOT NULL REFERENCES public.admin_principal (id),
    session_digest bytea NOT NULL REFERENCES public.admin_session (digest) ON DELETE CASCADE
        CHECK (octet_length(session_digest) = 32),
    generation bigint NOT NULL CHECK (generation > 0),
    action integer NOT NULL CHECK (action = 9),
    body_digest bytea NOT NULL CHECK (octet_length(body_digest) = 32),
    options text CHECK (octet_length(options) BETWEEN 1 AND 8192),
    expires_at timestamptz NOT NULL,
    kind smallint NOT NULL,
    UNIQUE (session_digest, kind),
    CHECK ((kind = 1 AND options IS NOT NULL) OR (kind = 2 AND options IS NULL))
);
