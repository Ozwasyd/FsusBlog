CREATE TABLE public.comment_report (
    id bigint PRIMARY KEY CHECK (id > 0),
    article_id integer NOT NULL,
    comment_id bigint NOT NULL,
    reporter_id uuid NOT NULL REFERENCES public.blog_user (id),
    publication_id bigint NOT NULL CHECK (publication_id > 0),
    reason_code text NOT NULL CHECK (reason_code IN ('spam','harassment','hate','privacy','illegal','misinformation','other')),
    detail text CHECK (octet_length(detail) <= 3000),
    created_at timestamptz NOT NULL,
    UNIQUE (article_id, comment_id, reporter_id),
    FOREIGN KEY (article_id, comment_id) REFERENCES public.comment (article_id, id)
);
