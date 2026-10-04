# Configuración de usuarios y base de datos

La PWA actual sigue guardando los registros operativos en el almacenamiento local del navegador. El esquema de `supabase/schema.sql` prepara las tablas y reglas de seguridad para una futura conexión; **por sí solo no conecta ni sincroniza esta versión de la aplicación**. No se deben crear cuentas de colaboradores ni guardar datos reales hasta completar la integración y validar las políticas.

## Preparar Supabase

1. Crea un proyecto en Supabase y conserva la URL y la clave pública (`anon`/publishable). Nunca copies la `service_role`/secret key al frontend.
2. En el SQL Editor ejecuta `supabase/schema.sql`.
3. Crea la cuenta del dueño en Authentication. Copia su UUID y ejecuta, sustituyendo ambos valores:

   ```sql
   update public.profiles
   set business_id = 'UUID-DE-NEGOCIO', role = 'owner'
   where id = 'UUID-DEL-USUARIO-DUENO';
   ```

   Puedes generar un UUID para el negocio en SQL con `select gen_random_uuid();`.
4. Crea las cuentas de administrador y colaboradores desde Authentication. Asigna a cada perfil el mismo `business_id` del dueño y el rol `admin` o `collaborator`. Los usuarios recién creados quedan sin negocio y no pueden consultar los datos hasta asignarlos.
5. Antes de usar datos reales, prueba con cuentas distintas que los colaboradores no puedan leer `transactions`, `expenses` ni `membership_prices`, y que un negocio no pueda consultar registros de otro.

## Alcance pendiente antes de publicar el inicio de sesión

La interfaz todavía no autentica usuarios ni consulta Supabase: conectar esas funciones requiere integrar login, sincronización y administración de usuarios en `script.js`, migrar los datos locales existentes y validar las políticas con las cuentas anteriores. La aplicación estática puede publicarse en Vercel para probar la PWA, pero roles, sincronización multiusuario y reportes privados no quedan activos hasta completar esa integración.
