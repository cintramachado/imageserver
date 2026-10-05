/* global process */
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, appendFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'

const PORT = Number(process.env.PORT) || 3001
const configuredDocumentsPath = process.env.DOCUMENTS_PATH?.trim()
const documentsPath = configuredDocumentsPath
  ? resolve(configuredDocumentsPath)
  : join(homedir(), 'Documents')
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'])

const imageMimeTypes = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
}

const logsDirectory = join(process.cwd(), 'backend', 'logs')
const auditLogFilePath = join(logsDirectory, 'audit.log.ndjson')

function truncateValue(value, maxLength = 700) {
  if (typeof value !== 'string') {
    return value
  }

  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength)}...`
}

function toErrorDetails(error) {
  if (!(error instanceof Error)) {
    return {
      message: String(error),
      name: 'UnknownError',
    }
  }

  return {
    name: error.name,
    message: truncateValue(error.message),
    stack: truncateValue(error.stack || ''),
  }
}

function toUnknownErrorDetails(value) {
  if (value instanceof Error) {
    return toErrorDetails(value)
  }

  return {
    name: 'UnknownError',
    message: truncateValue(String(value)),
  }
}

async function writeAuditLog(entry) {
  const payload = {
    timestamp: new Date().toISOString(),
    ...entry,
  }

  try {
    await mkdir(logsDirectory, { recursive: true })
    await appendFile(auditLogFilePath, `${JSON.stringify(payload)}\n`, 'utf8')
  } catch (error) {
    console.error('Falha ao persistir log de auditoria', toErrorDetails(error))
  }
}

function sanitizeClientContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return {}
  }

  const entries = Object.entries(context).slice(0, 15)
  const sanitized = {}

  for (const [key, value] of entries) {
    if (typeof value === 'string') {
      sanitized[key] = truncateValue(value, 1000)
      continue
    }

    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      sanitized[key] = value
      continue
    }

    sanitized[key] = truncateValue(JSON.stringify(value), 1000)
  }

  return sanitized
}

function readClientIp(request) {
  const forwardedFor = request.headers['x-forwarded-for']

  if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
    return forwardedFor.split(',')[0].trim()
  }

  return request.socket.remoteAddress || 'unknown'
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  })

  response.end(JSON.stringify(payload))
}

async function listEntries(basePath) {
  const entries = await readdir(basePath, { withFileTypes: true })

  return entries
    .map((entry) => {
      const entryPath = join(basePath, entry.name)

      if (entry.isDirectory()) {
        return {
          name: entry.name,
          path: entryPath,
          type: 'directory',
        }
      }

      const extension = extname(entry.name).toLowerCase()

      if (!imageExtensions.has(extension)) {
        return null
      }

      const query = new URLSearchParams({ path: entryPath }).toString()

      return {
        name: entry.name,
        path: entryPath,
        type: 'image',
        thumbnailUrl: `/api/image?${query}`,
      }
    })
    .filter(Boolean)
}

function isPathInsideRoot(rootPath, candidatePath) {
  const normalizedRoot = resolve(rootPath)
  const normalizedCandidate = resolve(candidatePath)
  const relativePath = relative(normalizedRoot, normalizedCandidate)

  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

function resolveRequestedDirectory(requestUrl) {
  const url = new URL(requestUrl, 'http://localhost')
  const pathParam = url.searchParams.get('path')

  if (!pathParam) {
    return documentsPath
  }

  const candidatePath = isAbsolute(pathParam)
    ? resolve(pathParam)
    : resolve(documentsPath, pathParam)

  if (!isPathInsideRoot(documentsPath, candidatePath)) {
    throw new Error('invalid_path')
  }

  return candidatePath
}

function resolveRequestedFile(requestUrl) {
  const url = new URL(requestUrl, 'http://localhost')
  const pathParam = url.searchParams.get('path')

  if (!pathParam) {
    throw new Error('invalid_path')
  }

  const candidatePath = isAbsolute(pathParam)
    ? resolve(pathParam)
    : resolve(documentsPath, pathParam)

  if (!isPathInsideRoot(documentsPath, candidatePath)) {
    throw new Error('invalid_path')
  }

  const extension = extname(candidatePath).toLowerCase()

  if (!imageExtensions.has(extension)) {
    throw new Error('invalid_file_type')
  }

  return candidatePath
}

async function parseRequestBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = ''

    request.on('data', (chunk) => {
      body += chunk
    })

    request.on('end', () => {
      try {
        resolveBody(JSON.parse(body || '{}'))
      } catch {
        rejectBody(new Error('invalid_json'))
      }
    })

    request.on('error', () => {
      rejectBody(new Error('request_error'))
    })
  })
}

const server = createServer(async (request, response) => {
  const requestId = randomUUID()
  const requestUrl = new URL(request.url, 'http://localhost')
  const startedAt = Date.now()

  response.setHeader('X-Request-Id', requestId)
  response.on('finish', () => {
    void writeAuditLog({
      source: 'backend',
      category: 'http',
      level: response.statusCode >= 500 ? 'error' : 'info',
      event: 'response_sent',
      requestId,
      method: request.method,
      path: requestUrl.pathname,
      statusCode: response.statusCode,
      durationMs: Date.now() - startedAt,
      clientIp: readClientIp(request),
    })
  })

  response.on('close', () => {
    if (response.writableEnded) {
      return
    }

    void writeAuditLog({
      source: 'backend',
      category: 'http',
      level: 'warn',
      event: 'response_aborted',
      requestId,
      method: request.method,
      path: requestUrl.pathname,
      durationMs: Date.now() - startedAt,
      clientIp: readClientIp(request),
    })
  })

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    response.end()
    return
  }

  const url = requestUrl

  if (request.method === 'GET' && url.pathname === '/api/directories') {
    try {
      const currentDirectory = resolveRequestedDirectory(request.url)
      const entries = await listEntries(currentDirectory)
      sendJson(response, 200, {
        currentDirectory,
        parentDirectory: dirname(currentDirectory),
        basePath: documentsPath,
        entries,
      })
      return
    } catch (error) {
      void writeAuditLog({
        source: 'backend',
        category: 'directories',
        level: 'error',
        event: 'list_directories_failed',
        requestId,
        path: url.pathname,
        queryPath: url.searchParams.get('path') || '',
        error: toErrorDetails(error),
      })
      sendJson(response, 500, {
        error: 'Falha ao listar diretórios em Documents.',
      })
      return
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/image') {
    try {
      const imagePath = resolveRequestedFile(request.url)
      const extension = extname(imagePath).toLowerCase()
      const mimeType = imageMimeTypes[extension] || 'application/octet-stream'

      const imageStream = createReadStream(imagePath)

      imageStream.on('open', () => {
        response.writeHead(200, {
          'Content-Type': mimeType,
          'Access-Control-Allow-Origin': '*',
        })
        imageStream.pipe(response)
      })

      imageStream.on('error', (error) => {
        void writeAuditLog({
          source: 'backend',
          category: 'image',
          level: 'error',
          event: 'image_stream_failed',
          requestId,
          path: url.pathname,
          queryPath: url.searchParams.get('path') || '',
          error: toErrorDetails(error),
        })

        if (response.headersSent) {
          response.destroy(error)
          return
        }

        sendJson(response, 404, {
          error: 'Imagem não encontrada.',
        })
      })

      return
    } catch (error) {
      void writeAuditLog({
        source: 'backend',
        category: 'image',
        level: 'warn',
        event: 'image_fetch_failed',
        requestId,
        path: url.pathname,
        queryPath: url.searchParams.get('path') || '',
        error: toErrorDetails(error),
      })
      sendJson(response, 404, {
        error: 'Imagem não encontrada.',
      })
      return
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/download') {
    try {
      const payload = await parseRequestBody(request)
      const selectedPaths = Array.isArray(payload.paths) ? payload.paths : []

      if (selectedPaths.length === 0) {
        void writeAuditLog({
          source: 'backend',
          category: 'download',
          level: 'warn',
          event: 'zip_empty_selection',
          requestId,
          path: url.pathname,
        })

        sendJson(response, 400, {
          error: 'Nenhuma imagem selecionada para download.',
        })
        return
      }

      const uniquePaths = [...new Set(selectedPaths)]
      void writeAuditLog({
        source: 'backend',
        category: 'download',
        level: 'info',
        event: 'zip_generation_started',
        requestId,
        path: url.pathname,
        selectedCount: selectedPaths.length,
        uniqueCount: uniquePaths.length,
      })

      const zip = new JSZip()

      for (const imagePathRaw of uniquePaths) {
        const query = new URLSearchParams({ path: String(imagePathRaw) }).toString()
        const imagePath = resolveRequestedFile(`/api/image?${query}`)
        const fileBuffer = await readFile(imagePath)
        zip.file(basename(imagePath), fileBuffer)
      }

      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' })

      response.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="images.zip"',
        'Access-Control-Allow-Origin': '*',
      })
      response.end(zipBuffer)
      return
    } catch (error) {
      void writeAuditLog({
        source: 'backend',
        category: 'download',
        level: 'error',
        event: 'zip_generation_failed',
        requestId,
        path: url.pathname,
        error: toErrorDetails(error),
      })
      sendJson(response, 400, {
        error: 'Falha ao gerar arquivo ZIP.',
      })
      return
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/audit') {
    try {
      const payload = await parseRequestBody(request)
      const level =
        payload?.level === 'error' || payload?.level === 'warn' || payload?.level === 'info'
          ? payload.level
          : 'info'

      await writeAuditLog({
        source: 'frontend',
        category: payload?.category || 'client',
        level,
        event: payload?.event || 'frontend_event',
        requestId: payload?.requestId || requestId,
        path: payload?.path || '',
        clientTimestamp: payload?.timestamp || '',
        message: truncateValue(String(payload?.message || '')),
        context: sanitizeClientContext(payload?.context),
        clientIp: readClientIp(request),
        userAgent: truncateValue(String(request.headers['user-agent'] || ''), 400),
      })

      sendJson(response, 202, {
        status: 'accepted',
      })
      return
    } catch (error) {
      void writeAuditLog({
        source: 'backend',
        category: 'audit',
        level: 'error',
        event: 'audit_ingestion_failed',
        requestId,
        error: toErrorDetails(error),
      })

      sendJson(response, 400, {
        error: 'Falha ao registrar auditoria do cliente.',
      })
      return
    }
  }

  sendJson(response, 404, {
    error: 'Rota não encontrada.',
  })
})

server.listen(PORT, () => {
  void writeAuditLog({
    source: 'backend',
    category: 'startup',
    level: 'info',
    event: 'server_started',
    port: PORT,
    documentsPath,
  })

  console.log(`Backend ativo em http://localhost:${PORT}`)
})

process.on('uncaughtException', (error) => {
  void writeAuditLog({
    source: 'backend',
    category: 'runtime',
    level: 'error',
    event: 'uncaught_exception',
    error: toErrorDetails(error),
  })

  console.error('uncaughtException', error)
})

process.on('unhandledRejection', (reason) => {
  void writeAuditLog({
    source: 'backend',
    category: 'runtime',
    level: 'error',
    event: 'unhandled_rejection',
    error: toUnknownErrorDetails(reason),
  })

  console.error('unhandledRejection', reason)
})
