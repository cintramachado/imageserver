import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { request as httpRequest } from 'node:http'
import JSZip from 'jszip'

import { createImageServer } from '../server.js'

function makeError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

async function startServer({
  documentsPath,
  createReadStreamImpl,
  readFileImpl,
  auditLogWriter,
}) {
  const logs = []
  const server = createImageServer({
    documentsPath,
    createReadStreamImpl,
    readFileImpl,
    auditLogWriter: auditLogWriter || ((entry) => logs.push(entry)),
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()

  return {
    logs,
    server,
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close()
      await once(server, 'close')
    },
  }
}

async function call(origin, path, { method = 'GET', body, signal } = {}) {
  const url = new URL(path, origin)

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers:
          body === undefined
            ? undefined
            : {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
              },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        })
      },
    )

    req.on('error', reject)

    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          req.destroy(makeError('ABORT_ERR', 'Request aborted in test'))
        },
        { once: true },
      )
    }

    if (body !== undefined) {
      req.write(body)
    }

    req.end()
  })
}

function createSlowReadable(buffer, delayMs = 5) {
  let index = 0

  return new Readable({
    read() {
      if (index >= buffer.length) {
        this.push(null)
        return
      }

      const next = buffer.subarray(index, index + 1)
      index += 1

      setTimeout(() => {
        this.push(next)
      }, delayMs)
    },
  })
}

test('GET /api/image streams PNG successfully', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imageserver-test-'))
  const imagePath = join(root, 'ok.png')
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
  await writeFile(imagePath, imageBytes)

  const app = await startServer({ documentsPath: root })

  try {
    const result = await call(
      app.origin,
      `/api/image?path=${encodeURIComponent(imagePath)}`,
    )

    assert.equal(result.statusCode, 200)
    assert.equal(result.headers['content-type'], 'image/png')
    assert.equal(result.headers['access-control-allow-origin'], '*')
    assert.deepEqual(result.body, imageBytes)
  } finally {
    await app.close()
  }
})

test('GET /api/image returns 404 for non-existent file and API stays available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imageserver-test-'))
  const imagePath = join(root, 'missing.png')

  const app = await startServer({ documentsPath: root })

  try {
    const missing = await call(
      app.origin,
      `/api/image?path=${encodeURIComponent(imagePath)}`,
    )

    assert.equal(missing.statusCode, 404)
    assert.match(missing.body.toString('utf8'), /Imagem não encontrada|Falha ao ler imagem/)

    const health = await call(app.origin, '/api/health')
    assert.equal(health.statusCode, 200)
    assert.match(health.body.toString('utf8'), /ok/)
  } finally {
    await app.close()
  }
})

test('GET /api/image handles ENODATA stream error before headers without crashing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imageserver-test-'))
  const imagePath = join(root, 'broken.png')

  const createReadStreamImpl = () => {
    const stream = new Readable({ read() {} })
    queueMicrotask(() => {
      stream.destroy(makeError('ENODATA', 'no data available'))
    })
    return stream
  }

  const app = await startServer({ documentsPath: root, createReadStreamImpl })

  try {
    const failed = await call(
      app.origin,
      `/api/image?path=${encodeURIComponent(imagePath)}`,
    )

    assert.equal(failed.statusCode, 500)
    assert.match(failed.body.toString('utf8'), /Falha ao ler imagem/)

    const health = await call(app.origin, '/api/health')
    assert.equal(health.statusCode, 200)

    const streamFailLog = app.logs.find((entry) => entry.event === 'image_stream_failed')
    assert.ok(streamFailLog)
    assert.equal(streamFailLog.error.code, 'ENODATA')
  } finally {
    await app.close()
  }
})

test('GET /api/image handles stream error after response has started', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imageserver-test-'))
  const imagePath = join(root, 'mid-error.png')

  const createReadStreamImpl = () => {
    const stream = new Readable({
      read() {
        this.push(Buffer.from([0x89, 0x50]))
        this.destroy(makeError('ENODATA', 'late read failure'))
      },
    })
    return stream
  }

  const app = await startServer({ documentsPath: root, createReadStreamImpl })

  try {
    await assert.rejects(
      async () =>
        call(app.origin, `/api/image?path=${encodeURIComponent(imagePath)}`),
      /socket hang up|ECONNRESET/,
    )

    const health = await call(app.origin, '/api/health')
    assert.equal(health.statusCode, 200)
  } finally {
    await app.close()
  }
})

