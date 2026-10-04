create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  business_id uuid,
  role text not null default 'collaborator'
    check (role in ('owner', 'admin', 'collaborator')),
  created_at timestamptz not null default now()
);

create or replace function public.current_business_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select business_id from public.profiles where id = auth.uid()
$$;

create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.create_collaborator_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role) values (new.id, 'collaborator');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.create_collaborator_profile();

create table if not exists public.active_vehicles (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  plate text not null,
  vehicle_type text not null check (vehicle_type in ('Carro', 'Moto')),
  entry_at timestamptz not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create unique index if not exists active_vehicles_business_plate
  on public.active_vehicles (business_id, upper(plate));

create table if not exists public.active_vehicle_rates (
  vehicle_id uuid primary key references public.active_vehicles(id) on delete cascade,
  business_id uuid not null,
  hourly_rate numeric(12, 2) not null check (hourly_rate >= 0)
);

create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  plate text not null,
  customer_name text not null,
  phone text,
  starts_at date not null,
  ends_at date not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.membership_prices (
  membership_id uuid primary key references public.memberships(id) on delete cascade,
  business_id uuid not null,
  monthly_rate numeric(12, 2) not null check (monthly_rate >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  receipt_number text not null,
  category text not null check (category in ('parking', 'membership', 'sale')),
  plate text,
  description text,
  amount numeric(12, 2) not null check (amount >= 0),
  hourly_rate numeric(12, 2) check (hourly_rate is null or hourly_rate >= 0),
  charged_hours integer check (charged_hours is null or charged_hours >= 0),
  entry_at timestamptz,
  exit_at timestamptz,
  paid_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  description text not null,
  amount numeric(12, 2) not null check (amount >= 0),
  paid_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.active_vehicles enable row level security;
alter table public.active_vehicle_rates enable row level security;
alter table public.memberships enable row level security;
alter table public.membership_prices enable row level security;
alter table public.transactions enable row level security;
alter table public.expenses enable row level security;

grant select on public.profiles to authenticated;
grant select, insert, update, delete on
  public.active_vehicles,
  public.active_vehicle_rates,
  public.memberships,
  public.membership_prices,
  public.transactions,
  public.expenses
to authenticated;

drop policy if exists "read own profile and business users" on public.profiles;
create policy "read own profile and business users"
  on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or (
      business_id = public.current_business_id()
      and public.current_app_role() in ('owner', 'admin')
    )
  );

drop policy if exists "business members operate vehicles" on public.active_vehicles;
create policy "business members operate vehicles"
  on public.active_vehicles for all to authenticated
  using (business_id = public.current_business_id())
  with check (
    business_id = public.current_business_id()
    and created_by = auth.uid()
  );

drop policy if exists "owner reads active vehicle rates" on public.active_vehicle_rates;
create policy "owner reads active vehicle rates"
  on public.active_vehicle_rates for select to authenticated
  using (
    business_id = public.current_business_id()
    and public.current_app_role() = 'owner'
  );

drop policy if exists "business members record active vehicle rates" on public.active_vehicle_rates;
create policy "business members record active vehicle rates"
  on public.active_vehicle_rates for insert to authenticated
  with check (business_id = public.current_business_id());

drop policy if exists "owner updates active vehicle rates" on public.active_vehicle_rates;
create policy "owner updates active vehicle rates"
  on public.active_vehicle_rates for update to authenticated
  using (
    business_id = public.current_business_id()
    and public.current_app_role() = 'owner'
  )
  with check (business_id = public.current_business_id());

drop policy if exists "owner deletes active vehicle rates" on public.active_vehicle_rates;
create policy "owner deletes active vehicle rates"
  on public.active_vehicle_rates for delete to authenticated
  using (
    business_id = public.current_business_id()
    and public.current_app_role() = 'owner'
  );

drop policy if exists "business members operate memberships" on public.memberships;
create policy "business members operate memberships"
  on public.memberships for all to authenticated
  using (business_id = public.current_business_id())
  with check (
    business_id = public.current_business_id()
    and created_by = auth.uid()
  );

drop policy if exists "owner reads membership prices" on public.membership_prices;
create policy "owner reads membership prices"
  on public.membership_prices for select to authenticated
  using (
    business_id = public.current_business_id()
    and public.current_app_role() = 'owner'
  );

drop policy if exists "business members record membership prices" on public.membership_prices;
create policy "business members record membership prices"
  on public.membership_prices for insert to authenticated
  with check (
    business_id = public.current_business_id()
    and public.current_app_role() in ('owner', 'admin', 'collaborator')
  );

drop policy if exists "owner updates membership prices" on public.membership_prices;
create policy "owner updates membership prices"
  on public.membership_prices for update to authenticated
  using (
    business_id = public.current_business_id()
    and public.current_app_role() = 'owner'
  )
  with check (business_id = public.current_business_id());

drop policy if exists "owner deletes membership prices" on public.membership_prices;
create policy "owner deletes membership prices"
  on public.membership_prices for delete to authenticated
  using (
    business_id = public.current_business_id()
    and public.current_app_role() = 'owner'
  );

drop policy if exists "owner reads transactions" on public.transactions;
create policy "owner reads transactions"
  on public.transactions for select to authenticated
  using (
    business_id = public.current_business_id()
    and public.current_app_role() = 'owner'
  );

drop policy if exists "business members record transactions" on public.transactions;
create policy "business members record transactions"
  on public.transactions for insert to authenticated
  with check (
    business_id = public.current_business_id()
    and created_by = auth.uid()
  );

drop policy if exists "owner edits transactions" on public.transactions;
create policy "owner edits transactions"
  on public.transactions for update to authenticated
  using (
    business_id = public.current_business_id()
    and public.current_app_role() = 'owner'
  )
  with check (business_id = public.current_business_id());

drop policy if exists "owner deletes transactions" on public.transactions;
create policy "owner deletes transactions"
  on public.transactions for delete to authenticated
  using (
    business_id = public.current_business_id()
    and public.current_app_role() = 'owner'
  );

drop policy if exists "owner reads expenses" on public.expenses;
create policy "owner reads expenses"
  on public.expenses for select to authenticated
  using (
    business_id = public.current_business_id()
    and public.current_app_role() = 'owner'
  );

drop policy if exists "business members record expenses" on public.expenses;
create policy "business members record expenses"
  on public.expenses for insert to authenticated
  with check (
    business_id = public.current_business_id()
    and created_by = auth.uid()
  );

drop policy if exists "owner edits expenses" on public.expenses;
create policy "owner edits expenses"
  on public.expenses for update to authenticated
  using (
    business_id = public.current_business_id()
    and public.current_app_role() = 'owner'
  )
  with check (business_id = public.current_business_id());

drop policy if exists "owner deletes expenses" on public.expenses;
create policy "owner deletes expenses"
  on public.expenses for delete to authenticated
  using (
    business_id = public.current_business_id()
    and public.current_app_role() = 'owner'
  );
