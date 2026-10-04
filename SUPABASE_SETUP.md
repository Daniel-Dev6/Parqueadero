# Login, sincronización y roles

La aplicación usa Supabase Auth y Postgres. Los registros se comparten entre los dispositivos que ingresen con cuentas del mismo negocio. Se requiere internet para iniciar sesión y sincronizar; no se guardan cambios pendientes sin conexión.

## 1. Crear y configurar Supabase

1. Crea un proyecto en Supabase.
2. En **SQL Editor**, ejecuta completo `supabase/schema.sql`.
3. En **Authentication → Providers → Email**, desactiva el registro público de usuarios. Los usuarios se crean desde la sección **Usuarios** de la aplicación, mediante invitación.
4. En **Authentication → URL Configuration**, configura como `Site URL` el dominio final de Vercel y añade ese dominio a `Redirect URLs`. Añade también la URL local de desarrollo si la vas a usar.
5. En **Database → Publications → supabase_realtime**, habilita estas tablas: `active_vehicles`, `memberships`, `active_vehicle_rates`, `membership_prices`, `transactions`, `expenses` y `profiles`. RLS sigue aplicándose a las suscripciones.
6. En **Project Settings → API**, copia la URL del proyecto y la clave pública `anon`/publishable. Pon esos valores en `supabase-config.js`:

   ```js
   window.PARQUEADERO_CONFIG = {
     supabaseUrl: "https://TU-PROYECTO.supabase.co",
     supabaseAnonKey: "TU-CLAVE-PUBLICA",
   };
   ```

   La clave pública se puede incluir en la app web; **no** pongas la `service_role` ni ninguna clave secreta en `supabase-config.js`, el repositorio ni Vercel como variable expuesta al navegador.

Configura un proveedor SMTP/correo de Auth antes de invitar al equipo en producción; el servicio de correo de prueba de Supabase tiene restricciones de envío.

## 2. Crear el dueño inicial

Con el registro público deshabilitado, crea el usuario inicial desde **Authentication → Users → Add user** y confirma su correo. Después ejecuta en SQL Editor, reemplazando el correo:

```sql
select gen_random_uuid() as business_id;
```

Copia el UUID generado y asígnalo al perfil del dueño:

```sql
update public.profiles
set business_id = 'UUID-DEL-NEGOCIO', role = 'owner'
where lower(email) = lower('correo-del-dueno@example.com');
```

Confirma que se actualizó exactamente un perfil. No publiques el UUID del negocio como si fuera una contraseña: el control de permisos lo aplica RLS junto con la sesión autenticada.

## 3. Desplegar la función segura de invitaciones

La clave de servicio solo se configura como secreto de Supabase Edge Functions. Desde una terminal con Supabase CLI:

```text
supabase login
supabase link --project-ref TU_PROJECT_REF
supabase secrets set APP_ORIGIN=https://TU-DOMINIO.vercel.app SUPABASE_SERVICE_ROLE_KEY=TU_SERVICE_ROLE_KEY
supabase functions deploy manage-users
```

La función verifica el JWT y el rol en la base de datos. Un dueño puede invitar administradores o colaboradores; un administrador únicamente colaboradores. Los colaboradores registran operaciones. Solo el dueño puede consultar movimientos, tarifas guardadas, balances, gráficas e informes. No alteres ni compartas el secreto de servicio.

## 4. Publicar e importar los datos que ya existen

1. Publica con `vercel --prod` después de configurar `supabase-config.js`.
2. Inicia sesión en cada PC o teléfono con su propia cuenta. La sincronización en tiempo real requiere la publicación Realtime del paso 1.
3. Si hay información antigua guardada en el navegador del dueño, abre la aplicación en **ese mismo dispositivo** e inicia sesión como dueño. En **Usuarios**, pulsa **Importar datos de este dispositivo**. Esto mezcla los registros locales existentes con la nube y omite placas que ya estén activas. Revisa el reporte antes de importar datos de otras instalaciones.
4. Desde **Usuarios**, invita al equipo y asigna sus roles. El correo de invitación debe poder recibirse para activar la cuenta y crear la contraseña.

Los datos locales no se comparten automáticamente; deben importarse desde cada dispositivo que los tenga. Valida las cuentas de dueño, administrador y colaborador antes de operar con información real.
