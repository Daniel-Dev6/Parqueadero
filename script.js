"use strict";

const STORAGE_KEY = "parqueadero-data-v1";
const state = { active: [], transactions: [], memberships: [], expenses: [] };
const byId = (id) => document.getElementById(id);
const currency = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});
const dateTimeFormat = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "short",
  timeStyle: "short",
});
const dateFormat = new Intl.DateTimeFormat("es-CO", { dateStyle: "medium" });
let toastTimeout;
let currentReceipt = null;
let pendingCheckoutId = null;
let editingRecord = null;
let reportFilters = { plate: "", from: "", to: "" };
let supabaseClient = null;
let currentProfile = null;
let persistedState = null;
let realtimeChannel = null;
let cloudWriteInProgress = false;
let cloudRefreshPending = false;
let activeUserId = null;
let pendingPasswordSetup = /type=(invite|recovery)/.test(location.hash);

const roleLabels = { owner: "Dueño", admin: "Administrador", collaborator: "Colaborador" };

function isOwner() {
  return currentProfile?.role === "owner";
}

function canManageTeam() {
  return ["owner", "admin"].includes(currentProfile?.role);
}

function applyRoleVisibility() {
  const role = currentProfile?.role;
  document.querySelectorAll("[data-role-visibility]").forEach((element) => {
    const roles = element.dataset.roleVisibility.split(",");
    element.hidden = !roles.includes(role);
  });
  document.querySelectorAll("[data-financial]").forEach((element) => {
    element.hidden = !isOwner();
  });
  document.querySelectorAll("[data-owner-only]").forEach((element) => {
    element.hidden = !isOwner();
  });
  byId("user-badge").textContent = `${currentProfile?.email || ""} · ${roleLabels[role] || ""}`;
  byId("user-badge").hidden = false;
  byId("logout-button").hidden = false;
  if (!isOwner()) {
    clearFinancialViews();
    if (!canManageTeam()) byId("team-table").replaceChildren();
  }
}

function clearFinancialViews() {
  ["stat-today", "stat-month", "report-total", "report-expense-total", "report-net",
    "report-count", "report-membership-total", "balance-sales", "balance-expenses", "balance-net"]
    .forEach((id) => { if (byId(id)) byId(id).textContent = "—"; });
  ["recent-table", "report-table", "cashflow-table", "monthly-chart"]
    .forEach((id) => { if (byId(id)) byId(id).replaceChildren(); });
  if (byId("receipt-dialog").open) byId("receipt-dialog").close();
  ["edit-dialog", "checkout-dialog"].forEach((id) => {
    if (byId(id).open) byId(id).close();
  });
  byId("edit-form").reset();
  byId("checkout-form").reset();
  byId("receipt-details").replaceChildren();
  byId("receipt-total").textContent = "";
  currentReceipt = null;
}

function showSignedOut(message = "") {
  currentProfile = null;
  activeUserId = null;
  persistedState = null;
  if (realtimeChannel) {
    supabaseClient.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  state.active = [];
  state.transactions = [];
  state.memberships = [];
  state.expenses = [];
  clearFinancialViews();
  byId("team-table").replaceChildren();
  byId("app-main").hidden = true;
  byId("auth-screen").hidden = false;
  byId("user-badge").hidden = true;
  byId("logout-button").hidden = true;
  byId("auth-message").textContent = message;
  byId("login-form").hidden = false;
  byId("password-setup-form").hidden = true;
}

function stateIsEmpty(data) {
  return data.active.length === 0 && data.transactions.length === 0 &&
    data.memberships.length === 0 && (data.expenses?.length || 0) === 0;
}

function appendUniqueRecords(current, imported, key = (record) => record.id) {
  const known = new Set(current.map(key));
  return current.concat(imported.filter((record) => {
    const recordKey = key(record);
    if (known.has(recordKey)) return false;
    known.add(recordKey);
    return true;
  }));
}

function showToast(message, isError = false) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("visible");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove("visible"), 3500);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function formatMoney(value) {
  return currency.format(Number(value) || 0);
}

function validDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function localDateTimeValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function formatDateTime(value) {
  const date = validDate(value);
  return date ? dateTimeFormat.format(date) : "Fecha inválida";
}

function formatDate(value) {
  const date = validDate(value);
  return date ? dateFormat.format(date) : "Fecha inválida";
}

