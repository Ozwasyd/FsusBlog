create table public.comment_account_owner (
    article_id integer not null,
    comment_id bigint not null,
    user_id uuid not null references public.blog_user(id),
    primary key (article_id, comment_id),
    unique (comment_id),
    unique (article_id, comment_id, user_id),
    foreign key (article_id, comment_id) references public.comment(article_id, id)
);

create table public.comment_author_delete_challenge (
    digest bytea primary key check (octet_length(digest)=32),
    article_id integer not null,
    comment_id bigint not null,
    user_id uuid not null,
    session_digest bytea not null check (octet_length(session_digest)=32),
    generation bigint not null check (generation>0),
    comment_version bigint not null check (comment_version>0),
    expires_at timestamptz not null,
    foreign key (article_id, comment_id, user_id) references public.comment_account_owner(article_id, comment_id, user_id),
    unique (article_id, comment_id, session_digest)
);

create index comment_author_delete_expiry on public.comment_author_delete_challenge(expires_at);

create table public.comment_author_deleted (
    article_id integer not null,
    comment_id bigint not null,
    user_id uuid not null,
    comment_version bigint not null check (comment_version>1),
    moderation_status smallint not null check (moderation_status between 0 and 3),
    body_digest bytea not null check (octet_length(body_digest)=32),
    happened_at timestamptz not null,
    primary key (article_id, comment_id),
    foreign key (article_id, comment_id, user_id) references public.comment_account_owner(article_id, comment_id, user_id)
);

create table public.comment_author_delete_outbox (
    article_id integer not null,
    comment_id bigint not null,
    event_type text not null check (event_type='CommentDeleted'),
    primary key (article_id, comment_id),
    foreign key (article_id, comment_id) references public.comment_author_deleted(article_id, comment_id)
);
