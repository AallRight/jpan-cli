import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { JPanClient } from '../src/client.js'

async function fixture(t) {
  const uploaded = []
  const fileData = Buffer.from('hello from jpan')
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/user/v1/space/1/personal') {
      assert.equal(req.headers.cookie, 'USER_TOKEN=test-token; keep_alive=keep')
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ accessToken: 'access', expiresIn: 1800, libraryId: 'lib', spaceId: 'space' }))
    }
    if (url.pathname === '/api/v1/directory/lib/space/') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ totalNum: 2, contents: [
        { name: 'docs', type: 'directory', size: '0' },
        { name: 'hello.txt', type: 'file', size: String(fileData.length) },
      ] }))
    }
    if (url.pathname === '/api/v1/file/lib/space/hello.txt' && req.method === 'GET') {
      res.statusCode = 302
      res.setHeader('location', `${baseURL}/cos/download`)
      return res.end()
    }
    if (url.pathname === '/cos/download') {
      const range = req.headers.range
      if (range) {
        const offset = Number(range.match(/bytes=(\d+)-/)?.[1] || 0)
        res.statusCode = 206
        res.setHeader('content-length', fileData.length - offset)
        return res.end(fileData.subarray(offset))
      }
      res.setHeader('content-length', fileData.length)
      return res.end(fileData)
    }
    if (url.pathname === '/api/v1/file/lib/space/new.txt' && req.method === 'PUT') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ domain: baseURL, path: '/cos/upload', headers: { 'x-test': 'yes' }, confirmKey: 'confirm-1' }))
    }
    if (url.pathname === '/cos/upload' && req.method === 'PUT') {
      for await (const chunk of req) uploaded.push(chunk)
      res.statusCode = 200
      return res.end()
    }
    if (url.pathname === '/api/v1/file/lib/space/confirm-1' && req.method === 'POST' && url.searchParams.has('confirm')) {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ name: 'new.txt', type: 'file', size: '7', path: ['new.txt'] }))
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/api/v1/directory/lib/space/')) {
      res.statusCode = 201
      return res.end('{}')
    }
    res.statusCode = 404
    res.end('not found')
  })
  let baseURL
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  baseURL = `http://127.0.0.1:${address.port}`
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return {
    baseURL,
    uploaded,
    fileData,
    client: new JPanClient({ userToken: 'test-token', keepAlive: 'keep', userId: '', cwd: '/' }, { baseURL }),
  }
}

test('refreshes credential and lists files', async (t) => {
  const { client } = await fixture(t)
  const entries = await client.list('/')
  assert.equal(entries.length, 2)
  assert.deepEqual(entries.map((entry) => [entry.name, entry.type]), [['docs', 'directory'], ['hello.txt', 'file']])
})

test('downloads and resumes a partial file', async (t) => {
  const { client, fileData } = await fixture(t)
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jpan-test-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const destination = path.join(temp, 'hello.txt')
  await fs.writeFile(`${destination}.part`, fileData.subarray(0, 5))
  const result = await client.downloadFile('/hello.txt', destination)
  assert.equal(result.status, 'downloaded')
  assert.deepEqual(await fs.readFile(destination), fileData)
})

test('performs three-stage streaming upload', async (t) => {
  const { client, uploaded } = await fixture(t)
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jpan-test-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const source = path.join(temp, 'new.txt')
  await fs.writeFile(source, 'new data')
  const result = await client.uploadFile(source, '/new.txt', { conflict: 'overwrite' })
  assert.equal(result.status, 'uploaded')
  assert.equal(Buffer.concat(uploaded).toString(), 'new data')
})
