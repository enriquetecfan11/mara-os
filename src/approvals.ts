const riskyWords = /\b(publica|publicar|postea|postear|tuitea|twittea|tweet)\b/i
const approvalWords = /^(confirmo|confirmado|sí,?\s*confirmo|si,?\s*confirmo)\b/i

export const approvalMessage =
  "Esto sale fuera de Telegram. Si quieres hacerlo, empieza el mensaje por: Confirmo"

export function needsApproval(message: string) {
  return riskyWords.test(message)
}

export function hasApproval(message: string) {
  return approvalWords.test(message.trim())
}
