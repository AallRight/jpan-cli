import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCredentialInput } from '../src/config.js'
import { encodeRemote, normalizeRemote } from '../src/paths.js'
import { splitCommand } from '../src/shell.js'

test('parses a raw token', () => {
  assert.deepEqual(parseCredentialInput('abc123'), { userToken: 'abc123', keepAlive: '', userId: '' })
})

test('parses a full cookie string case-insensitively', () => {
  assert.deepEqual(
    parseCredentialInput('foo=x; USER_TOKEN=secret=with=equals; keep_alive=alive; user_id=42'),
    { userToken: 'secret=with=equals', keepAlive: 'alive', userId: '42' },
  )
})

test('accepts a copied Cookie header', () => {
  assert.equal(parseCredentialInput('Cookie: USER_TOKEN=secret; other=value').userToken, 'secret')
})

test('normalizes and encodes remote paths by segment', () => {
  assert.equal(normalizeRemote('../资料/a b.txt', '/课程/第一章'), '/课程/资料/a b.txt')
  assert.equal(encodeRemote('/课程/资料/a b.txt'), '%E8%AF%BE%E7%A8%8B/%E8%B5%84%E6%96%99/a%20b.txt')
})

test('shell accepts quoted paths', () => {
  assert.deepEqual(splitCommand('upload "my file.txt" \'/远端 目录/\' --jobs 2'), [
    'upload', 'my file.txt', '/远端 目录/', '--jobs', '2',
  ])
})
