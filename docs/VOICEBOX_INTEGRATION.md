# Integración de Voicebox TTS en Mara OS

Documento técnico explicando cómo funciona la integración de síntesis de voz con Voicebox mediante REST API.

## Arquitectura

```
Telegram (usuario envía mensaje)
    ↓
Mara OS (bot.ts)
    ↓
Ollama (genera respuesta en texto)
    ↓
Voicebox REST API (convierte texto → audio WAV)
    ↓
Telegram (envía texto + audio)
```

## Flujo de integración

### 1. Resolución del perfil de voz

**Endpoint**: `GET /profiles`

**Función**: `src/voicebox.ts:resolveProfileId()`

Al iniciar el bot o generar la primera respuesta, el código consulta la lista de perfiles disponibles en Voicebox y busca el nombre configurado en `.env` (por defecto `"Mara"`).

**Curl**:
```bash
curl -X GET "http://192.168.1.79:17493/profiles" \
  -H "Content-Type: application/json"
```

**Respuesta esperada** (JSON):
```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Alex",
    "description": "Male voice, friendly tone",
    "language": "en",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-15T10:30:00Z"
  },
  {
    "id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "name": "Sofia",
    "description": "Female voice, professional",
    "language": "es",
    "created_at": "2024-01-10T08:15:00Z",
    "updated_at": "2024-01-10T08:15:00Z"
  }
]
```

**Lo que hace el código**:
1. Hace fetch a `${VOICEBOX_URL}/profiles`
2. Busca el perfil por `name.toLowerCase() === "Mara".toLowerCase()`
3. Cachea el `id` en memoria (`cachedProfileId`) para reutilizarlo
4. Si no encuentra el perfil, lanza error con la lista de perfiles disponibles

**Caché**: Una vez resuelto, el `id` se almacena en una variable de módulo. Si quieres forzar recarga, reinicia el bot.

---

### 2. Generación de audio (síntesis de voz)

**Endpoint**: `POST /generate/stream`

**Función**: `src/voicebox.ts:generateVoice(text)`

Una vez que se tiene el `profile_id`, el código envía el texto de la respuesta a Voicebox para sintetizar audio.

**Curl**:
```bash
curl -X POST "http://192.168.1.79:17493/generate/stream" \
  -H "Content-Type: application/json" \
  -d '{
    "profile_id": "550e8400-e29b-41d4-a716-446655440000",
    "text": "Hola, aquí está tu respuesta en audio.",
    "language": "es"
  }' \
  --output respuesta.wav
```

**Request body**:
```json
{
  "profile_id": "550e8400-e29b-41d4-a716-446655440000",  // ID resuelto en paso 1
  "text": "Hola, aquí está tu respuesta en audio.",        // Texto a sintetizar (max 5000 chars)
  "language": "es"                                         // Idioma (es, en, zh, ja, ko, de, fr, etc.)
}
```

**Respuesta esperada**:
- **Content-Type**: `audio/wav`
- **Body**: Bytes binarios WAV (audio crudo)
- **Streaming**: La respuesta se devuelve en streaming (no es JSON)

**Ejemplo recibiendo archivo**:
```bash
curl -X POST "http://192.168.1.79:17493/generate/stream" \
  -H "Content-Type: application/json" \
  -d '{"profile_id":"550e8400-e29b-41d4-a716-446655440000","text":"Hola mundo","language":"es"}' \
  --output audio_response.wav

# Verificar el archivo generado
file audio_response.wav
# audio_response.wav: RIFF (little-endian) data, WAVE audio, mono 24000 Hz, 24 bit, uncompressed
```

**Lo que hace el código**:
1. Obtiene el `profile_id` (resuelto en paso 1)
2. Ejecuta `generateVoice(text)` con timeout de 30 segundos
3. Convierte la respuesta binaria a un `Buffer` de Node.js
4. Devuelve el `Buffer` listo para enviar a Telegram

**Manejo de errores**:
- Si `response.ok` es falso (HTTP error), lanza excepción
- Si timeout se activa (>30s), aborta la solicitud
- El error se captura en `maybeSendVoice()` (en `bot.ts`) y se registra sin romper el bot

---

### 3. Entrega de la respuesta (texto vs audio)

**Función**: `src/bot.ts:deliverReply(ctx, text, isAudioInput)`

El **texto se envía siempre** (respuesta inmediata) y, **además**, se añade una **nota de voz** cuando corresponde: por defecto solo si la entrada fue una nota de voz/audio. `/voz on|off` y `TELEGRAM_SEND_VOICE` anulan ese default.

