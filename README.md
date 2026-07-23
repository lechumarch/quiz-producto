# Quiz Producto — Deploy en servidor casero

## Qué es esto

App estilo Kahoot para la reunión mensual del equipo de Producto de Despegar. Los jugadores entran desde el celu, responden preguntas en tiempo real, hay ranking y todo.

Originalmente corría en **Ownia** (infra interna de Despegar), pero requería VPN para usarse desde el celular. Este repo es un fork para deployarla en un servidor casero accesible públicamente via **Tailscale Funnel**.

---

## Stack

- **Runtime:** Node.js + TypeScript
- **Web:** Express
- **Tiempo real:** WebSockets nativos (`ws`) — importante, no es polling
- **DB:** PostgreSQL
- **Contenedor:** `Dockerfile` + `docker-compose.yml` en la raíz, listos para usar

---

## Requisitos del servidor

- Docker + Docker Compose
- Tailscale con **Funnel** habilitado en el tailnet
- Funnel soporta WebSockets nativamente (proxy TCP con TLS termination)

**Nota sobre el prefijo de path y los WebSockets:** cada pantalla arma la URL del WebSocket a partir del path por el que se entró. Si entrás por `/quiz-producto/join`, el browser disca `wss://<host>/quiz-producto/ws`. El server acepta el upgrade de WS en **cualquier** path, así que funciona detrás de un proxy que agrega un prefijo (como Funnel) sin necesidad de reescribir el path del upgrade. La app además strippea el prefijo `/quiz-producto` de las requests HTTP por su cuenta.

> El bug conocido de Tailscale Funnel que elimina query params en upgrades WS **no afecta** a esta app: los WS no usan query params, el join va por mensaje después de conectar.

---

## Deploy

### 1. Clonar el repo

```bash
git clone https://github.com/lechumarch/quiz-producto.git
cd quiz-producto
```

### 2. Crear el archivo `.env`

Crear un `.env` en la raíz (cambiá los passwords). El `docker-compose.yml` lo lee tanto para la app como para inicializar Postgres:

```env
DB_HOST=db
DB_PORT=5432
DB_NAME=quiz
DB_USER=quiz
DB_PASSWORD=un_password_seguro
DB_SSL=false
ADMIN_USER=admin
ADMIN_PASS=otro_password_seguro
# Opcional pero recomendado si exponés en un puerto de Funnel que no sea 443:
# fuerza la URL pública que se usa en el QR y en el link de join.
# PUBLIC_BASE_URL=https://<tu-server>.<tailnet>.ts.net:<puerto-funnel>
```

- **`DB_SSL=false`** — el Postgres local del compose no usa SSL. (En Ownia iba `true`.)
- **`ADMIN_USER` / `ADMIN_PASS`** — credenciales del panel de host/admin. También se aceptan `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` como alias.
- **`PUBLIC_BASE_URL`** — si está seteada, el QR y el link de join usan exactamente esa base. **Necesario si el Funnel está en un puerto no-443** (ej. 8443 o 10000): sin esto, el QR se arma con `x-forwarded-host` y omite el puerto, apuntando a la URL equivocada.

> El `.env` está en `.gitignore` — no se commitea. Nunca lo subas al repo.

### 3. Levantar la app

El repo ya incluye `docker-compose.yml` (app + `postgres:15-alpine`). Por seguridad, la app queda bindeada a `127.0.0.1:3020` (no expuesta a toda la LAN) y la DB es solo interna al compose.

```bash
docker compose up -d --build
```

Verificar que levantó:

```bash
docker compose logs -f app
```

Debería terminar con `DB migrations done` y `Quiz app on :3000`.

> Si el puerto local `3020` ya está ocupado en tu server, cambiá el mapping en `docker-compose.yml` (`127.0.0.1:<otro>:3000`) y usá ese puerto en el paso 4.

### 4. Exponer con Tailscale Funnel

**Tailscale Funnel solo permite tres puertos: `443`, `8443` y `10000`.** Revisá cuál tenés libre para no pisar otro servicio:

