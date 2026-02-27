import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import JSZip from 'jszip'

const PORT = Number(process.env.PORT) || 3001
const documentsPath = join(homedir(), 'Documents')
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

  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}\\`)
  )
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
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    response.end()
    return
  }

  const url = new URL(request.url, 'http://localhost')

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
    } catch {
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

      response.writeHead(200, {
        'Content-Type': mimeType,
        'Access-Control-Allow-Origin': '*',
      })

      createReadStream(imagePath).pipe(response)
      return
    } catch {
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
        sendJson(response, 400, {
          error: 'Nenhuma imagem selecionada para download.',
        })
        return
      }

      const uniquePaths = [...new Set(selectedPaths)]
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
    } catch {
      sendJson(response, 400, {
        error: 'Falha ao gerar arquivo ZIP.',
      })
      return
    }
  }

  sendJson(response, 404, {
    error: 'Rota não encontrada.',
  })
})

server.listen(PORT, () => {
  console.log(`Backend ativo em http://localhost:${PORT}`)
})
