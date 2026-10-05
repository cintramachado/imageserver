const API_BASE_URL = `${window.location.protocol}//${window.location.hostname}:3001`
const AUDIT_ENDPOINT = new URL('/api/audit', API_BASE_URL)
let hasRegisteredGlobalAudit = false

function truncate(value, maxLength = 800) {
  if (typeof value !== 'string') {
    return value
  }

  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength)}...`
}

function normalizeError(error) {
  if (!(error instanceof Error)) {
    return {
      message: truncate(String(error)),
      name: 'UnknownError',
    }
  }

  return {
    name: error.name,
    message: truncate(error.message),
    stack: truncate(error.stack || '', 1200),
  }
}

export async function auditLog({ level = 'info', event = 'frontend_event', message = '', context = {} }) {
  const payload = {
    source: 'frontend',
    level,
    category: 'client',
    event,
    message: truncate(message, 1000),
    path: window.location.pathname,
    timestamp: new Date().toISOString(),
    context,
  }

  try {
    await fetch(AUDIT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      keepalive: true,
    })
  } catch (error) {
    console.error('Falha ao enviar log de auditoria para o backend.', normalizeError(error))
  }
}

export function registerGlobalErrorAudit() {
  if (hasRegisteredGlobalAudit) {
    return
  }

  hasRegisteredGlobalAudit = true

  window.addEventListener('error', (event) => {
    void auditLog({
      level: 'error',
      event: 'window_error',
      message: event.message || 'Erro global de janela',
      context: {
        fileName: event.filename || '',
        line: event.lineno || 0,
        column: event.colno || 0,
        error: normalizeError(event.error),
      },
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error ? normalizeError(event.reason) : truncate(String(event.reason))

    void auditLog({
      level: 'error',
      event: 'unhandled_rejection',
      message: 'Promise rejeitada sem tratamento',
      context: {
        reason,
      },
    })
  })
}