function normalizePlate(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

function isValidStore(data) {
  return data && Array.isArray(data.active) &&
    Array.isArray(data.transactions) && Array.isArray(data.memberships) &&
    (data.expenses === undefined || Array.isArray(data.expenses));
}

function throwIfError(result) {
  if (result.error) throw result.error;
  return result.data;
}

async function selectBusinessRows(table, businessId, columns = "*", orderBy = "id") {
  const rows = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const page = throwIfError(await supabaseClient.from(table)
      .select(columns)
      .eq("business_id", businessId)
      .order(orderBy)
      .range(offset, offset + pageSize - 1));
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function changedRecords(current, previous) {
  const oldById = new Map(previous.map((record) => [record.id, record]));
  return current.filter((record) => JSON.stringify(record) !== JSON.stringify(oldById.get(record.id)));
}

function removedIds(previous, current) {
  const currentIds = new Set(current.map((record) => record.id));
  return previous.filter((record) => !currentIds.has(record.id)).map((record) => record.id);
}

async function cloudPersistState() {
  const previous = persistedState || { active: [], transactions: [], memberships: [], expenses: [] };
  const activeChanged = changedRecords(state.active, previous.active);
  const membershipsChanged = changedRecords(state.memberships, previous.memberships);
  const transactionsChanged = changedRecords(state.transactions, previous.transactions);
  const expensesChanged = changedRecords(state.expenses, previous.expenses);
  const ratesChanged = activeChanged.filter((vehicle) => isOwner() ||
    !previous.active.some((old) => old.id === vehicle.id));
  const pricesChanged = membershipsChanged.filter((membership) => isOwner() ||
    !previous.memberships.some((old) => old.id === membership.id));
  const payload = {
    active_upsert: activeChanged.map((vehicle) => ({
      id: vehicle.id,
      plate: vehicle.plate,
      vehicle_type: vehicle.vehicleType,
      entry_at: vehicle.entryAt,
      hourly_rate: Number(vehicle.hourlyRate) || 0,
    })),
    active_delete: removedIds(previous.active, state.active),
    memberships_upsert: membershipsChanged.map((membership) => ({
      id: membership.id,
      plate: membership.plate,
      customer_name: membership.customerName,
      phone: membership.phone || null,
      starts_at: membership.startsAt,
      ends_at: membership.endsAt,
    })),
    memberships_delete: removedIds(previous.memberships, state.memberships),
    membership_prices_upsert: pricesChanged.map((membership) => ({
      membership_id: membership.id,
      monthly_rate: Number(membership.monthlyRate) || 0,
    })),
    transactions_upsert: transactionsChanged.map((transaction) => ({
      id: transaction.id,
      receipt_number: transaction.receiptNumber || transaction.id.slice(0, 8).toUpperCase(),
      category: transaction.category,
      plate: transaction.plate || null,
      description: transaction.description || null,
      customer_name: transaction.customerName || null,
      phone: transaction.phone || null,
      amount: Number(transaction.amount) || 0,
      hourly_rate: Number.isFinite(Number(transaction.hourlyRate)) ? Number(transaction.hourlyRate) : null,
      charged_hours: Number.isFinite(Number(transaction.chargedHours)) ? Number(transaction.chargedHours) : null,
      duration_minutes: Number.isFinite(Number(transaction.durationMinutes)) ? Number(transaction.durationMinutes) : null,
      entry_at: transaction.entryAt || null,
      exit_at: transaction.exitAt || null,
      starts_at: transaction.startsAt || null,
      ends_at: transaction.endsAt || null,
      paid_at: transaction.paidAt || new Date().toISOString(),
    })),
    transactions_delete: removedIds(previous.transactions, state.transactions),
    expenses_upsert: expensesChanged.map((expense) => ({
      id: expense.id,
      description: expense.description,
      amount: Number(expense.amount) || 0,
      paid_at: expense.paidAt || new Date().toISOString(),
    })),
    expenses_delete: removedIds(previous.expenses, state.expenses),
    rates_upsert: ratesChanged.map((vehicle) => ({
      vehicle_id: vehicle.id,
      hourly_rate: Number(vehicle.hourlyRate) || 0,
    })),
  };
  const result = await supabaseClient.rpc("sync_business_delta", { p_delta: payload });
  throwIfError(result);
}

async function saveData() {
  if (!supabaseClient || !currentProfile) {
    showToast("Inicia sesión antes de guardar cambios.", true);
    return false;
  }
  if (cloudWriteInProgress) {
    showToast("Espera a que termine la sincronización actual.", true);
    return false;
  }
  const submitButtons = [...document.querySelectorAll("#app-main button[type=submit]")];
  const wasDisabled = submitButtons.map((button) => button.disabled);
  try {
    cloudWriteInProgress = true;
    submitButtons.forEach((button) => { button.disabled = true; });
    await cloudPersistState();
    persistedState = snapshotState();
    return true;
  } catch (error) {
    console.error("No se pudieron sincronizar los datos con Supabase:", error);
    showToast(`No se pudieron sincronizar los cambios: ${error.message || "verifica la conexión y los permisos."}`, true);
    return false;
  } finally {
    cloudWriteInProgress = false;
    submitButtons.forEach((button, index) => { button.disabled = wasDisabled[index]; });
    if (cloudRefreshPending) {
      cloudRefreshPending = false;
      window.setTimeout(() => loadCloudState().catch(showCloudError), 250);
    }
  }
}

async function loadCloudState() {
  const businessId = currentProfile.business_id;
  const activeRows = await selectBusinessRows("active_vehicles", businessId);
  const membershipRows = await selectBusinessRows("memberships", businessId);
  let rateByVehicle = new Map();
  let priceByMembership = new Map();
  if (isOwner()) {
    const rates = await selectBusinessRows("active_vehicle_rates", businessId, "vehicle_id,hourly_rate", "vehicle_id");
    const prices = await selectBusinessRows("membership_prices", businessId, "membership_id,monthly_rate", "membership_id");
    rateByVehicle = new Map(rates.map((row) => [row.vehicle_id, Number(row.hourly_rate)]));
    priceByMembership = new Map(prices.map((row) => [row.membership_id, Number(row.monthly_rate)]));
  }
  state.active = activeRows.map((row) => ({
    id: row.id,
    plate: row.plate,
    vehicleType: row.vehicle_type,
    entryAt: row.entry_at,
    hourlyRate: rateByVehicle.get(row.id) ?? 0,
    createdBy: row.created_by,
  }));
  state.memberships = membershipRows.map((row) => ({
    id: row.id,
    plate: row.plate,
    customerName: row.customer_name,
    phone: row.phone || "",
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    monthlyRate: priceByMembership.get(row.id) ?? 0,
    createdBy: row.created_by,
  }));
  if (isOwner()) {
    const transactionRows = await selectBusinessRows("transactions", businessId);
    const expenseRows = await selectBusinessRows("expenses", businessId);
    state.transactions = transactionRows.map((row) => ({
      id: row.id,
      receiptNumber: row.receipt_number,
      category: row.category,
      plate: row.plate || "",
      description: row.description || "",
      customerName: row.customer_name || "",
      phone: row.phone || "",
      amount: Number(row.amount),
      hourlyRate: Number(row.hourly_rate) || 0,
      chargedHours: Number(row.charged_hours) || 0,
      durationMinutes: Number(row.duration_minutes) || 0,
      entryAt: row.entry_at,
      exitAt: row.exit_at,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      paidAt: row.paid_at,
      createdBy: row.created_by,
    }));
    state.expenses = expenseRows.map((row) => ({
      id: row.id,
      description: row.description,
      amount: Number(row.amount),
      paidAt: row.paid_at,
      createdBy: row.created_by,
    }));
  } else {
    state.transactions = [];
    state.expenses = [];
  }
  persistedState = snapshotState();
  renderAll();
}

async function loadTeam() {
  if (!canManageTeam()) return;
  const profiles = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const page = throwIfError(await supabaseClient.from("profiles")
      .select("id,email,role").eq("business_id", currentProfile.business_id)
      .order("created_at").range(offset, offset + pageSize - 1));
    profiles.push(...page);
    if (page.length < pageSize) break;
  }
  byId("team-table").innerHTML = profiles.map((profile) => {
    const allowedRoles = isOwner()
      ? ["admin", "collaborator"]
      : ["collaborator"];
    const canChangeRole = profile.id !== currentProfile.id && profile.role !== "owner" &&
      (isOwner() || profile.role === "collaborator");
    return `<tr>
      <td>${escapeHtml(profile.email || "Invitación pendiente")}</td>
      <td>
        ${canChangeRole ? `<select class="team-role-select" data-role-user="${escapeHtml(profile.id)}" aria-label="Rol para ${escapeHtml(profile.email || "usuario")}">
          ${allowedRoles.map((role) => `<option value="${role}" ${profile.role === role ? "selected" : ""}>${roleLabels[role]}</option>`).join("")}
          ${profile.role === "owner" ? `<option value="owner" selected>${roleLabels.owner}</option>` : ""}
        </select>` : escapeHtml(roleLabels[profile.role] || profile.role)}
      </td>
      <td>${canChangeRole ? `<button class="button button-secondary button-small" type="button" data-save-role="${escapeHtml(profile.id)}">Guardar rol</button>` : ""}</td>
    </tr>`;
  }).join("");
  byId("team-empty").hidden = profiles.length > 0;
}

async function activateSession(session) {
  if (!session) {
    showSignedOut();
    return;
  }
  if (activeUserId === session.user.id && !byId("app-main").hidden) return;
  byId("app-main").hidden = true;
  byId("auth-screen").hidden = false;
  if (pendingPasswordSetup) {
    byId("login-form").hidden = true;
    byId("password-setup-form").hidden = false;
    byId("auth-message").textContent = "Elige una contraseña nueva para tu cuenta.";
    return;
  }
  byId("auth-message").textContent = "Cargando tus datos compartidos...";
  const profile = throwIfError(await supabaseClient.from("profiles")
    .select("id,email,business_id,role").eq("id", session.user.id).single());
  if (!profile.business_id || !roleLabels[profile.role]) {
    const message = "Tu usuario todavía no tiene un negocio y un rol asignados. Pide al dueño que complete la configuración.";
    showSignedOut(message);
    await supabaseClient.auth.signOut();
    byId("auth-message").textContent = message;
    return;
  }
  currentProfile = profile;
  activeUserId = session.user.id;
  applyRoleVisibility();
  byId("auth-screen").hidden = true;
  byId("app-main").hidden = false;
  await loadCloudState();
  if (canManageTeam()) await loadTeam();
  if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
  const tables = ["active_vehicles", "memberships"];
  if (isOwner()) tables.push("active_vehicle_rates", "membership_prices", "transactions", "expenses");
  realtimeChannel = supabaseClient.channel(`business-${profile.business_id}`);
  tables.forEach((table) => {
    realtimeChannel.on("postgres_changes", {
      event: "*",
      schema: "public",
      table,
      filter: `business_id=eq.${profile.business_id}`,
    }, () => {
      if (cloudWriteInProgress) cloudRefreshPending = true;
      else window.setTimeout(() => loadCloudState().catch(showCloudError), 250);
    });
  });
  realtimeChannel.on("postgres_changes", {
    event: "*", schema: "public", table: "profiles",
    filter: `business_id=eq.${profile.business_id}`,
  }, async (change) => {
    if (change.new?.id === currentProfile?.id) {
      try {
        const updated = throwIfError(await supabaseClient.from("profiles")
          .select("id,email,business_id,role").eq("id", currentProfile.id).single());
        if (!updated.business_id || !roleLabels[updated.role]) {
          await supabaseClient.auth.signOut();
          showSignedOut("Tu acceso fue desactivado. Contacta al dueño.");
          return;
        }
        currentProfile = updated;
        applyRoleVisibility();
        await loadCloudState();
      } catch (error) {
        showCloudError(error);
      }
    }
    if (canManageTeam()) await loadTeam().catch(showCloudError);
  });
  realtimeChannel.subscribe();
}

async function initializeSupabase() {
  const config = window.PARQUEADERO_CONFIG || {};
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    byId("setup-warning").hidden = false;
    byId("login-form").querySelector("button[type=submit]").disabled = true;
    return;
  }
  byId("setup-warning").hidden = true;
  byId("login-form").querySelector("button[type=submit]").disabled = false;
  if (!window.supabase?.createClient) {
    byId("auth-message").textContent = "No se pudo cargar el cliente de Supabase. Verifica la conexión a internet.";
    return;
  }
  try {
    supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    supabaseClient.auth.onAuthStateChange((event, session) => {
      if (event === "INITIAL_SESSION") return;
      queueMicrotask(() => activateSession(session).catch((error) => {
        showSignedOut(`No se pudieron cargar los datos: ${error.message || error}`);
        showCloudError(error);
      }));
    });
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    await activateSession(data.session);
  } catch (error) {
    showCloudError(error);
    byId("auth-message").textContent = `No se pudo iniciar la conexión: ${error.message || error}`;
  }
}

