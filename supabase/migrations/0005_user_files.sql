-- Per-account config files that sync like documents (currently: the snippets file).
create table user_files (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  path text not null,
  source text not null default '',
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, path)
);

create trigger user_files_touch before update on user_files for each row execute function touch_updated_at();

alter table user_files enable row level security;
create policy own_user_files on user_files for all using (user_id = auth.uid()) with check (user_id = auth.uid());
