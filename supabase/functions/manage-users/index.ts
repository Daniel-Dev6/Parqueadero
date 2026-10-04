import { createClient } from "npm:@supabase/supabase-js@2";

const appOrigin = Deno.env.get("APP_ORIGIN") || "";
const corsHeaders = {
  "Access-Control-Allow-Origin": appOrigin || "null",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Método no permitido." }, 405);
  if (!appOrigin) return jsonResponse({ error: "APP_ORIGIN no está configurado." }, 500);
  const origin = request.headers.get("Origin");
  if (origin && origin !== appOrigin) return jsonResponse({ error: "Origen no permitido." }, 403);

  const authorization = request.headers.get("Authorization");
  if (!authorization) return jsonResponse({ error: "Debes iniciar sesión." }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: "La función no tiene configurados sus secretos de Supabase." }, 500);
  }

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const accessToken = authorization.replace(/^Bearer\s+/i, "").trim();
  const { data: { user }, error: authError } = await callerClient.auth.getUser(accessToken);
  if (authError || !user) return jsonResponse({ error: "La sesión no es válida." }, 401);

  const { data: caller, error: profileError } = await adminClient
    .from("profiles")
    .select("id,business_id,role")
    .eq("id", user.id)
    .single();
  if (profileError || !caller?.business_id || !["owner", "admin"].includes(caller.role)) {
    return jsonResponse({ error: "No tienes permisos para administrar usuarios." }, 403);
  }

  let body: { action?: string; email?: string; role?: string; userId?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "El cuerpo de la solicitud no es JSON válido." }, 400);
  }

  if (body.action === "list") {
    const { data, error } = await adminClient.from("profiles")
      .select("id,email,role,created_at")
      .eq("business_id", caller.business_id)
      .order("created_at");
    if (error) return jsonResponse({ error: error.message }, 500);
    return jsonResponse({ users: data });
  }

  if (body.action === "invite") {
    const email = String(body.email || "").trim().toLowerCase();
    const role = body.role;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse({ error: "Ingresa un correo electrónico válido." }, 400);
    }
    if (!["admin", "collaborator"].includes(role || "")) {
      return jsonResponse({ error: "El rol solicitado no es válido." }, 400);
    }
    if (caller.role === "admin" && role !== "collaborator") {
      return jsonResponse({ error: "Un administrador solo puede invitar colaboradores." }, 403);
    }

    const redirectTo = Deno.env.get("APP_ORIGIN");
    const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email, {
      ...(redirectTo ? { redirectTo } : {}),
    });
    if (error || !data.user) return jsonResponse({ error: error?.message || "No se pudo enviar la invitación." }, 400);

    const { data: existingProfile, error: existingProfileError } = await adminClient.from("profiles")
      .select("business_id,role")
      .eq("id", data.user.id)
      .maybeSingle();
    if (existingProfileError) return jsonResponse({ error: existingProfileError.message }, 500);
    if (existingProfile?.business_id && existingProfile.business_id !== caller.business_id) {
      return jsonResponse({ error: "Este correo ya pertenece a otro negocio." }, 409);
    }
    if (existingProfile?.role === "owner") {
      return jsonResponse({ error: "No se puede invitar ni reasignar la cuenta de un dueño." }, 409);
    }

    const { error: updateError } = await adminClient.from("profiles").upsert({
      id: data.user.id,
      email,
      business_id: caller.business_id,
      role,
    });
    if (updateError) {
      return jsonResponse({ error: `La invitación no pudo asignarse al negocio: ${updateError.message}` }, 500);
    }
    return jsonResponse({ invited: true, email, role });
  }

  if (body.action === "set-role") {
    const userId = String(body.userId || "");
    const role = body.role;
    if (!userId || !["admin", "collaborator"].includes(role || "")) {
      return jsonResponse({ error: "Usuario o rol no válido." }, 400);
    }
    if (userId === user.id) return jsonResponse({ error: "No puedes cambiar tu propio rol." }, 403);
    if (caller.role === "admin" && role !== "collaborator") {
      return jsonResponse({ error: "Un administrador solo puede asignar el rol colaborador." }, 403);
    }
    const { data: target, error: targetError } = await adminClient.from("profiles")
      .select("id,role")
      .eq("id", userId)
      .eq("business_id", caller.business_id)
      .single();
    if (targetError || !target || target.role === "owner") {
      return jsonResponse({ error: "No se encontró un usuario modificable en este negocio." }, 404);
    }
    if (caller.role === "admin" && target.role !== "collaborator") {
      return jsonResponse({ error: "Un administrador solo puede modificar colaboradores." }, 403);
    }
    const { error } = await adminClient.from("profiles").update({ role }).eq("id", userId);
    if (error) return jsonResponse({ error: error.message }, 500);
    return jsonResponse({ updated: true, userId, role });
  }

  return jsonResponse({ error: "Acción no reconocida." }, 400);
});
