create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  business_id uuid,
  email text,
  role text not null default 'collaborator'
    check (role in ('owner', 'admin', 'collaborator')),
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists email text;

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
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'collaborator')
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.create_collaborator_profile();

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update of email on auth.users
  for each row execute procedure public.create_collaborator_profile();

update public.profiles p
set email = u.email
from auth.users u
where p.id = u.id and p.email is distinct from u.email;

create table if not exists public.active_vehicles (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  plate text not null,
  vehicle_type text not null check (vehicle_type in ('Carro', 'Moto')),
  entry_at timestamptz not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.active_vehicles add column if not exists created_by uuid references auth.users(id);
alter table public.active_vehicles add column if not exists created_at timestamptz not null default now();

/*
 * Pricing is stored separately so staff can record it without being able
 * to query rates or historical transaction totals.
 */
create table if not exists public.active_vehicle_rates (
  vehicle_id uuid primary key references public.active_vehicles(id) on delete cascade,
  business_id uuid not null,
  hourly_rate numeric(12, 2) not null check (hourly_rate >= 0)
);

/* Existing installation may already have these rate tables. */
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

alter table public.memberships add column if not exists created_by uuid references auth.users(id);
alter table public.memberships add column if not exists created_at timestamptz not null default now();

create unique index if not exists active_vehicles_business_plate
  on public.active_vehicles (business_id, upper(plate));

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
  customer_name text,
  phone text,
  amount numeric(12, 2) not null check (amount >= 0),
  hourly_rate numeric(12, 2) check (hourly_rate is null or hourly_rate >= 0),
  charged_hours integer check (charged_hours is null or charged_hours >= 0),
  duration_minutes integer check (duration_minutes is null or duration_minutes >= 0),
  entry_at timestamptz,
  exit_at timestamptz,
  starts_at date,
  ends_at date,
  paid_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.transactions add column if not exists customer_name text;
alter table public.transactions add column if not exists phone text;
alter table public.transactions add column if not exists duration_minutes integer;
alter table public.transactions add column if not exists starts_at date;
alter table public.transactions add column if not exists ends_at date;

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
drop policy if exists "business members read vehicles" on public.active_vehicles;
create policy "business members read vehicles"
  on public.active_vehicles for select to authenticated
  using (business_id = public.current_business_id())
;

drop policy if exists "business members create vehicles" on public.active_vehicles;
create policy "business members create vehicles"
  on public.active_vehicles for insert to authenticated
  with check (
    business_id = public.current_business_id()
    and created_by = auth.uid()
  );

drop policy if exists "business members edit vehicles" on public.active_vehicles;
create policy "business members edit vehicles"
  on public.active_vehicles for update to authenticated
  using (business_id = public.current_business_id())
  with check (business_id = public.current_business_id());

drop policy if exists "business members remove vehicles" on public.active_vehicles;
create policy "business members remove vehicles"
  on public.active_vehicles for delete to authenticated
  using (business_id = public.current_business_id());

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

drop policy if exists "business members update active vehicle rates" on public.active_vehicle_rates;
create policy "business members update active vehicle rates"
  on public.active_vehicle_rates for update to authenticated
  using (business_id = public.current_business_id())
  with check (business_id = public.current_business_id());

drop policy if exists "owner deletes active vehicle rates" on public.active_vehicle_rates;
create policy "owner deletes active vehicle rates"
  on public.active_vehicle_rates for delete to authenticated
  using (
    business_id = public.current_business_id()
    and public.current_app_role() = 'owner'
  );

drop policy if exists "business members operate memberships" on public.memberships;
drop policy if exists "business members read memberships" on public.memberships;
create policy "business members read memberships"
  on public.memberships for select to authenticated
  using (business_id = public.current_business_id());

drop policy if exists "business members create memberships" on public.memberships;
create policy "business members create memberships"
  on public.memberships for insert to authenticated
  with check (
    business_id = public.current_business_id()
    and created_by = auth.uid()
  );

drop policy if exists "business members update memberships" on public.memberships;
create policy "business members update memberships"
  on public.memberships for update to authenticated
  using (business_id = public.current_business_id())
  with check (business_id = public.current_business_id());

drop policy if exists "business members delete memberships" on public.memberships;
create policy "business members delete memberships"
  on public.memberships for delete to authenticated
  using (business_id = public.current_business_id());

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
drop policy if exists "business members update membership prices" on public.membership_prices;
create policy "business members update membership prices"
  on public.membership_prices for update to authenticated
  using (business_id = public.current_business_id())
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

create or replace function public.sync_business_delta(p_delta jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business_id uuid := public.current_business_id();
  v_role text := public.current_app_role();
  item jsonb;
  affected integer;
  array_key text;
begin
  if auth.uid() is null or v_business_id is null or v_role not in ('owner', 'admin', 'collaborator') then
    raise exception 'No tienes acceso a este negocio.';
  end if;
  if p_delta is null or jsonb_typeof(p_delta) is distinct from 'object' then
    raise exception 'El cambio enviado no tiene un formato válido.';
  end if;

  foreach array_key in array array[
    'active_upsert', 'active_delete', 'rates_upsert',
    'memberships_upsert', 'memberships_delete', 'membership_prices_upsert',
    'transactions_upsert', 'transactions_delete', 'expenses_upsert', 'expenses_delete'
  ] loop
    if p_delta ? array_key and jsonb_typeof(p_delta->array_key) <> 'array' then
      raise exception 'El campo % debe ser una lista.', array_key;
    end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_delta->'active_upsert', '[]'::jsonb)) as rows(value) loop
    insert into public.active_vehicles (id, business_id, plate, vehicle_type, entry_at, created_by)
    values (
      (item->>'id')::uuid, v_business_id, upper(trim(item->>'plate')),
      item->>'vehicle_type', (item->>'entry_at')::timestamptz, auth.uid()
    )
    on conflict (id) do update set
      plate = excluded.plate,
      vehicle_type = excluded.vehicle_type,
      entry_at = excluded.entry_at
    where public.active_vehicles.business_id = v_business_id;
    get diagnostics affected = row_count;
    if affected = 0 then raise exception 'El ingreso no pertenece a este negocio.'; end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_delta->'rates_upsert', '[]'::jsonb)) as rows(value) loop
    if not exists (
      select 1 from public.active_vehicles
      where id = (item->>'vehicle_id')::uuid and business_id = v_business_id
    ) then
      raise exception 'No se puede asignar una tarifa a un vehículo ajeno.';
    end if;
    insert into public.active_vehicle_rates (vehicle_id, business_id, hourly_rate)
    values ((item->>'vehicle_id')::uuid, v_business_id, (item->>'hourly_rate')::numeric)
    on conflict (vehicle_id) do update set hourly_rate = excluded.hourly_rate
    where public.active_vehicle_rates.business_id = v_business_id;
    get diagnostics affected = row_count;
    if affected = 0 then raise exception 'La tarifa no pertenece a este negocio.'; end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_delta->'active_delete', '[]'::jsonb)) as rows(value) loop
    delete from public.active_vehicles
    where id = (item #>> '{}')::uuid and business_id = v_business_id;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_delta->'memberships_upsert', '[]'::jsonb)) as rows(value) loop
    insert into public.memberships (id, business_id, plate, customer_name, phone, starts_at, ends_at, created_by)
    values (
      (item->>'id')::uuid, v_business_id, upper(trim(item->>'plate')),
      trim(item->>'customer_name'), nullif(trim(item->>'phone'), ''),
      (item->>'starts_at')::date, (item->>'ends_at')::date, auth.uid()
    )
    on conflict (id) do update set
      plate = excluded.plate,
      customer_name = excluded.customer_name,
      phone = excluded.phone,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at
    where public.memberships.business_id = v_business_id;
    get diagnostics affected = row_count;
    if affected = 0 then raise exception 'La mensualidad no pertenece a este negocio.'; end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_delta->'membership_prices_upsert', '[]'::jsonb)) as rows(value) loop
    if not exists (
      select 1 from public.memberships
      where id = (item->>'membership_id')::uuid and business_id = v_business_id
    ) then
      raise exception 'No se puede asignar un precio a una mensualidad ajena.';
    end if;
    insert into public.membership_prices (membership_id, business_id, monthly_rate)
    values ((item->>'membership_id')::uuid, v_business_id, (item->>'monthly_rate')::numeric)
    on conflict (membership_id) do update set monthly_rate = excluded.monthly_rate
    where public.membership_prices.business_id = v_business_id;
    get diagnostics affected = row_count;
    if affected = 0 then raise exception 'El precio no pertenece a este negocio.'; end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_delta->'memberships_delete', '[]'::jsonb)) as rows(value) loop
    delete from public.memberships
    where id = (item #>> '{}')::uuid and business_id = v_business_id;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_delta->'transactions_upsert', '[]'::jsonb)) as rows(value) loop
    if v_role = 'owner' then
      insert into public.transactions (
        id, business_id, receipt_number, category, plate, description, customer_name, phone,
        amount, hourly_rate, charged_hours, duration_minutes, entry_at, exit_at,
        starts_at, ends_at, paid_at, created_by
      ) values (
        (item->>'id')::uuid, v_business_id, item->>'receipt_number', item->>'category',
        nullif(item->>'plate', ''), nullif(item->>'description', ''),
        nullif(item->>'customer_name', ''), nullif(item->>'phone', ''),
        (item->>'amount')::numeric, (item->>'hourly_rate')::numeric,
        (item->>'charged_hours')::integer, (item->>'duration_minutes')::integer,
        (item->>'entry_at')::timestamptz, (item->>'exit_at')::timestamptz,
        (item->>'starts_at')::date, (item->>'ends_at')::date,
        (item->>'paid_at')::timestamptz, auth.uid()
      )
      on conflict (id) do update set
        receipt_number = excluded.receipt_number,
        category = excluded.category,
        plate = excluded.plate,
        description = excluded.description,
        customer_name = excluded.customer_name,
        phone = excluded.phone,
        amount = excluded.amount,
        hourly_rate = excluded.hourly_rate,
        charged_hours = excluded.charged_hours,
        duration_minutes = excluded.duration_minutes,
        entry_at = excluded.entry_at,
        exit_at = excluded.exit_at,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        paid_at = excluded.paid_at
      where public.transactions.business_id = v_business_id;
      get diagnostics affected = row_count;
      if affected = 0 then raise exception 'El movimiento no pertenece a este negocio.'; end if;
    else
      insert into public.transactions (
        id, business_id, receipt_number, category, plate, description, customer_name, phone,
        amount, hourly_rate, charged_hours, duration_minutes, entry_at, exit_at,
        starts_at, ends_at, paid_at, created_by
      ) values (
        (item->>'id')::uuid, v_business_id, item->>'receipt_number', item->>'category',
        nullif(item->>'plate', ''), nullif(item->>'description', ''),
        nullif(item->>'customer_name', ''), nullif(item->>'phone', ''),
        (item->>'amount')::numeric, (item->>'hourly_rate')::numeric,
        (item->>'charged_hours')::integer, (item->>'duration_minutes')::integer,
        (item->>'entry_at')::timestamptz, (item->>'exit_at')::timestamptz,
        (item->>'starts_at')::date, (item->>'ends_at')::date,
        (item->>'paid_at')::timestamptz, auth.uid()
      )
      on conflict (id) do nothing;
    end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_delta->'transactions_delete', '[]'::jsonb)) as rows(value) loop
    if v_role <> 'owner' then raise exception 'Solo el dueño puede eliminar movimientos.'; end if;
    delete from public.transactions
    where id = (item #>> '{}')::uuid and business_id = v_business_id;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_delta->'expenses_upsert', '[]'::jsonb)) as rows(value) loop
    if v_role = 'owner' then
      insert into public.expenses (id, business_id, description, amount, paid_at, created_by)
      values (
        (item->>'id')::uuid, v_business_id, trim(item->>'description'),
        (item->>'amount')::numeric, (item->>'paid_at')::timestamptz, auth.uid()
      )
      on conflict (id) do update set
        description = excluded.description,
        amount = excluded.amount,
        paid_at = excluded.paid_at
      where public.expenses.business_id = v_business_id;
      get diagnostics affected = row_count;
      if affected = 0 then raise exception 'La salida no pertenece a este negocio.'; end if;
    else
      insert into public.expenses (id, business_id, description, amount, paid_at, created_by)
      values (
        (item->>'id')::uuid, v_business_id, trim(item->>'description'),
        (item->>'amount')::numeric, (item->>'paid_at')::timestamptz, auth.uid()
      )
      on conflict (id) do nothing;
    end if;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_delta->'expenses_delete', '[]'::jsonb)) as rows(value) loop
    if v_role <> 'owner' then raise exception 'Solo el dueño puede eliminar salidas.'; end if;
    delete from public.expenses
    where id = (item #>> '{}')::uuid and business_id = v_business_id;
  end loop;
end;
$$;

revoke all on function public.sync_business_delta(jsonb) from public;
grant execute on function public.sync_business_delta(jsonb) to authenticated;