function showCloudError(error) {
  console.error("Error de Supabase:", error);
  showToast(`Error de sincronización: ${error.message || error}`, true);
}

async function invokeTeamAction(body) {
  const result = await supabaseClient.functions.invoke("manage-users", { body });
  if (result.data?.error) throw new Error(result.data.error);
  if (result.error) throw result.error;
  return result.data;
}

function snapshotState() {
  return JSON.parse(JSON.stringify(state));
}

function restoreState(snapshot) {
  state.active = snapshot.active;
  state.transactions = snapshot.transactions;
  state.memberships = snapshot.memberships;
  state.expenses = snapshot.expenses;
}

function transactionDate(transaction) {
  return validDate(transaction.paidAt);
}

function sameLocalDay(date, today) {
  return date && date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
}

function sameLocalMonth(date, today) {
  return date && date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth();
}

function isMembershipActive(membership) {
  const end = validDate(membership.endsAt);
  if (!end) return false;
  end.setHours(23, 59, 59, 999);
  return end >= new Date();
}

function renderStats() {
  const now = new Date();
  const todaySales = state.transactions.reduce((total, transaction) => {
    const date = transactionDate(transaction);
    return total + (sameLocalDay(date, now) ? Number(transaction.amount) || 0 : 0);
  }, 0);
  const monthSales = state.transactions.reduce((total, transaction) => {
    const date = transactionDate(transaction);
    return total + (sameLocalMonth(date, now) ? Number(transaction.amount) || 0 : 0);
  }, 0);
  byId("stat-active").textContent = state.active.length;
  byId("stat-today").textContent = isOwner() ? formatMoney(todaySales) : "—";
  byId("stat-month").textContent = isOwner() ? formatMoney(monthSales) : "—";
  byId("stat-memberships").textContent = state.memberships.filter(isMembershipActive).length;
  byId("active-count").textContent = state.active.length;
  byId("membership-count").textContent = state.memberships.length;
}

function renderActive() {
  const search = normalizePlate(byId("active-search").value);
  const vehicles = state.active.filter((vehicle) =>
    normalizePlate(vehicle.plate).includes(search)
  );
  byId("active-table").innerHTML = vehicles.map((vehicle) => `
    <tr>
      <td class="vehicle-cell"><strong class="plate">${escapeHtml(vehicle.plate)}</strong><span>${escapeHtml(vehicle.vehicleType)}</span></td>
      <td>${escapeHtml(formatDateTime(vehicle.entryAt))}</td>
      <td data-financial ${isOwner() ? "" : "hidden"}>${isOwner() ? escapeHtml(formatMoney(vehicle.hourlyRate)) : ""}</td>
      <td class="action-cell">
        <button class="button button-secondary button-small" type="button" data-edit-active="${escapeHtml(vehicle.id)}">Editar</button>
        <button class="button button-exit" type="button" data-checkout="${escapeHtml(vehicle.id)}">Dar salida</button>
      </td>
    </tr>
  `).join("");
  byId("active-empty").hidden = vehicles.length > 0;
}

