create table public.author_recent_open_collection (
    site_id uuid not null,
    owner_id uuid not null references public.blog_user(id),
    revision bigint not null check (revision > 0),
    primary key (site_id, owner_id)
);

create table public.author_recent_open (
    site_id uuid not null,
    owner_id uuid not null,
    article_id integer not null references public.article(id),
    article_revision bigint not null check (article_revision > 0),
    sequence bigint not null check (sequence > 0),
    opened_at timestamptz not null,
    primary key (site_id, owner_id, article_id),
    unique (site_id, owner_id, sequence),
    foreign key (site_id, owner_id) references public.author_recent_open_collection(site_id, owner_id)
);

create table public.author_recent_open_receipt (
    site_id uuid not null,
    owner_id uuid not null,
    request_id uuid not null,
    article_id integer not null,
    article_revision bigint not null check (article_revision > 0),
    sequence bigint not null check (sequence > 0),
    opened_at timestamptz not null,
    primary key (site_id, owner_id, request_id),
    unique (site_id, owner_id, sequence),
    foreign key (site_id, owner_id) references public.author_recent_open_collection(site_id, owner_id)
);
