-- Synced documents. Primary key is (user_id, name): names are the stable identity on every device.
create table projects (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  source text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, name)
);

create table templates (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  source text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, name)
);

-- The server clock is the version: clients compare/ratchet on updated_at, never on their own clock.
create function touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger projects_touch before update on projects for each row execute function touch_updated_at();
create trigger templates_touch before update on templates for each row execute function touch_updated_at();

alter table projects enable row level security;
alter table templates enable row level security;
create policy own_projects on projects for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_templates on templates for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Project images: "<user_id>/<project>/<file>"
insert into storage.buckets (id, name, public) values ('project-files', 'project-files', false);
create policy own_project_files on storage.objects for all
  using (bucket_id = 'project-files' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'project-files' and (storage.foldername(name))[1] = auth.uid()::text);
