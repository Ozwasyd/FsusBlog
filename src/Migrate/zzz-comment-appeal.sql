CREATE TABLE public.comment_appeal_challenge (
    digest bytea PRIMARY KEY CHECK (octet_length(digest)=32),
    article_id integer NOT NULL,
    comment_id bigint NOT NULL,
    user_id uuid NOT NULL,
    session_digest bytea NOT NULL CHECK (octet_length(session_digest)=32),
    generation bigint NOT NULL CHECK (generation>0),
    adverse_id bigint NOT NULL REFERENCES public.admin_comment_moderation(id),
    comment_version bigint NOT NULL CHECK (comment_version>0),
    expires_at timestamptz NOT NULL,
    UNIQUE (article_id,comment_id,session_digest),
    FOREIGN KEY (article_id,comment_id,user_id) REFERENCES public.comment_account_owner(article_id,comment_id,user_id)
);

CREATE TABLE public.comment_appeal (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    article_id integer NOT NULL,
    comment_id bigint NOT NULL,
    user_id uuid NOT NULL,
    adverse_id bigint NOT NULL UNIQUE REFERENCES public.admin_comment_moderation(id),
    comment_version bigint NOT NULL CHECK (comment_version>1),
    reason text NOT NULL CHECK (octet_length(reason) BETWEEN 10 AND 4000),
    submitted_at timestamptz NOT NULL,
    FOREIGN KEY (article_id,comment_id,user_id) REFERENCES public.comment_account_owner(article_id,comment_id,user_id)
);

CREATE TABLE public.comment_appeal_decision (
    appeal_id bigint PRIMARY KEY REFERENCES public.comment_appeal(id),
    principal_id uuid NOT NULL REFERENCES public.admin_principal(id),
    session_reference bytea NOT NULL CHECK (octet_length(session_reference)=32),
    granted boolean NOT NULL,
    reason text NOT NULL CHECK (octet_length(reason) BETWEEN 10 AND 4000),
    decided_at timestamptz NOT NULL
);

CREATE TABLE public.comment_appeal_event (
    appeal_id bigint NOT NULL REFERENCES public.comment_appeal(id),
    kind smallint NOT NULL CHECK (kind BETWEEN 1 AND 2),
    previous_status smallint NOT NULL CHECK (previous_status=2),
    next_status smallint NOT NULL CHECK (next_status BETWEEN 1 AND 2),
    occurred_at timestamptz NOT NULL,
    PRIMARY KEY (appeal_id,kind)
);

CREATE TABLE public.comment_appeal_admin_step_up (
    digest bytea PRIMARY KEY CHECK (octet_length(digest)=32),
    principal_id uuid NOT NULL REFERENCES public.admin_principal(id),
    session_digest bytea NOT NULL REFERENCES public.admin_session(digest) ON DELETE CASCADE CHECK (octet_length(session_digest)=32),
    generation bigint NOT NULL CHECK (generation>0),
    action integer NOT NULL CHECK (action=5),
    body_digest bytea NOT NULL CHECK (octet_length(body_digest)=32),
    options text,
    expires_at timestamptz NOT NULL,
    kind smallint NOT NULL CHECK (kind BETWEEN 1 AND 2),
    UNIQUE (session_digest,kind)
);

CREATE INDEX comment_appeal_owner ON public.comment_appeal(article_id,comment_id);
CREATE INDEX comment_appeal_adverse ON public.admin_comment_moderation(article_id,comment_id,id);
CREATE INDEX comment_appeal_challenge_expiry ON public.comment_appeal_challenge(expires_at);