**Lógica de decisión** (`wantVoiceFor` + `deliverReply`):
```
wantVoice =
  VOICEBOX_ENABLED &&
    ( /voz on|off marcado para el chat ? ese valor
      : TELEGRAM_SEND_VOICE=true       ? true (voz global)
      : la entrada fue audio )                 // default: imitar entrada

- Enviar SIEMPRE el texto
- Si wantVoice → añadir nota de voz (solo si texto ≤ 500 chars; si falla, se omite)
```

| Entrada | Sin override | `/voz off` | `/voz on` | `TELEGRAM_SEND_VOICE=true` |
|---|---|---|---|---|
| Texto | solo texto | solo texto | texto + audio | texto + audio |
| Audio | **texto + audio** | solo texto | texto + audio | texto + audio |

**Código en los handlers** (`message:text`, `message:photo`, `handleIncomingAudio`):
```typescript
const answer = await askPiWithRetry(ctx.chat.id, input)
const stripped = stripMarkdown(answer)
stopTyping(typing)                                // corta "escribiendo…" al tener la respuesta
await deliverReply(ctx, stripped, isAudioInput)   // isAudioInput = true solo para voice/audio
```

**Implementación**:
```typescript
async function deliverReply(ctx: Context, text: string, isAudioInput: boolean): Promise<void> {
  await ctx.reply(text)                                              // siempre texto
  if (voiceboxEnabled && wantVoiceFor(ctx.chat!.id, isAudioInput)) {
    await trySendVoice(ctx, text)                                    // además, nota de voz
  }
}
```

**Envío como nota de voz** (`trySendVoice` + `src/audio.ts`):
- El WAV de Voicebox se transcodifica a **OGG/Opus** con ffmpeg (`wavToOggOpus`).
- Se envía con `ctx.replyWithVoice(new InputFile(ogg, "respuesta.ogg"))` → aparece como **nota de voz** (burbuja con onda), no como archivo de música.
- Si ffmpeg/opus no está disponible, cae a `replyWithAudio` (WAV) sin romper.
- Durante la generación se muestra la acción `record_voice` ("grabando audio…").

---

## Control por chat: comando `/voz on|off`

**Función**: `src/bot.ts` línea ~340

Permite activar/desactivar el audio por chat sin reiniciar el bot.

**Comando**:
```
/voz on     → Activa audio para este chat
/voz off    → Desactiva audio para este chat
/voz        → Muestra uso (sin argumento)
```

**Implementación**:
```typescript
const voiceOverrides = new Map<number, boolean>()  // Por chat ID

function wantVoiceFor(chatId: number, isAudioInput: boolean): boolean {
  if (voiceOverrides.has(chatId)) return voiceOverrides.get(chatId)!  // /voz manda
  if (telegramSendVoiceDefault) return true                          // voz global on
  return isAudioInput                                                // default: imitar entrada
}
```

**Ejemplo de flujo**:
```
Chat 1 (ID: 123): sin override, TELEGRAM_SEND_VOICE=false
  → Texto → responde texto · Nota de voz → responde audio (imita entrada)

Chat 2 (ID: 456): /voz on
  → voiceOverrides.set(456, true)
  → Texto → texto + audio · Nota de voz → audio

Chat 3 (ID: 789): /voz off
  → voiceOverrides.set(789, false)
  → Cualquier entrada (texto o audio) → solo texto

Reinicio del bot: los overrides en memoria se pierden → vuelve a "imitar entrada"
```

---

## Variables de configuración

### `.env`

```env
# Voicebox (síntesis de voz)
VOICEBOX_URL=http://192.168.1.79:17493          # URL del servidor Voicebox
VOICEBOX_ENABLED=true                            # Habilita/deshabilita la integración
VOICEBOX_PROFILE=Mara                            # Nombre del perfil de voz
TELEGRAM_SEND_VOICE=true                         # Envía audio por defecto (puede override con /voz)
```

### Exportadas en `src/config.ts`

```typescript
export const voiceboxUrl = process.env.VOICEBOX_URL || "http://192.168.1.79:17493"
export const voiceboxEnabled = process.env.VOICEBOX_ENABLED === "true"
export const voiceboxProfile = process.env.VOICEBOX_PROFILE || "Mara"
export const telegramSendVoiceDefault = process.env.TELEGRAM_SEND_VOICE === "true"
```

---

## Limitaciones y decisiones de diseño

### ✅ Implementadas

| Aspecto | Decisión | Razón |
|---------|----------|-------|
| **Longitud máxima** | 500 caracteres | Evitar audios muy largos que sobrecargen la API |
| **Idioma** | Español ("es") | Configurado en `generateVoice()` línea 52 de `voicebox.ts` |
| **Formato de audio** | WAV → OGG/Opus (ffmpeg) | Telegram exige OGG/Opus para notas de voz; si falla, cae a WAV |
| **Tipo de envío** | `replyWithVoice` (nota de voz) | Burbuja con onda; fallback a `replyWithAudio` sin ffmpeg/opus |
| **Timeout** | 30 segundos | Balance entre espera razonable y timeout defensivo |
| **Caché de perfil** | En memoria (por módulo) | Una resolución por proceso de bot |
| **Manejo de error** | No rompe el bot | Si Voicebox falla, el texto se envió igual |