function transactionDescription(transaction) {
  if (transaction.category === "parking") {
    return `${transaction.chargedHours} h × ${formatMoney(transaction.hourlyRate)}/h`;
  }
  if (transaction.category === "sale") return transaction.description || "Venta adicional";
  return transaction.description || "Pago de mensualidad";
}

function renderRecent() {
  if (!isOwner()) {
    byId("recent-table").replaceChildren();
    byId("recent-empty").hidden = false;
    return;
  }
  const transactions = [...state.transactions]
    .sort((a, b) => (validDate(b.paidAt)?.getTime() || 0) - (validDate(a.paidAt)?.getTime() || 0))
    .slice(0, 8);
  byId("recent-table").innerHTML = (isOwner() ? transactions : []).map((transaction) => `
    <tr>
      <td>${escapeHtml(formatDateTime(transaction.paidAt))}</td>
      <td><strong class="plate">${escapeHtml(transaction.plate || transaction.description || "—")}</strong></td>
      <td>${escapeHtml(transactionDescription(transaction))}</td>
      <td class="amount">${escapeHtml(formatMoney(transaction.amount))}</td>
      <td class="action-cell">
        <button class="button button-secondary button-small" type="button" data-edit-transaction="${escapeHtml(transaction.id)}">Editar</button>
        <button class="button button-exit" type="button" data-receipt="${escapeHtml(transaction.id)}">Recibo</button>
      </td>
    </tr>
  `).join("");
  byId("recent-empty").hidden = transactions.length > 0;
}

function renderMemberships() {
  const search = String(byId("membership-search").value || "").trim().toLowerCase();
  const memberships = [...state.memberships]
    .filter((membership) =>
      `${membership.plate} ${membership.customerName}`.toLowerCase().includes(search)
    )
    .sort((a, b) => (validDate(a.endsAt)?.getTime() || 0) - (validDate(b.endsAt)?.getTime() || 0));
  byId("membership-table").innerHTML = memberships.map((membership) => {
    const active = isMembershipActive(membership);
    return `
      <tr>
        <td class="vehicle-cell"><strong>${escapeHtml(membership.customerName)}</strong><span class="plate">${escapeHtml(membership.plate)}</span></td>
        <td>${escapeHtml(formatDate(membership.endsAt))}</td>
        <td data-financial ${isOwner() ? "" : "hidden"}>${isOwner() ? escapeHtml(formatMoney(membership.monthlyRate)) : ""}</td>
        <td><span class="status-badge${active ? "" : " expired"}">${active ? "Vigente" : "Vencida"}</span></td>
        <td><button class="button button-exit" type="button" data-renew="${escapeHtml(membership.id)}">Renovar</button></td>
      </tr>
    `;
  }).join("");
  byId("membership-empty").hidden = memberships.length > 0;
}

function getFilteredTransactions() {
  const plate = normalizePlate(reportFilters.plate);
  const from = reportFilters.from ? new Date(`${reportFilters.from}T00:00:00`) : null;
  const to = reportFilters.to ? new Date(`${reportFilters.to}T23:59:59.999`) : null;
  return [...state.transactions]
    .filter((transaction) => {
      const paidAt = transactionDate(transaction);
      if (!paidAt) return false;
      if (plate && !normalizePlate(`${transaction.plate || ""} ${transaction.description || ""}`).includes(plate)) return false;
      if (from && paidAt < from) return false;
      if (to && paidAt > to) return false;
      return true;
    })
    .sort((a, b) => (transactionDate(b)?.getTime() || 0) - (transactionDate(a)?.getTime() || 0));
}

function renderReport() {
  if (!isOwner()) {
    byId("report-table").innerHTML = "";
    byId("report-empty").hidden = false;
    return;
  }
  const transactions = getFilteredTransactions();
  const expenses = getFilteredExpenses();
  const total = transactions.reduce((sum, transaction) => sum + (Number(transaction.amount) || 0), 0);
  const expenseTotal = expenses.reduce((sum, expense) => sum + (Number(expense.amount) || 0), 0);
  const membershipTotal = transactions.reduce((sum, transaction) =>
    sum + (transaction.category === "membership" ? Number(transaction.amount) || 0 : 0), 0);
  byId("report-total").textContent = formatMoney(total);
  byId("report-expense-total").textContent = formatMoney(expenseTotal);
  byId("report-net").textContent = formatMoney(total - expenseTotal);
  byId("report-count").textContent = transactions.length;
  byId("report-membership-total").textContent = formatMoney(membershipTotal);
  const rows = [
    ...transactions.map((transaction) => ({
      id: transaction.id,
      date: transaction.paidAt,
      label: transaction.plate || transaction.description || "—",
      category: transaction.category,
      description: transactionDescription(transaction),
      amount: Number(transaction.amount) || 0,
      type: "transaction",
    })),
    ...expenses.map((expense) => ({
      id: expense.id,
      date: expense.paidAt,
      label: expense.description,
      category: "expense",
      description: expense.description,
      amount: Number(expense.amount) || 0,
      type: "expense",
    })),
  ].sort((a, b) => (validDate(b.date)?.getTime() || 0) - (validDate(a.date)?.getTime() || 0));
  byId("report-table").innerHTML = rows.map((row) => `
    <tr>
      <td>${escapeHtml(formatDateTime(row.date))}</td>
      <td><strong class="plate">${escapeHtml(row.label)}</strong></td>
      <td>${row.category === "membership" ? "Mensualidad" : row.category === "parking" ? "Parqueadero" : row.category === "expense" ? "Salida" : "Venta"}</td>
      <td>${escapeHtml(row.description)}</td>
      <td class="amount">${escapeHtml(formatMoney(row.amount))}</td>
      <td><button class="button button-secondary button-small" type="button" data-edit-${row.type}="${escapeHtml(row.id)}">Editar</button></td>
    </tr>
  `).join("");
  byId("report-empty").hidden = rows.length > 0;
  renderMonthlyChart(transactions, expenses);
}

function getFilteredExpenses() {
  const query = normalizePlate(reportFilters.plate);
  const from = reportFilters.from ? new Date(`${reportFilters.from}T00:00:00`) : null;
  const to = reportFilters.to ? new Date(`${reportFilters.to}T23:59:59.999`) : null;
  return state.expenses.filter((expense) => {
    const paidAt = validDate(expense.paidAt);
    if (!paidAt) return false;
    if (query && !normalizePlate(expense.description).includes(query)) return false;
    if (from && paidAt < from) return false;
    if (to && paidAt > to) return false;
    return true;
  });
}

