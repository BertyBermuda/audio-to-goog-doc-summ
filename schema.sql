-- Run this in the Supabase SQL editor.

create table if not exists public.jobs (
  id           uuid primary key default gen_random_uuid(),
  status       text not null default 'queued'
                 check (status in ('queued', 'processing', 'done', 'error')),
  file_name    text,
  storage_path text not null,
  doc_url      text,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists jobs_created_at_idx on public.jobs (created_at desc);

-- Every route reaches this table with the service_role key, which bypasses RLS.
-- Enabling RLS with no policies means a leaked anon key still reads nothing.
alter table public.jobs enable row level security;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists jobs_touch_updated_at on public.jobs;
create trigger jobs_touch_updated_at
  before update on public.jobs
  for each row execute function public.touch_updated_at();

-- Storage bucket for the uploads. Private: the extension writes through a signed
-- upload URL, and Pabbly reads through a short-lived signed download URL.
insert into storage.buckets (id, name, public)
values ('audio', 'audio', false)
on conflict (id) do nothing;

-- Optional housekeeping: drop finished jobs older than a week.
-- select cron.schedule('purge-jobs', '0 4 * * *',
--   $$delete from public.jobs where created_at < now() - interval '7 days'$$);
