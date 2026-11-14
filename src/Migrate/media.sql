CREATE TABLE public.private_media (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES public.blog_user (id),
    command_id uuid NOT NULL,
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
    name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255),
    format smallint NOT NULL CHECK (format >= 1 AND format <= 2),
    length integer NOT NULL CHECK (length BETWEEN 1 AND 20971520),
    width integer NOT NULL CHECK (width BETWEEN 1 AND 8192),
    height integer NOT NULL CHECK (height BETWEEN 1 AND 8192),
    phase smallint NOT NULL CHECK (phase >= 0 AND phase <= 3),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, command_id)
);

CREATE INDEX private_media_owner_listing ON public.private_media (owner_id, created_at DESC, id DESC) WHERE phase = 1;