function renderMonthlyChart(transactions, expenses) {
  const months = [];
  const now = new Date();
  for (let offset = 11; offset >= 0; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    months.push({
      key,
      label: new Intl.DateTimeFormat("es-CO", { month: "short", year: "2-digit" }).format(date),
      sales: transactions.reduce((sum, item) =>
        sum + (transactionMonthKey(item) === key ? Number(item.amount) || 0 : 0), 0),
      expenses: expenses.reduce((sum, item) =>
        sum + (transactionMonthKey(item) === key ? Number(item.amount) || 0 : 0), 0),
    });
  }
  const maximum = Math.max(1, ...months.flatMap((month) => [month.sales, month.expenses]));
  byId("monthly-chart").innerHTML = months.map((month) => `
    <div class="chart-month">
      <div class="chart-columns">
        <span class="chart-bar sales-bar" style="height:${Math.max(2, month.sales / maximum * 100)}%" title="Ventas: ${escapeHtml(formatMoney(month.sales))}"></span>
        <span class="chart-bar expense-bar" style="height:${Math.max(2, month.expenses / maximum * 100)}%" title="Salidas: ${escapeHtml(formatMoney(month.expenses))}"></span>
      </div>
      <strong>${escapeHtml(month.label)}</strong>
      <small>Ventas ${escapeHtml(formatMoney(month.sales))}</small>
      <small>Salidas ${escapeHtml(formatMoney(month.expenses))}</small>
      <small>Neto ${escapeHtml(formatMoney(month.sales - month.expenses))}</small>
    </div>
  `).join("");
}

