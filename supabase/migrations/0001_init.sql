create table assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null,
  created_at timestamptz not null default now()
);

create table photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  assignment_id uuid references assignments on delete set null,
  storage_path text not null,
  status text not null default 'pending' check (status in ('pending','imported')),
  ocr_latex text,
  created_at timestamptz not null default now()
);

alter table assignments enable row level security;
alter table photos enable row level security;
create policy own_assignments on assignments for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_photos on photos for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter publication supabase_realtime add table photos;

insert into storage.buckets (id, name, public) values ('photos', 'photos', false);
-- objects are stored under "<user_id>/<file>"
create policy own_photo_objects on storage.objects for all
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
