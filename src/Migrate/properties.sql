CREATE TABLE public.property_schema (
    owner_id uuid PRIMARY KEY REFERENCES public.blog_user(id),
    revision bigint NOT NULL CHECK (revision >= 0)
);

CREATE TABLE public.property_definition (
    owner_id uuid NOT NULL REFERENCES public.property_schema(owner_id),
    id uuid NOT NULL,
    machine_key text NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    digest text NOT NULL CHECK (char_length(digest) = 64),
    shape jsonb NOT NULL,
    PRIMARY KEY (owner_id, id),
    UNIQUE (owner_id, machine_key)
);

CREATE TABLE public.property_schema_command (
    owner_id uuid NOT NULL REFERENCES public.property_schema(owner_id),
    request_id uuid NOT NULL,
    receipt jsonb NOT NULL,
    PRIMARY KEY (owner_id, request_id)
);

CREATE TABLE public.property_article (
    article_id integer PRIMARY KEY REFERENCES public.article(id),
    owner_id uuid NOT NULL REFERENCES public.property_schema(owner_id),
    revision bigint NOT NULL CHECK (revision > 0),
    UNIQUE (article_id, owner_id)
);

CREATE TABLE public.property_text_value (
    article_id integer NOT NULL,
    owner_id uuid NOT NULL,
    definition_id uuid NOT NULL,
    value text NOT NULL CHECK (char_length(value) <= 16384),
    PRIMARY KEY (article_id, definition_id),
    FOREIGN KEY (article_id, owner_id) REFERENCES public.property_article(article_id, owner_id),
    FOREIGN KEY (owner_id, definition_id) REFERENCES public.property_definition(owner_id, id)
);

CREATE TABLE public.property_value_command (
    article_id integer NOT NULL REFERENCES public.property_article(article_id),
    request_id uuid NOT NULL,
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
    definition_id uuid NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    PRIMARY KEY (article_id, request_id)
);

CREATE INDEX property_value_by_definition ON public.property_text_value(owner_id, definition_id);