```bash
tailscale serve status
```

Exponé el puerto local de la app (`127.0.0.1:3020`) en un puerto de Funnel libre:

```bash
tailscale funnel --bg --https=<puerto> http://127.0.0.1:3020
```

donde `<puerto>` es `443`, `8443` o `10000`. Volvé a correr `tailscale serve status` y confirmá que las entradas que ya existían siguen intactas.

Después, seteá `PUBLIC_BASE_URL` en el `.env` con `https://<tu-server>.<tailnet>.ts.net:<puerto>` y reconstruí para que el QR salga con el puerto correcto:

```bash
docker compose up -d --build
```

---

## URLs finales

Reemplazá `<tu-server>.<tailnet>.ts.net` por tu MagicDNS name (`tailscale status`) y `<puerto>` por el de Funnel que elegiste:

| | URL |
|---|---|
| Jugadores (celu) | `https://<tu-server>.<tailnet>.ts.net:<puerto>/quiz-producto/join` |
| Host (quien conduce) | `https://<tu-server>.<tailnet>.ts.net:<puerto>/quiz-producto/host` |

El panel de host pide usuario y contraseña (los `ADMIN_USER` / `ADMIN_PASS` del `.env`).

---

## Verificar que todo funciona

1. Desde el servidor: `curl http://127.0.0.1:3020/quiz-producto/join` → debe responder `200`.
2. `curl http://127.0.0.1:3020/quiz-producto/host` → debe responder `401` (basic auth activo, es correcto).
3. Desde el celu por la URL pública: abrir `/quiz-producto/join` → debe cargar la pantalla de selección de jugador.
4. Test de WebSocket: entrar a `/quiz-producto/join`, seleccionar un jugador → debe conectar y mostrar "Esperando al admin".

---

## Higiene de seguridad

Funnel expone el servidor públicamente. Consideraciones:

- El panel de host/admin está protegido por basic auth ✅
- La pantalla de join es abierta (necesario para que los jugadores entren) ✅
- ⚠️ **`POST /api/players/avatar` es público y sin auth** — cualquiera con el link puede pegarle mientras el Funnel esté prendido.
- **Recomendado:** apagar el Funnel cuando no hay quiz activo y prenderlo solo el día del evento:

```bash
tailscale funnel --https=<puerto> off   # apagar
tailscale funnel --bg --https=<puerto> http://127.0.0.1:3020   # prender el día del quiz
```

---

## Operación día a día

```bash
# Ver estado
docker compose ps

# Ver logs en vivo
docker compose logs -f app

# Actualizar tras un cambio del repo
git pull
docker compose up -d --build

# Apagar todo
docker compose down
```

---

## Estructura del repo

```
src/
  index.ts          # entry point, Express + WebSocket server
  db.ts             # conexión PostgreSQL + schema + migraciones
  secrets.ts        # lee secrets de APP_SECRETS (Ownia) o de env vars
  game/
    engine.ts       # lógica del juego, manejo de sesiones y WS
    scoring.ts      # cálculo de puntajes
  routes/
    admin.ts        # endpoints del panel de host (protegidos con basic auth)
    player.ts       # endpoints públicos (jugadores)
  middleware/
    auth.ts         # basic auth
public/
  join.html         # pantalla de ingreso al quiz (jugadores)
  play.html         # pantalla de juego (jugadores)
  admin/            # panel de administración
  host/             # pantalla del host que conduce el quiz
Dockerfile
docker-compose.yml
```

---

## Notas de arquitectura relevantes

- La app corre las **migraciones automáticamente** al arrancar — no hace falta correr nada manualmente contra la DB
- Los **avatares de jugadores** se guardan como base64 en PostgreSQL (no en disco), por eso el volume solo necesita espacio para la DB
- El **Ranking Anual** ordena por victorias (1er puesto por sesión), con puntaje total como tie-breaker
- La tabla `quiz_events` actúa como bus de mensajes entre instancias del servidor (útil si se escala horizontalmente, no necesario para un solo container)
