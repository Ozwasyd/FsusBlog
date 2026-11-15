create table public.author_text_document (
    owner_id uuid not null references public.blog_user(id),
    article_id int not null,
    revision bigint not null,
    profile int not null check (profile = 1),
    title_digest bytea not null check (octet_length(title_digest) = 32),
    body_digest bytea not null check (octet_length(body_digest) = 32),
    primary key (owner_id, article_id),
    foreign key (article_id, revision) references public.article_revision(article_id, revision)
);

create table public.author_text_posting (
    owner_id uuid not null,
    article_id int not null,
    field int not null check (field between 1 and 2),
    ordinal int not null check (ordinal between 0 and 199999),
    term bytea not null check (octet_length(term) between 1 and 512),
    start_u16 int not null check (start_u16 >= 0),
    end_u16 int not null,
    start_u8 int not null check (start_u8 >= 0),
    end_u8 int not null,
    check (start_u16 < end_u16),
    check (start_u8 < end_u8),
    primary key (owner_id, term, article_id, field, ordinal),
    constraint author_text_posting_owner_article unique (owner_id, article_id, field, ordinal),
    foreign key (owner_id, article_id) references public.author_text_document(owner_id, article_id)
);

create index author_text_article_owner on public.article(owner_id, id);
