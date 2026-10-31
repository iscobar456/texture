-- "projects" become "documents", identified by a folder path like 'Physics/Week 3/HW 1'.
alter table projects rename to documents;
alter table documents rename column name to path;
alter trigger projects_touch on documents rename to documents_touch;
alter policy own_projects on documents rename to own_documents;

alter table templates rename column name to path;

-- Folders are explicit so empty ones survive. Documents imply their ancestors, but not vice versa.
create table folders (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  path text not null,
  primary key (user_id, path)
);
alter table folders enable row level security;
create policy own_folders on folders for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Image storage keeps its bucket id ('project-files'); objects live under "<user_id>/<document path>/<file>".