test('GET /api/image handles client disconnect during transfer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imageserver-test-'))
  const imagePath = join(root, 'large.png')
  const content = Buffer.alloc(2048, 7)

  const createReadStreamImpl = () => createSlowReadable(content, 1)

  const app = await startServer({ documentsPath: root, createReadStreamImpl })

  try {
    const controller = new AbortController()
    const pending = call(
      app.origin,
      `/api/image?path=${encodeURIComponent(imagePath)}`,
      { signal: controller.signal },
    )

    setTimeout(() => controller.abort(), 8)
    await assert.rejects(async () => pending)

    const health = await call(app.origin, '/api/health')
    assert.equal(health.statusCode, 200)

    const abortedLog = app.logs.find((entry) => entry.event === 'image_stream_aborted')
    assert.ok(abortedLog)
  } finally {
    await app.close()
  }
})

test('POST /api/download returns ZIP for multiple images', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imageserver-test-'))
  const imageA = join(root, 'a.png')
  const imageB = join(root, 'b.webp')
  await writeFile(imageA, Buffer.from('aaa'))
  await writeFile(imageB, Buffer.from('bbb'))

  const app = await startServer({ documentsPath: root })

  try {
    const response = await call(app.origin, '/api/download', {
      method: 'POST',
      body: JSON.stringify({
        paths: [imageA, imageB],
      }),
    })

    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['content-type'], 'application/zip')

    const zip = await JSZip.loadAsync(response.body)
    const fileNames = Object.keys(zip.files)
    assert.ok(fileNames.includes(basename(imageA)))
    assert.ok(fileNames.includes(basename(imageB)))

    const aContent = await zip.file(basename(imageA)).async('string')
    const bContent = await zip.file(basename(imageB)).async('string')
    assert.equal(aContent, 'aaa')
    assert.equal(bContent, 'bbb')
  } finally {
    await app.close()
  }
})

test('POST /api/download handles read failure for one file and remains operational', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imageserver-test-'))
  const imageA = join(root, 'a.png')
  const imageB = join(root, 'b.png')
  await writeFile(imageA, Buffer.from('aaa'))
  await writeFile(imageB, Buffer.from('bbb'))

  const readFileImpl = async (filePath) => {
    if (filePath === imageB) {
      throw makeError('ENODATA', 'no data available')
    }

    const fsPromises = await import('node:fs/promises')
    return fsPromises.readFile(filePath)
  }

  const app = await startServer({ documentsPath: root, readFileImpl })

  try {
    const response = await call(app.origin, '/api/download', {
      method: 'POST',
      body: JSON.stringify({
        paths: [imageA, imageB],
      }),
    })

    assert.equal(response.statusCode, 500)
    assert.match(response.body.toString('utf8'), /Falha ao gerar arquivo ZIP/)

    const failedReadLog = app.logs.find((entry) => entry.event === 'zip_file_read_failed')
    assert.ok(failedReadLog)
    assert.equal(failedReadLog.error.code, 'ENODATA')

    const health = await call(app.origin, '/api/health')
    assert.equal(health.statusCode, 200)
  } finally {
    await app.close()
  }
})

test('GET /api/image streams supported WEBP MIME type', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imageserver-test-'))
  const imagePath = join(root, 'ok.webp')
  await writeFile(imagePath, Buffer.from([0x52, 0x49, 0x46, 0x46]))

  const app = await startServer({ documentsPath: root })

  try {
    const result = await call(
      app.origin,
      `/api/image?path=${encodeURIComponent(imagePath)}`,
    )

    assert.equal(result.statusCode, 200)
    assert.equal(result.headers['content-type'], 'image/webp')
  } finally {
    await app.close()
  }
})

test('POST /api/download returns 404 when one file does not exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imageserver-test-'))
  const imageA = join(root, 'a.png')
  const imageMissing = join(root, 'missing.png')
  await writeFile(imageA, Buffer.from('aaa'))

  const app = await startServer({ documentsPath: root })

  try {
    const response = await call(app.origin, '/api/download', {
      method: 'POST',
      body: JSON.stringify({
        paths: [imageA, imageMissing],
      }),
    })

    assert.equal(response.statusCode, 404)
    assert.match(response.body.toString('utf8'), /não foram encontradas|Falha ao gerar arquivo ZIP/)

    const health = await call(app.origin, '/api/health')
    assert.equal(health.statusCode, 200)
  } finally {
    await app.close()
  }
})

test('server does not create host files while running tests', async () => {
  assert.equal(existsSync('C:/Users/10/Documents/should-not-exist'), false)
})