function transactionMonthKey(item) {
  const date = validDate(item.paidAt);
  return date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}` : "";
}

function renderCashflow() {
  if (!isOwner()) {
    ["balance-sales", "balance-expenses", "balance-net"].forEach((id) => { byId(id).textContent = "—"; });
    byId("cashflow-table").replaceChildren();
    return;
  }
  const now = new Date();
  const todayTransactions = state.transactions.filter((item) => sameLocalDay(transactionDate(item), now));
  const todayExpenses = state.expenses.filter((item) => sameLocalDay(validDate(item.paidAt), now));
  const sales = todayTransactions.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const expenses = todayExpenses.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  byId("balance-sales").textContent = formatMoney(sales);
  byId("balance-expenses").textContent = formatMoney(expenses);
  byId("balance-net").textContent = formatMoney(sales - expenses);
  const movements = [
    ...state.transactions.map((item) => ({ ...item, kind: "Venta", description: item.plate || transactionDescription(item), type: "transaction" })),
    ...state.expenses.map((item) => ({ ...item, kind: "Salida", type: "expense" })),
  ].sort((a, b) => (validDate(b.paidAt)?.getTime() || 0) - (validDate(a.paidAt)?.getTime() || 0)).slice(0, 12);
  byId("cashflow-table").innerHTML = movements.map((item) => `
    <tr>
      <td>${escapeHtml(formatDateTime(item.paidAt))}</td>
      <td>${item.kind}</td>
      <td>${escapeHtml(item.description || "—")}</td>
      <td class="amount">${escapeHtml(formatMoney(item.amount))}</td>
      <td><button class="button button-secondary button-small" type="button" data-edit-${item.type}="${escapeHtml(item.id)}">Editar</button></td>
    </tr>
  `).join("");
  byId("cashflow-empty").hidden = movements.length > 0;
}

function renderAll() {
  renderStats();
  renderActive();
  renderRecent();
  renderMemberships();
  renderReport();
  renderCashflow();
}

function addOneMonth(dateValue) {
  const date = new Date(`${dateValue}T12:00:00`);
  const originalDay = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + 1);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(originalDay, lastDay));
  return date;
}

function openReceipt(transaction) {
  currentReceipt = transaction;
  const lines = transaction.category === "parking"
    ? [
        ["Placa", transaction.plate],
        ["Tipo de vehículo", transaction.vehicleType],
        ["Ingreso", formatDateTime(transaction.entryAt)],
        ["Salida", formatDateTime(transaction.exitAt)],
        ["Tiempo cobrado", `${transaction.chargedHours} hora(s) · ${transaction.durationMinutes} minuto(s)`],
        ["Tarifa por hora", formatMoney(transaction.hourlyRate)],
      ]
    : transaction.category === "membership"
      ? [
        ["Placa", transaction.plate],
        ["Cliente", transaction.customerName || "—"],
        ["Concepto", transactionDescription(transaction)],
        ["Vigencia hasta", formatDate(transaction.endsAt)],
      ]
      : [["Concepto", transactionDescription(transaction)]];
  byId("receipt-details").innerHTML = `
    <div class="receipt-lines">
      <div class="receipt-line"><span>Recibo</span><strong>${escapeHtml(transaction.receiptNumber || transaction.id.slice(0, 8).toUpperCase())}</strong></div>
      ${lines.map(([label, value]) => `<div class="receipt-line"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}
      <div class="receipt-line"><span>Fecha de pago</span><strong>${escapeHtml(formatDateTime(transaction.paidAt))}</strong></div>
    </div>
  `;
  byId("receipt-total").textContent = formatMoney(transaction.amount);
  byId("receipt-phone").value = transaction.phone || "";
  if (!byId("receipt-dialog").open) byId("receipt-dialog").showModal();
}

function closeVehicle(vehicleId) {
  const index = state.active.findIndex((vehicle) => vehicle.id === vehicleId);
  if (index < 0) {
    showToast("No se encontró el vehículo activo.", true);
    return;
  }
  const vehicle = state.active[index];
  const entryAt = validDate(vehicle.entryAt);
  if (!entryAt) {
    showToast("La fecha de ingreso no es válida. Corrige el registro antes de cobrar.", true);
    return;
  }
  const exitAt = new Date();
  const durationMinutes = Math.max(0, Math.ceil((exitAt.getTime() - entryAt.getTime()) / 60000));
  const chargedHours = Math.max(1, Math.ceil(durationMinutes / 60));
  const amount = chargedHours * Number(vehicle.hourlyRate);
  if (!Number.isFinite(amount) || amount < 0) {
    showToast("No se pudo calcular el valor del cobro. Verifica la tarifa del registro.", true);
    return;
  }
  pendingCheckoutId = vehicleId;
  byId("checkout-title").textContent = `${vehicle.plate} · ${chargedHours} hora(s)`;
  byId("checkout-calculation").textContent =
    `Cálculo sugerido: ${chargedHours} hora(s) × ${formatMoney(vehicle.hourlyRate)}/h = ${formatMoney(amount)}. Puedes cambiar el valor final, incluso dejarlo en cero.`;
  byId("checkout-amount").value = String(amount);
  byId("checkout-dialog").showModal();
}

async function completeCheckout(amount) {
  const index = state.active.findIndex((vehicle) => vehicle.id === pendingCheckoutId);
  if (index < 0) {
    showToast("No se encontró el vehículo activo para cerrar.", true);
    return;
  }
  const vehicle = state.active[index];
  const entryAt = validDate(vehicle.entryAt);
  if (!entryAt) {
    showToast("La fecha de ingreso no es válida. Corrige el registro antes de cobrar.", true);
    return;
  }
  const exitAt = new Date();
  const durationMinutes = Math.max(0, Math.ceil((exitAt.getTime() - entryAt.getTime()) / 60000));
  const chargedHours = Math.max(1, Math.ceil(durationMinutes / 60));
  if (!Number.isFinite(amount) || amount < 0) {
    showToast("El valor cobrado debe ser un número igual o mayor a cero.", true);
    return;
  }
  const transaction = {
    id: crypto.randomUUID(),
    receiptNumber: `PAR-${Date.now().toString().slice(-8)}`,
    category: "parking",
    plate: vehicle.plate,
    vehicleType: vehicle.vehicleType,
    entryAt: vehicle.entryAt,
    exitAt: exitAt.toISOString(),
    paidAt: exitAt.toISOString(),
    durationMinutes,
    chargedHours,
    hourlyRate: Number(vehicle.hourlyRate),
    amount,
  };
  const previousState = snapshotState();
  state.active.splice(index, 1);
  state.transactions.push(transaction);
  if (!await saveData()) {
    restoreState(previousState);
    renderAll();
    return;
  }
  pendingCheckoutId = null;
  byId("checkout-dialog").close();
  renderAll();
  openReceipt(transaction);
}

async function recordCashMovement(form, kind) {
  const values = new FormData(form);
  const description = String(values.get("description") || "").trim();
  const amount = Number(values.get("amount"));
  if (!description || !Number.isFinite(amount) || amount < 0) {
    showToast("Escribe un concepto y un valor válido igual o mayor a cero.", true);
    return;
  }
  const previousState = snapshotState();
  if (kind === "expense") {
    state.expenses.push({ id: crypto.randomUUID(), description, amount, paidAt: new Date().toISOString() });
  } else {
    state.transactions.push({
      id: crypto.randomUUID(),
      receiptNumber: `VEN-${Date.now().toString().slice(-8)}`,
      category: "sale",
      plate: "",
      description,
      paidAt: new Date().toISOString(),
      amount,
    });
  }
  if (!await saveData()) {
    restoreState(previousState);
    renderAll();
    return;
  }
  form.reset();
  renderAll();
  showToast(kind === "expense" ? "Salida registrada." : "Venta adicional registrada.");
}

function editRecord(type, id) {
  const collections = {
    active: state.active,
    transaction: state.transactions,
    expense: state.expenses,
  };
  const record = collections[type]?.find((item) => item.id === id);
  if (!record) {
    showToast("No se encontró el registro para editar.", true);
    return;
  }
  editingRecord = { type, id };
  const labelInput = byId("edit-form").elements.label;
  const amountInput = byId("edit-form").elements.amount;
  labelInput.value = type === "active"
    ? record.plate
    : type === "expense"
      ? record.description
      : record.category === "sale"
        ? record.description
        : record.plate;
  amountInput.value = String(type === "active" ? record.hourlyRate : record.amount);
  byId("edit-amount-field").hidden = type === "active" && !isOwner();
  amountInput.required = !(type === "active" && !isOwner());
  byId("edit-dialog").showModal();
}

async function saveEditedRecord(form) {
  if (!editingRecord) return;
  const { type, id } = editingRecord;
  const label = String(new FormData(form).get("label") || "").trim();
  const amount = type === "active" && !isOwner()
    ? null
    : Number(new FormData(form).get("amount"));
  if (!label || (amount !== null && (!Number.isFinite(amount) || amount < 0))) {
    showToast("Completa el texto y un valor válido igual o mayor a cero.", true);
    return;
  }
  const collections = { active: state.active, transaction: state.transactions, expense: state.expenses };
  const record = collections[type].find((item) => item.id === id);
  if (!record) {
    showToast("El registro ya no está disponible.", true);
    return;
  }
  if (type === "active") {
    const plate = normalizePlate(label);
    if (state.active.some((item) => item.id !== id && normalizePlate(item.plate) === plate)) {
      showToast("Ya existe otro ingreso activo con esa placa.", true);
      return;
    }
  }
  const previousState = snapshotState();
  if (type === "active") {
    record.plate = normalizePlate(label);
    record.hourlyRate = isOwner() ? amount : record.hourlyRate;
  } else if (type === "expense") {
    record.description = label;
    record.amount = amount;
  } else {
    if (record.category === "sale") record.description = label;
    else record.plate = normalizePlate(label);
    record.amount = amount;
  }
  if (!await saveData()) {
    restoreState(previousState);
    renderAll();
    return;
  }
  editingRecord = null;
  byId("edit-dialog").close();
  renderAll();
  showToast("Registro actualizado.");
}

async function createMembership(form) {
  const values = new FormData(form);
  const plate = normalizePlate(values.get("plate"));
  const customerName = String(values.get("customerName") || "").trim();
  const phone = String(values.get("phone") || "").trim();
  const monthlyRate = Number(values.get("monthlyRate"));
  const startsAt = String(values.get("startsAt") || "");
  if (!plate || !customerName || !startsAt || !Number.isFinite(monthlyRate) || monthlyRate < 0) {
    showToast("Completa los datos de la mensualidad con valores válidos.", true);
    return;
  }
  const starts = validDate(`${startsAt}T12:00:00`);
  if (!starts) {
    showToast("La fecha de inicio no es válida.", true);
    return;
  }
  const ends = addOneMonth(startsAt);
  const membership = {
    id: crypto.randomUUID(),
    plate,
    customerName,
    phone,
    monthlyRate,
    startsAt,
    endsAt: localDateTimeValue(ends).slice(0, 10),
  };
  const paidAt = new Date().toISOString();
  const transaction = {
    id: crypto.randomUUID(),
    receiptNumber: `MEN-${Date.now().toString().slice(-8)}`,
    category: "membership",
    plate,
    customerName,
    phone,
    description: "Pago inicial de mensualidad",
    startsAt: membership.startsAt,
    endsAt: membership.endsAt,
    paidAt,
    amount: monthlyRate,
  };
  const previousState = snapshotState();
  state.memberships.push(membership);
  state.transactions.push(transaction);
  if (!await saveData()) {
    restoreState(previousState);
    renderAll();
    return;
  }
  form.reset();
  form.elements.startsAt.value = localDateTimeValue().slice(0, 10);
  renderAll();
  showToast("Mensualidad creada y primer pago registrado.");
  openReceipt(transaction);
}

async function renewMembership(membershipId) {
  const membership = state.memberships.find((item) => item.id === membershipId);
  if (!membership) {
    showToast("No se encontró la mensualidad para renovar.", true);
    return;
  }
  const today = new Date();
  const currentEnd = validDate(`${membership.endsAt}T12:00:00`);
  const start = currentEnd && currentEnd >= today ? currentEnd : today;
  const startsAt = localDateTimeValue(start).slice(0, 10);
  const ends = addOneMonth(startsAt);
  const endsAt = localDateTimeValue(ends).slice(0, 10);
  const rateInput = isOwner()
    ? String(membership.monthlyRate)
    : window.prompt("Ingresa el valor autorizado para renovar esta mensualidad:", "");
  if (rateInput === null) return;
  const enteredRate = Number(rateInput);
  if (!Number.isFinite(enteredRate) || enteredRate < 0) {
    showToast("La renovación requiere un valor válido igual o mayor a cero.", true);
    return;
  }
  const transaction = {
    id: crypto.randomUUID(),
    receiptNumber: `MEN-${Date.now().toString().slice(-8)}`,
    category: "membership",
    plate: membership.plate,
    customerName: membership.customerName,
    phone: membership.phone,
    description: "Renovación de mensualidad",
    startsAt,
    endsAt,
    paidAt: new Date().toISOString(),
    amount: enteredRate,
  };
  const previousState = snapshotState();
  membership.startsAt = startsAt;
  membership.endsAt = endsAt;
  state.transactions.push(transaction);
  if (!await saveData()) {
    restoreState(previousState);
    renderAll();
    return;
  }
  renderAll();
  showToast("Mensualidad renovada y pago registrado.");
  openReceipt(transaction);
}

function sendReceiptToWhatsApp() {
  if (!currentReceipt) {
    showToast("No hay un recibo seleccionado.", true);
    return;
  }
  const phone = byId("receipt-phone").value.replace(/[^\d]/g, "");
  if (phone.length < 10 || phone.length > 15) {
    showToast("Ingresa un celular válido con indicativo de país, por ejemplo 573001234567.", true);
    byId("receipt-phone").focus();
    return;
  }
  const summary = [
    "Recibo de Parqueadero",
    `Recibo: ${currentReceipt.receiptNumber || currentReceipt.id.slice(0, 8).toUpperCase()}`,
    `Placa: ${currentReceipt.plate}`,
    currentReceipt.category === "parking"
      ? `Tiempo cobrado: ${currentReceipt.chargedHours} hora(s)`
      : transactionDescription(currentReceipt),
    `Total: ${formatMoney(currentReceipt.amount)}`,
    `Fecha: ${formatDateTime(currentReceipt.paidAt)}`,
  ].join("\n");
  const link = `https://wa.me/${phone}?text=${encodeURIComponent(summary)}`;
  window.open(link, "_blank", "noopener,noreferrer");
}

function setView(viewId) {
  if (viewId === "reports-view" && !isOwner()) {
    showToast("Solo el dueño puede consultar los reportes.", true);
    return;
  }
  if (viewId === "team-view" && !canManageTeam()) {
    showToast("No tienes permiso para administrar usuarios.", true);
    return;
  }
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === viewId);
  });
  document.querySelectorAll(".view").forEach((view) => {
    const active = view.id === viewId;
    view.hidden = !active;
    view.classList.toggle("active", active);
  });
  if (viewId === "reports-view") renderReport();
  if (viewId === "team-view") loadTeam().catch(showCloudError);
}

