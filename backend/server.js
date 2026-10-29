/* global process */
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream'
import { mkdir, readdir, readFile, appendFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
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
      code: 'UNKNOWN',
    }
  }

  return {
    name: error.name,
    code: typeof error.code === 'string' ? error.code : 'UNKNOWN',
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
    code: 'UNKNOWN',
    message: truncateValue(String(value)),
  }
}

function toLogPath(filePath, rootPath) {
  if (!filePath) {
    return ''
  }

  if (isPathInsideRoot(rootPath, filePath)) {
    return relative(rootPath, filePath) || '.'
  }

  return basename(filePath)
}

function mapFileSystemErrorToStatus(error) {
  if (error && typeof error === 'object') {
    if (error.code === 'ENOENT') {
      return 404
    }

    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return 403
    }
  }

  return 500
}

function isClientDisconnectError(error) {
  if (!error || typeof error !== 'object') {
    return false
  }

  return (
    error.code === 'ECONNRESET' ||
    error.code === 'EPIPE' ||
    error.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    error.code === 'CLIENT_ABORTED'
  )
}

function sendJsonIfPossible(response, statusCode, payload) {
  if (response.headersSent || response.writableEnded || response.destroyed) {
    return false
  }

  sendJson(response, statusCode, payload)
  return true
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

function resolveRequestedDirectory(requestUrl, rootPath = documentsPath) {
  const url = new URL(requestUrl, 'http://localhost')
  const pathParam = url.searchParams.get('path')

  if (!pathParam) {
    return rootPath
  }

  const candidatePath = isAbsolute(pathParam)
    ? resolve(pathParam)
    : resolve(rootPath, pathParam)

  if (!isPathInsideRoot(rootPath, candidatePath)) {
    throw new Error('invalid_path')
  }

  return candidatePath
}

function resolveRequestedFile(requestUrl, rootPath = documentsPath) {
  const url = new URL(requestUrl, 'http://localhost')
  const pathParam = url.searchParams.get('path')

  if (!pathParam) {
    throw new Error('invalid_path')
  }

  const candidatePath = isAbsolute(pathParam)
    ? resolve(pathParam)
    : resolve(rootPath, pathParam)

  if (!isPathInsideRoot(rootPath, candidatePath)) {
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

function handleImageRequest({
  request,
  response,
  requestId,
  url,
  rootPath,
  log,
  createReadStreamImpl,
}) {
  try {
    const imagePath = resolveRequestedFile(request.url, rootPath)
    const extension = extname(imagePath).toLowerCase()
    const mimeType = imageMimeTypes[extension] || 'application/octet-stream'
    const imageStream = createReadStreamImpl(imagePath)
    let requestAborted = false

    const onClientAborted = () => {
      requestAborted = true
      const abortedError = new Error('client_aborted')
      abortedError.code = 'CLIENT_ABORTED'
      imageStream.destroy(abortedError)
    }

    request.once('aborted', onClientAborted)

    imageStream.once('open', () => {
      if (response.destroyed || response.writableEnded) {
        imageStream.destroy()
        return
      }

      if (!response.headersSent) {
        response.writeHead(200, {
          'Content-Type': mimeType,
          'Access-Control-Allow-Origin': '*',
        })
      }
    })

    pipeline(imageStream, response, (error) => {
      request.off('aborted', onClientAborted)

      if (!error) {
        return
      }

      if (isClientDisconnectError(error) || requestAborted) {
        void log({
          source: 'backend',
          category: 'image',
          level: 'warn',
          event: 'image_stream_aborted',
          requestId,
          operation: 'stream_image',
          filePath: toLogPath(imagePath, rootPath),
          path: url.pathname,
          queryPath: url.searchParams.get('path') || '',
          error: toErrorDetails(error),
        })
        return
      }

      const statusCode = mapFileSystemErrorToStatus(error)
      const clientMessage = statusCode === 404 ? 'Imagem não encontrada.' : 'Falha ao ler imagem.'

      void log({
        source: 'backend',
        category: 'image',
        level: statusCode >= 500 ? 'error' : 'warn',
        event: 'image_stream_failed',
        requestId,
        operation: 'stream_image',
        filePath: toLogPath(imagePath, rootPath),
        path: url.pathname,
        queryPath: url.searchParams.get('path') || '',
        error: toErrorDetails(error),
      })

      if (sendJsonIfPossible(response, statusCode, { error: clientMessage })) {
        return
      }

      if (!response.destroyed) {
        response.destroy(error)
      }
    })

    return true
  } catch (error) {
    void log({
      source: 'backend',
      category: 'image',
      level: 'warn',
      event: 'image_fetch_failed',
      requestId,
      operation: 'resolve_image_path',
      path: url.pathname,
      queryPath: url.searchParams.get('path') || '',
      error: toErrorDetails(error),
    })
    sendJson(response, 404, {
      error: 'Imagem não encontrada.',
    })
    return true
  }
}

async function handleDownloadRequest({
  request,
  response,
  requestId,
  url,
  rootPath,
  log,
  readFileImpl,
}) {
  try {
    const payload = await parseRequestBody(request)
    const selectedPaths = Array.isArray(payload.paths) ? payload.paths : []

    if (selectedPaths.length === 0) {
      void log({
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
      return true
    }

    const uniquePaths = [...new Set(selectedPaths)]
    void log({
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
      const imagePath = resolveRequestedFile(`/api/image?${query}`, rootPath)

      try {
        const fileBuffer = await readFileImpl(imagePath)
        zip.file(basename(imagePath), fileBuffer)
      } catch (error) {
        void log({
          source: 'backend',
          category: 'download',
          level: 'error',
          event: 'zip_file_read_failed',
          requestId,
          operation: 'zip_read_file',
          filePath: toLogPath(imagePath, rootPath),
          path: url.pathname,
          error: toErrorDetails(error),
        })

        throw error
      }
    }

    response.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="images.zip"',
      'Access-Control-Allow-Origin': '*',
    })

    const zipStream = zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true })

    pipeline(zipStream, response, (error) => {
      if (!error) {
        return
      }

      if (isClientDisconnectError(error)) {
        void log({
          source: 'backend',
          category: 'download',
          level: 'warn',
          event: 'zip_stream_aborted',
          requestId,
          operation: 'zip_stream_response',
          path: url.pathname,
          error: toErrorDetails(error),
        })
        return
      }

      void log({
        source: 'backend',
        category: 'download',
        level: 'error',
        event: 'zip_stream_failed',
        requestId,
        operation: 'zip_stream_response',
        path: url.pathname,
        error: toErrorDetails(error),
      })

      if (!response.destroyed) {
        response.destroy(error)
      }
    })

    return true
  } catch (error) {
    void log({
      source: 'backend',
      category: 'download',
      level: 'error',
      event: 'zip_generation_failed',
      requestId,
      operation: 'zip_generation',
      path: url.pathname,
      error: toErrorDetails(error),
    })

    const statusCode = mapFileSystemErrorToStatus(error)
    const clientMessage =
      statusCode === 404 ? 'Uma ou mais imagens não foram encontradas.' : 'Falha ao gerar arquivo ZIP.'

    sendJsonIfPossible(response, statusCode, {
      error: clientMessage,
    })
    return true
  }
}

export function createImageServer(options = {}) {
  const rootPath = options.documentsPath ? resolve(options.documentsPath) : documentsPath
  const createReadStreamImpl = options.createReadStreamImpl || createReadStream
  const readFileImpl = options.readFileImpl || readFile
  const log = options.auditLogWriter || writeAuditLog

  return createServer(async (request, response) => {
  const requestId = randomUUID()
  const requestUrl = new URL(request.url, 'http://localhost')
  const startedAt = Date.now()

  response.setHeader('X-Request-Id', requestId)
  response.on('finish', () => {
    void log({
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

    void log({
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

  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, {
      status: 'ok',
    })
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/directories') {
    try {
      const currentDirectory = resolveRequestedDirectory(request.url, rootPath)
      const entries = await listEntries(currentDirectory)
      sendJson(response, 200, {
        currentDirectory,
        parentDirectory: dirname(currentDirectory),
        basePath: rootPath,
        entries,
      })
      return
    } catch (error) {
      void log({
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
    if (
      handleImageRequest({
        request,
        response,
        requestId,
        url,
        rootPath,
        log,
        createReadStreamImpl,
      })
    ) {
      return
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/download') {
    if (
      await handleDownloadRequest({
        request,
        response,
        requestId,
        url,
        rootPath,
        log,
        readFileImpl,
      })
    ) {
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

      await log({
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
      void log({
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
}

const server = createImageServer()

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMainModule) {
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
}

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
