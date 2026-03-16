create extension if not exists "uuid-ossp";

create table if not exists tenants (
  id uuid primary key default uuid_generate_v4(),
  name text,
  created_at timestamptz not null default now()
);

create table if not exists user_tenants (
  user_id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

create table if not exists api_keys (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  key_hash text not null,
  key_prefix text not null,
  created_at timestamptz not null default now(),
  revoked boolean not null default false,
  last_used timestamptz,
  created_by uuid
);

insert into tenants (id, name)
values ('00000000-0000-0000-0000-000000000001', 'ClawSight Demo Tenant')
on conflict (id) do nothing;

-- Migration from old schema (run if upgrading):
-- ALTER TABLE api_keys RENAME COLUMN hashed_secret TO key_hash;
-- ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_prefix text;
-- ALTER TABLE api_keys DROP COLUMN IF EXISTS scopes;

-- ============================================================
-- v2: Agent persistence, budget enforcement, webhooks
-- ============================================================

create table if not exists agents (
  id text not null,
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  status text not null default 'idle',
  parent_agent_id text,
  last_heartbeat bigint,
  created_at timestamptz not null default now(),
  primary key (id, tenant_id)
);

-- Add parent_agent_id if table already existed without it
alter table agents add column if not exists parent_agent_id text;

create index if not exists idx_agents_tenant on agents(tenant_id);
create index if not exists idx_agents_parent on agents(parent_agent_id, tenant_id);

create table if not exists agent_metrics (
  agent_id text not null,
  tenant_id uuid not null,
  cost double precision not null default 0,
  revenue double precision not null default 0,
  tokens bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (agent_id, tenant_id),
  foreign key (agent_id, tenant_id) references agents(id, tenant_id) on delete cascade
);

create table if not exists agent_logs (
  id uuid primary key default uuid_generate_v4(),
  agent_id text not null,
  tenant_id uuid not null,
  message text not null,
  created_at timestamptz not null default now(),
  foreign key (agent_id, tenant_id) references agents(id, tenant_id) on delete cascade
);
create index if not exists idx_agent_logs_lookup on agent_logs(agent_id, tenant_id, created_at desc);

create table if not exists budget_rules (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_id text,
  max_cost double precision not null,
  action text not null default 'kill',
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

-- Unique constraint that treats NULL agent_id correctly (tenant-wide default)
create unique index if not exists idx_budget_rules_tenant_agent
  on budget_rules (tenant_id, coalesce(agent_id, '__tenant_default__'));

create table if not exists webhooks (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  url text not null,
  events text[] not null default '{budget_exceeded,agent_killed,agent_error}',
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
