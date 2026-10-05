# Aplicación local en GitHub Pages

La aplicación se publica como un sitio estático desde la rama `main` mediante GitHub Actions. No requiere Supabase, Vercel ni iniciar sesión.

## Publicar en GitHub Pages

1. En GitHub, abre **Settings → Pages** del repositorio.
2. En **Build and deployment**, selecciona **GitHub Actions** como origen.
3. Cada cambio que se suba a `main` ejecuta el flujo `.github/workflows/deploy-pages.yml`. Al finalizar, GitHub muestra el enlace del sitio en el entorno `github-pages` o en **Settings → Pages**.
4. Comparte ese enlace para abrir la aplicación desde un celular o PC.

## Datos y dispositivos

- Los vehículos, mensualidades, ventas y gastos se guardan en el almacenamiento local del navegador.
- Compartir el enlace permite abrir la aplicación, pero no comparte los registros. Cada dispositivo y navegador mantiene sus propios datos.
- No hay inicio de sesión ni roles de administrador o colaborador en esta modalidad.
- No borres los datos del sitio en el navegador si quieres conservar los registros de ese dispositivo.
- La aplicación puede instalarse en cada dispositivo como PWA y funcionar sin conexión después de cargarla.