byId("current-date").textContent = new Intl.DateTimeFormat("es-CO", {
  weekday: "long", day: "numeric", month: "long", year: "numeric",
}).format(new Date());
byId("entry-time").value = localDateTimeValue();
byId("membership-form").elements.startsAt.value = localDateTimeValue().slice(0, 10);
showSignedOut();

byId("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!supabaseClient) return;
  const values = new FormData(event.currentTarget);
  byId("auth-message").textContent = "Validando acceso...";
  try {
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: String(values.get("email") || "").trim(),
      password: String(values.get("password") || ""),
    });
    if (error) throw error;
  } catch (error) {
    byId("auth-message").textContent = "No se pudo ingresar. Verifica la conexión, el correo y la contraseña.";
    console.error("No se pudo iniciar sesión:", error);
  }
});

byId("password-setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  const password = String(values.get("password") || "");
  if (password !== String(values.get("confirmPassword") || "")) {
    byId("auth-message").textContent = "Las contraseñas no coinciden.";
    return;
  }
  const { error } = await supabaseClient.auth.updateUser({ password });
  if (error) {
    byId("auth-message").textContent = `No se pudo guardar la contraseña: ${error.message}`;
    return;
  }
  history.replaceState(null, "", location.pathname + location.search);
  pendingPasswordSetup = false;
  await supabaseClient.auth.signOut();
  byId("password-setup-form").hidden = true;
  byId("login-form").hidden = false;
  byId("auth-message").textContent = "Contraseña guardada. Ya puedes iniciar sesión.";
});

