-- Build Mode can work on an existing GitHub repository: the project is cloned into the sandbox and
-- the agent can open a pull request with its changes. Remember which repo/branch a project came from.
alter table public.build_projects add column if not exists repo text;
alter table public.build_projects add column if not exists repo_branch text;
