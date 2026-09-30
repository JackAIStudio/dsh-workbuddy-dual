import { execFileSync } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WorkBuddyRegion } from './types.ts'

export interface WbEncryptedField {
  $wbEncrypted: 1
  envelope: string
}

export interface WbEnvelope {
  suite: number
  keyId: string
  nonce: string
  authTag: string
  ciphertext: string
}

const keyCache = new Map<string, Buffer>()

export function setMasterKeyForTesting(keyId: string, key: Buffer): void {
  keyCache.set(keyId, key)
}

export function isWbEncryptedField(value: unknown): value is WbEncryptedField {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['$wbEncrypted'] === 1 &&
    typeof (value as Record<string, unknown>)['envelope'] === 'string'
  )
}

export function findWorkBuddyExecutable(region: WorkBuddyRegion): string | undefined {
  const envKey = region === 'cn' ? 'WORKBUDDY_CN_EXE' : 'WORKBUDDY_GLOBAL_EXE'
  const custom = process.env[envKey] ?? process.env['WORKBUDDY_EXE']
  if (custom && existsSync(custom)) return custom

  const home = homedir()
  if (process.platform === 'darwin') {
    const candidates =
      region === 'cn'
        ? [
            '/Applications/WorkBuddy.app/Contents/MacOS/Electron',
            join(home, 'Applications/WorkBuddy.app/Contents/MacOS/Electron'),
          ]
        : [
            '/Applications/WorkBuddy AI.app/Contents/MacOS/Electron',
            join(home, 'Applications/WorkBuddy AI.app/Contents/MacOS/Electron'),
          ]
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
  } else if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
    const candidates =
      region === 'cn'
        ? [join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe')]
        : [join(local, 'Programs', 'WorkBuddy AI', 'WorkBuddy AI.exe')]
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
  } else if (process.platform === 'linux') {
    const candidates =
      region === 'cn'
        ? ['/opt/WorkBuddy/workbuddy', '/usr/bin/workbuddy']
        : ['/opt/WorkBuddy AI/workbuddy', '/usr/bin/workbuddy-ai']
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
  }
  return undefined
}

export function getOrDeriveMasterKey(keyId: string, region: WorkBuddyRegion): Buffer | undefined {
  const cached = keyCache.get(keyId)
  if (cached) return cached

  const exe = findWorkBuddyExecutable(region)
  if (!exe) return undefined

  try {
    const code =
      'try{const s=process._linkedBinding("electron_browser_workbuddy_storage");process.stdout.write(s.loggerGet())}catch(e){process.exit(1)}process.exit(0);'
    const out = execFileSync(exe, ['-e', code], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const payload = JSON.parse(out) as { version?: number; atRestSecretKey?: string }
    if (!payload || payload.version !== 1 || typeof payload.atRestSecretKey !== 'string') {
      return undefined
    }

    const rawKey = createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest()
    const derivedKeyId = createHash('sha256').update(rawKey).digest('hex').slice(0, 16)
    keyCache.set(derivedKeyId, rawKey)

    if (derivedKeyId === keyId) {
      return rawKey
    }
  } catch {
    // runtime unavailable or error
  }
  return keyCache.get(keyId)
}

function lengthPrefix(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length)
  return Buffer.concat([length, bytes])
}

export function decryptWbString(field: unknown, region: WorkBuddyRegion): string | undefined {
  if (typeof field === 'string' && field.trim() !== '') return field.trim()
  if (!isWbEncryptedField(field)) return undefined

  try {
    const envJson = Buffer.from(field.envelope, 'base64').toString('utf8')
    const envelope = JSON.parse(envJson) as WbEnvelope
    if (!envelope || envelope.suite !== 1 || !envelope.keyId) return undefined

    const key = getOrDeriveMasterKey(envelope.keyId, region)
    if (!key) return undefined

    const aad = Buffer.concat([
      Buffer.from('WB-AAD\0', 'ascii'),
      Buffer.from([1]),
      lengthPrefix('WBEV1'),
      lengthPrefix('sym-v1'),
      Buffer.from([0, 0, 0, 1]),
      lengthPrefix(envelope.keyId),
      Buffer.from([2, 0, 0]),
    ])

    const nonce = Buffer.from(envelope.nonce, 'base64')
    const tag = Buffer.from(envelope.authTag, 'base64')
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64')

    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
    decipher.setAAD(aad)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    return plaintext.trim() !== '' ? plaintext.trim() : undefined
  } catch {
    return undefined
  }
}