byId("reset-password").addEventListener("click", async () => {
  if (!supabaseClient) return;
  const email = String(byId("login-form").elements.email.value || "").trim();
  if (!email) {
    byId("auth-message").textContent = "Escribe tu correo y vuelve a seleccionar “Olvidé mi contraseña”.";
    byId("login-form").elements.email.focus();
    return;
  }
  try {
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}${location.pathname}`,
    });
    if (error) throw error;
    byId("auth-message").textContent = "Si el correo está registrado, recibirás un enlace para cambiar la contraseña.";
  } catch (error) {
    byId("auth-message").textContent = `No se pudo enviar el correo: ${error.message || error}`;
  }
});

byId("logout-button").addEventListener("click", async () => {
  const { error } = await supabaseClient.auth.signOut();
  if (error) showCloudError(error);
  else showSignedOut("Sesión cerrada.");
});

byId("invite-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  try {
    await invokeTeamAction({
      action: "invite",
      email: String(values.get("email") || "").trim(),
      role: String(values.get("role") || ""),
    });
    event.currentTarget.reset();
    byId("auth-message").textContent = "Invitación enviada.";
    showToast("Invitación enviada por correo.");
    await loadTeam();
  } catch (error) {
    showCloudError(error);
  }
});

byId("team-table").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-save-role]");
  if (!button) return;
  const userId = button.dataset.saveRole;
  const role = byId("team-table").querySelector(`[data-role-user="${CSS.escape(userId)}"]`).value;
  try {
    await invokeTeamAction({ action: "set-role", userId, role });
    showToast("Rol actualizado.");
    await loadTeam();
  } catch (error) {
    showCloudError(error);
  }
});

byId("migrate-local-data").addEventListener("click", async () => {
  if (!isOwner()) return;
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    showToast("No se encontraron datos locales guardados en este dispositivo.", true);
    return;
  }
  let imported;
  try {
    imported = JSON.parse(saved);
  } catch (error) {
    console.error("No se pudieron leer los datos locales para migrarlos:", error);
    showToast("Los datos locales no tienen un formato JSON válido.", true);
    return;
  }
  if (!isValidStore(imported)) {
    showToast("Los datos locales tienen un formato incompatible; no se modificó el sistema.", true);
    return;
  }
  const importedCount = imported.active.length + imported.memberships.length +
    imported.transactions.length + (imported.expenses?.length || 0);
  if (!window.confirm(`Se intentarán importar ${importedCount} registros de este navegador a la nube. Esta acción no se puede deshacer. ¿Continuar?`)) return;
  const duplicatePlates = new Set(state.active.map((vehicle) => normalizePlate(vehicle.plate)));
  const activeToImport = imported.active.filter((vehicle) => {
    const plate = normalizePlate(vehicle.plate);
    if (duplicatePlates.has(plate)) return false;
    duplicatePlates.add(plate);
    return true;
  });
  const previous = snapshotState();
  state.active = appendUniqueRecords(state.active, activeToImport);
  state.memberships = appendUniqueRecords(state.memberships, imported.memberships);
  state.transactions = appendUniqueRecords(state.transactions, imported.transactions);
  state.expenses = appendUniqueRecords(state.expenses, imported.expenses || []);
  if (stateIsEmpty(imported)) {
    showToast("Este dispositivo no tiene registros para importar.", true);
    restoreState(previous);
    return;
  }
  if (!await saveData()) {
    restoreState(previous);
    renderAll();
    return;
  }
  localStorage.removeItem(STORAGE_KEY);
  renderAll();
  const skipped = imported.active.length - activeToImport.length;
  showToast(`Datos importados y sincronizados.${skipped ? ` Se omitieron ${skipped} placas ya activas.` : ""}`);
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => setView(tab.dataset.view));
});

byId("entry-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const plate = normalizePlate(values.get("plate"));
  const vehicleType = String(values.get("vehicleType") || "");
  const hourlyRate = Number(values.get("hourlyRate"));
  const entryAt = validDate(values.get("entryAt"));
  if (!plate || !["Carro", "Moto"].includes(vehicleType) ||
      !Number.isFinite(hourlyRate) || hourlyRate < 0 || !entryAt) {
    showToast("Verifica la placa, el tipo, la tarifa y la fecha de ingreso.", true);
    return;
  }
  if (entryAt.getTime() > Date.now()) {
    showToast("La fecha de ingreso no puede estar en el futuro.", true);
    return;
  }
  if (state.active.some((vehicle) => normalizePlate(vehicle.plate) === plate)) {
    showToast("Ya existe un ingreso activo con esa placa.", true);
    return;
  }
  const immutableBase = Object.freeze([plate, vehicleType]);
  const previousState = snapshotState();
  state.active.push({
    id: crypto.randomUUID(),
    plate: immutableBase[0],
    vehicleType: immutableBase[1],
    baseData: immutableBase,
    entryAt: entryAt.toISOString(),
    hourlyRate,
  });
  if (!await saveData()) {
    restoreState(previousState);
    renderAll();
    return;
  }
  form.reset();
  byId("entry-time").value = localDateTimeValue();
  renderAll();
  showToast(`Ingreso de ${plate} registrado.`);
});

byId("active-table").addEventListener("click", (event) => {
  const button = event.target.closest("[data-checkout]");
  if (button) {
    closeVehicle(button.dataset.checkout);
    return;
  }
  const editButton = event.target.closest("[data-edit-active]");
  if (editButton) editRecord("active", editButton.dataset.editActive);
});

byId("recent-table").addEventListener("click", (event) => {
  const editButton = event.target.closest("[data-edit-transaction]");
  if (editButton) {
    editRecord("transaction", editButton.dataset.editTransaction);
    return;
  }
  const button = event.target.closest("[data-receipt]");
  if (!button) return;
  const transaction = state.transactions.find((item) => item.id === button.dataset.receipt);
  if (transaction) openReceipt(transaction);
});

["report-table", "cashflow-table"].forEach((tableId) => {
  byId(tableId).addEventListener("click", (event) => {
    const button = event.target.closest("[data-edit-transaction], [data-edit-expense]");
    if (!button) return;
    if (button.dataset.editTransaction) editRecord("transaction", button.dataset.editTransaction);
    else editRecord("expense", button.dataset.editExpense);
  });
});

byId("active-search").addEventListener("input", renderActive);
byId("membership-search").addEventListener("input", renderMemberships);
byId("membership-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await createMembership(event.currentTarget);
});
byId("membership-table").addEventListener("click", (event) => {
  const button = event.target.closest("[data-renew]");
  if (button) renewMembership(button.dataset.renew).catch(showCloudError);
});
byId("sale-form").addEventListener("submit", (event) => {
  event.preventDefault();
  recordCashMovement(event.currentTarget, "sale").catch(showCloudError);
});
byId("expense-form").addEventListener("submit", (event) => {
  event.preventDefault();
  recordCashMovement(event.currentTarget, "expense").catch(showCloudError);
});
byId("checkout-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await completeCheckout(Number(byId("checkout-amount").value));
});
byId("cancel-checkout").addEventListener("click", () => {
  pendingCheckoutId = null;
  byId("checkout-dialog").close();
});
byId("edit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveEditedRecord(event.currentTarget);
});
byId("cancel-edit").addEventListener("click", () => {
  editingRecord = null;
  byId("edit-dialog").close();
});
byId("install-app").addEventListener("click", async () => {
  if (window.installPrompt) {
    await window.installPrompt.prompt();
    window.installPrompt = null;
    byId("install-app").hidden = true;
    return;
  }
  byId("install-help-dialog").showModal();
});
byId("close-install-help").addEventListener("click", () => byId("install-help-dialog").close());
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  window.installPrompt = event;
  byId("install-app").hidden = false;
});
window.addEventListener("appinstalled", () => {
  window.installPrompt = null;
  byId("install-app").hidden = true;
  showToast("Parqueadero quedó instalada en este dispositivo.");
});
const isAppleMobile = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
if (isAppleMobile && !isStandalone) byId("install-app").hidden = false;

byId("report-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  const from = String(values.get("from") || "");
  const to = String(values.get("to") || "");
  if (from && to && from > to) {
    showToast("La fecha inicial no puede ser posterior a la fecha final.", true);
    return;
  }
  reportFilters = {
    plate: String(values.get("plate") || "").trim(),
    from,
    to,
  };
  renderReport();
});

byId("clear-report").addEventListener("click", () => {
  byId("report-form").reset();
  reportFilters = { plate: "", from: "", to: "" };
  renderReport();
});

document.querySelectorAll("[data-open-reports]").forEach((button) => {
  button.addEventListener("click", () => setView("reports-view"));
});
byId("send-whatsapp").addEventListener("click", sendReceiptToWhatsApp);
byId("print-receipt").addEventListener("click", () => {
  if (!currentReceipt) {
    showToast("No hay un recibo seleccionado para imprimir.", true);
    return;
  }
  window.print();
});
byId("close-receipt").addEventListener("click", () => byId("receipt-dialog").close());
byId("receipt-dialog").addEventListener("click", (event) => {
  if (event.target === byId("receipt-dialog")) byId("receipt-dialog").close();
});
initializeSupabase().catch((error) => {
  showCloudError(error);
  byId("auth-message").textContent = `No se pudo iniciar la conexión: ${error.message || error}`;
});