### ❌ No implementadas (out of scope)

- Streaming de audio en tiempo real
- Múltiples perfiles por chat
- Efectos de sonido personalizados
- Almacenamiento de audios generados (se descartan tras enviar)
- Webhooks para notificaciones de generación

---

## Debugging

### Activar logs detallados

```bash
LOG_LEVEL=debug pnpm bot
```

**Output esperado**:
```
[14:32:55] [DEBUG] [Voicebox] Fetching profiles from http://192.168.1.79:17493/profiles
[14:32:55] [INFO]  [Voicebox] Resolved profile "Mara" to id: 0233d133-2e4d-4071-9934-d7f7a483be3a
[14:32:56] [DEBUG] [Voicebox] Generating voice for 45 chars
[14:32:57] [DEBUG] [Voicebox] Generated 182340 bytes of audio
```

### Verificar endpoint de Voicebox

```bash
# ¿Está corriendo Voicebox?
curl -s http://192.168.1.79:17493/health | jq .

# ¿Qué perfiles existen?
curl -s http://192.168.1.79:17493/profiles | jq '.[] | {name, id}'

# Prueba de síntesis (genera archivo local)
curl -X POST "http://192.168.1.79:17493/generate/stream" \
  -H "Content-Type: application/json" \
  -d '{
    "profile_id": "TU_PROFILE_ID_AQUI",
    "text": "Prueba de síntesis de voz.",
    "language": "es"
  }' \
  --output prueba.wav && \
  file prueba.wav && \
  ls -lh prueba.wav
```

### Casos de fallo comunes

| Error | Causa | Solución |
|-------|-------|----------|
| `Connection refused` | Voicebox no está corriendo | `voicebox --server` en otra terminal |
| `Profile "Mara" not found` | Nombre exacto no existe | Ver `/profiles`, usar nombre exacto |
| `HTTP 422 Validation Error` | Campo faltante o inválido en request | Revisar body JSON (profile_id, text, language) |
| `Timeout after 30s` | Voicebox tardó >30s | Aumentar timeout en `voicebox.ts:48` o revisar carga de Voicebox |
| `Bot responde solo con texto` | VOICEBOX_ENABLED=false o TELEGRAM_SEND_VOICE=false | Verificar `.env` o usar `/voz on` |

---

## Flujo completo: ejemplo paso a paso

### Usuario envía: "¿Qué hora es?"

```
1. Telegram recibe el mensaje
   └─> bot.ts:350 "message:text" handler

2. Aprobaciones
   └─> needsApproval()? No → continuar

3. Ollama genera respuesta
   └─> askPiWithRetry(chatId, "¿Qué hora es?")
   └─> Respuesta: "Son las 14:32:55 en Madrid"

4. Envía texto a Telegram
   └─> stripMarkdown(answer) → "Son las 14:32:55 en Madrid"
   └─> await ctx.reply("Son las 14:32:55 en Madrid")
   └─> ✅ Usuario ve mensaje de texto en Telegram

5. Intenta generar audio
   └─> maybeSendVoice(ctx, "Son las 14:32:55 en Madrid")
   └─> Verifica: VOICEBOX_ENABLED=true? Sí
   └─> Verifica: shouldSendVoice(207196532)? Sí (default)
   └─> Verifica: length <= 500? Sí (25 caracteres)

6. Resuelve perfil
   └─> resolveProfileId()
   └─> ¿Caché existe? No → fetch /profiles
   └─> Busca "Mara" → encuentra "0233d133-..."
   └─> Cachea en memoria

7. Sintetiza voz
   └─> generateVoice("Son las 14:32:55 en Madrid")
   └─> POST /generate/stream con {profile_id, text, language: "es"}
   └─> Voicebox genera 182340 bytes de audio WAV
   └─> Devuelve Buffer

8. Envía audio a Telegram
   └─> ctx.replyWithAudio(new InputFile(buffer, "respuesta.wav"))
   └─> ✅ Usuario ve archivo de audio adjunto en Telegram

9. Log de éxito
   └─> info("Telegram", `Replied to @username (1.2s)`)
```

---

## Referencias

- **Voicebox OpenAPI**: https://docs.voicebox.sh/api-reference/generation/generate-speech
- **Grammy (Telegram Bot Framework)**: https://grammy.dev/guide/files.html#sending-files
- **Node.js Fetch API**: https://nodejs.org/api/fetch.html

