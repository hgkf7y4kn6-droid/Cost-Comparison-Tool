-- VectorSales Postgres schema, v1.
--
-- Tenancy model: every tenant-owned row carries org_id and is protected by
-- row-level security keyed to the session setting app.org_id. The application
-- connects as vectorsales_app (not the table owner, no BYPASSRLS), and sets the
-- org once per transaction:  SELECT set_config('app.org_id', '<uuid>', true);
-- With no org set, every policy matches nothing (fail closed).
--
-- Apply as the database owner:  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f migrations/001_init.sql
-- Then give the app role a login:  ALTER ROLE vectorsales_app LOGIN PASSWORD '...';

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'vectorsales_app') then
    create role vectorsales_app nologin;
  end if;
end $$;

-- --- Organizations and membership -------------------------------------------
-- Not exposed to the app role directly; it resolves a user's org through
-- org_for_email() so it can never enumerate other tenants.
create table orgs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(name) between 1 and 200),
  created_at timestamptz not null default now()
);

create table memberships (
  email      text primary key check (email = lower(email)),
  org_id     uuid not null references orgs(id) on delete cascade,
  role       text not null default 'rep' check (role in ('rep', 'manager', 'cs', 'admin')),
  created_at timestamptz not null default now()
);

create function org_for_email(p_email text) returns table (org_id uuid, role text)
language sql stable security definer set search_path = public, pg_temp as $$
  select m.org_id, m.role from memberships m where m.email = lower(p_email)
$$;
revoke all on function org_for_email(text) from public;
grant execute on function org_for_email(text) to vectorsales_app;

-- --- Shared records (accounts and leads) ------------------------------------
create table records (
  org_id     uuid not null references orgs(id) on delete cascade,
  kind       text not null check (kind in ('accounts', 'leads')),
  id         text not null check (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  owner      text not null,
  data       jsonb not null check (pg_column_size(data) <= 2097152),
  updated_at timestamptz not null default now(),
  primary key (org_id, kind, id)
);
create index records_owner_idx on records (org_id, kind, owner);

create function current_org() returns uuid
language sql stable as $$
  select nullif(current_setting('app.org_id', true), '')::uuid
$$;

alter table records enable row level security;
alter table records force row level security;
create policy tenant_isolation on records
  using (org_id = current_org())
  with check (org_id = current_org());
grant select, insert, update, delete on records to vectorsales_app;

-- --- Deal timeline: append-only, hash-chained per org ------------------------
create table deal_events (
  org_id      uuid not null references orgs(id) on delete cascade,
  chain_index bigint not null,
  id          uuid not null default gen_random_uuid(),
  deal_id     text,
  account_id  text,
  actor       text not null,
  actor_type  text not null check (actor_type in ('user', 'buyer', 'system', 'ai')),
  type        text not null check (length(type) between 1 and 80),
  payload     jsonb not null default '{}'::jsonb,
  source_ref  text,
  occurred_at timestamptz not null default now(),
  prev_hash   text not null,
  hash        text not null,
  primary key (org_id, chain_index)
);
create index deal_events_deal_idx on deal_events (org_id, deal_id, occurred_at);
create index deal_events_account_idx on deal_events (org_id, account_id, occurred_at);

create function deal_event_hash(e deal_events) returns text
language sql immutable as $$
  select encode(sha256(convert_to(concat_ws('|',
    e.prev_hash, e.org_id::text, e.chain_index::text,
    coalesce(e.deal_id, ''), coalesce(e.account_id, ''),
    e.actor, e.actor_type, e.type, e.payload::text, coalesce(e.source_ref, ''),
    to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
  ), 'UTF8')), 'hex')
$$;

-- Serializes writers per org so the chain stays linear, then links the new row.
create function deal_events_chain() returns trigger
language plpgsql as $$
declare
  last_row deal_events;
begin
  perform pg_advisory_xact_lock(hashtextextended('deal_events:' || new.org_id::text, 0));
  select * into last_row from deal_events
    where org_id = new.org_id order by chain_index desc limit 1;
  new.chain_index := coalesce(last_row.chain_index, 0) + 1;
  new.prev_hash := coalesce(last_row.hash, 'genesis');
  new.hash := deal_event_hash(new);
  return new;
end $$;
create trigger deal_events_chain_bi before insert on deal_events
  for each row execute function deal_events_chain();

create function deal_events_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'deal_events is append-only';
end $$;
create trigger deal_events_no_change before update or delete on deal_events
  for each row execute function deal_events_immutable();

alter table deal_events enable row level security;
alter table deal_events force row level security;
create policy tenant_read on deal_events for select using (org_id = current_org());
create policy tenant_append on deal_events for insert with check (org_id = current_org());
grant select, insert on deal_events to vectorsales_app;

-- Walks the chain for the current org; returns the first broken index, or null.
create function verify_deal_events() returns bigint
language plpgsql stable as $$
declare
  e deal_events;
  expected_prev text := 'genesis';
  expected_index bigint := 1;
begin
  for e in select * from deal_events where org_id = current_org() order by chain_index loop
    if e.chain_index <> expected_index or e.prev_hash <> expected_prev or e.hash <> deal_event_hash(e) then
      return e.chain_index;
    end if;
    expected_prev := e.hash;
    expected_index := expected_index + 1;
  end loop;
  return null;
end $$;
grant execute on function verify_deal_events() to vectorsales_app;
grant execute on function current_org() to vectorsales_app;
