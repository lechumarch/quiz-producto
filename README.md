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
- **Contenedor:** tiene `Dockerfile` en la raíz, listo para usar

---

## Lo que ya está resuelto en el servidor

Según el relevamiento previo del servidor:

- ✅ Docker + Docker Compose instalados (quedaron de OpenMemory)
- ✅ Tailscale con **Funnel** activo exponiendo el servidor públicamente en `homeserver.tail65f563.ts.net`
- ✅ Funnel soporta WebSockets nativamente (proxy TCP con TLS termination)
- ✅ El bug conocido de Tailscale Funnel (feb 2026) que elimina query params en upgrades WS **no afecta esta app** — los WS no usan query params, el join va por mensaje después de conectar

---

## Lo que hay que hacer

### 1. Clonar el repo

```bash
git clone https://github.com/lechumarch/quiz-producto.git
cd quiz-producto
```

### 2. Crear el archivo `.env`

Crear un `.env` en la raíz con estos valores (cambiar los passwords):

```env
DB_PASSWORD=un_password_seguro
BASIC_AUTH_USER=admin
BASIC_AUTH_PASS=otro_password_seguro
```

### 3. Crear `docker-compose.yml`

El repo no incluye el compose (tiene secrets). Crearlo en la raíz:

```yaml
services:
  app:
    build: .
    restart: unless-stopped
    environment:
      - DB_HOST=db
      - DB_PORT=5432
      - DB_NAME=quiz
      - DB_USER=quiz
      - DB_PASSWORD=${DB_PASSWORD}
      - BASIC_AUTH_USER=${BASIC_AUTH_USER}
      - BASIC_AUTH_PASS=${BASIC_AUTH_PASS}
      - PORT=3000
    ports:
      - "3000:3000"
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:15-alpine
    restart: unless-stopped
    environment:
      - POSTGRES_DB=quiz
      - POSTGRES_USER=quiz
      - POSTGRES_PASSWORD=${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U quiz"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

### 4. Levantar la app

```bash
docker compose up -d --build
```

Verificar que levantó:

```bash
docker compose logs -f app
```

Debería terminar con algo como `Quiz app on :3000` y `DB migrations done`.

### 5. Exponer con Tailscale Funnel

Primero revisar la config actual del Funnel para no pisar nada:

```bash
tailscale serve status
```

Luego exponer el puerto 3000 de la app. Hay dos opciones limpias:

**Opción A — Path mount en 443** (misma URL base que Ownia, más limpio):
```bash
tailscale serve --set-path /quiz-producto https+insecure://localhost:3000/quiz-producto
```

**Opción B — Puerto dedicado 8443** (aislado, no toca config existente):
```bash
tailscale serve --https=8443 https+insecure://localhost:3000
tailscale funnel 8443 on
```

Elegir según lo que muestre `tailscale serve status` — la Opción B es más segura si el snapshot ya usa el 443.

Una vez configurado, activar el Funnel:
```bash
tailscale funnel on   # si usaste opción A
# o ya está implícito en la opción B
```

---

## URLs finales

Según la opción elegida:

| | URL |
|---|---|
| Jugadores (celu) | `https://homeserver.tail65f563.ts.net/quiz-producto/join` |
| Host (quien conduce) | `https://homeserver.tail65f563.ts.net/quiz-producto/` |
| Admin (crear quizzes) | `https://homeserver.tail65f563.ts.net/quiz-producto/admin/` |

El panel admin pide usuario y contraseña (los `BASIC_AUTH_*` del `.env`).

---

## Verificar que todo funciona

1. Desde el servidor: `curl http://localhost:3000/quiz-producto/` → debe responder (401 si basic auth activo, es correcto)
2. Desde el celu por la URL pública: abrir `/quiz-producto/join` → debe cargar la pantalla de selección de jugador
3. Test de WebSocket: entrar a `/quiz-producto/join`, seleccionar un jugador → debe conectar y mostrar "Esperando al admin"

---

## Higiene de seguridad

Funnel expone el servidor públicamente. Consideraciones:

- El panel admin está protegido por basic auth ✅
- La pantalla de join es abierta (necesario para que los jugadores entren) ✅
- **Recomendado:** apagar el Funnel cuando no hay quiz activo y prenderlo solo el día del evento:

```bash
tailscale funnel 8443 off   # apagar
tailscale funnel 8443 on    # prender el día del quiz
```

---

## Operación día a día

```bash
# Ver estado
docker compose ps

# Ver logs en vivo
docker compose logs -f app

# Reiniciar la app (si hubo un update del repo)
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
  game/
    engine.ts       # lógica del juego, manejo de sesiones y WS
    scoring.ts      # cálculo de puntajes
  routes/
    admin.ts        # endpoints del panel admin (protegidos con basic auth)
    player.ts       # endpoints públicos (jugadores)
  middleware/
    auth.ts         # basic auth
public/
  join.html         # pantalla de ingreso al quiz (jugadores)
  play.html         # pantalla de juego (jugadores)
  admin/            # panel de administración
  host/             # pantalla del host que conduce el quiz
Dockerfile
```

---

## Notas de arquitectura relevantes

- La app corre las **migraciones automáticamente** al arrancar — no hace falta correr nada manualmente contra la DB
- Los **avatares de jugadores** se guardan como base64 en PostgreSQL (no en disco), por eso el volume solo necesita espacio para la DB
- El **Ranking Anual** ordena por victorias (1er puesto por sesión), con puntaje total como tie-breaker
- La tabla `quiz_events` actúa como bus de mensajes entre instancias del servidor (útil si se escala horizontalmente, no necesario para un solo container)
