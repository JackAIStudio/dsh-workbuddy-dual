import { execFileSync } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { WORKBUDDY_DUAL_VERSION } from './version.ts'

export const WORKBUDDY_DUAL_HEARTBEAT_FILENAME = '.workbuddy-dual-heartbeat.json'
const HEARTBEAT_FORMAT_VERSION = 1

export interface WorkBuddyDualHostHeartbeat {
  version: typeof HEARTBEAT_FORMAT_VERSION
  package: 'dsh-workbuddy-dual'
  pluginVersion: string
  registeredAt: number
  pid: number
}

export function workbuddyHostHeartbeatPath(): string {
  return join(resolveDshHome(), WORKBUDDY_DUAL_HEARTBEAT_FILENAME)
}

export async function writeHostHeartbeat(): Promise<void> {
  const doc: WorkBuddyDualHostHeartbeat = {
    version: HEARTBEAT_FORMAT_VERSION,
    package: 'dsh-workbuddy-dual',
    pluginVersion: WORKBUDDY_DUAL_VERSION,
    registeredAt: Date.now(),
    pid: process.pid,
  }
  try {
    await writeFile(workbuddyHostHeartbeatPath(), JSON.stringify(doc), 'utf8')
  } catch {}
}

export async function clearHostHeartbeat(): Promise<void> {
  try {
    await rm(workbuddyHostHeartbeatPath(), { force: true })
  } catch {}
}

export async function readHostHeartbeat(): Promise<WorkBuddyDualHostHeartbeat | undefined> {
  try {
    const raw = await readFile(workbuddyHostHeartbeatPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<WorkBuddyDualHostHeartbeat>
    if (
      parsed.version === HEARTBEAT_FORMAT_VERSION &&
      parsed.package === 'dsh-workbuddy-dual' &&
      typeof parsed.registeredAt === 'number' &&
      typeof parsed.pid === 'number'
    ) {
      return {
        version: HEARTBEAT_FORMAT_VERSION,
        package: 'dsh-workbuddy-dual',
        pluginVersion: typeof parsed.pluginVersion === 'string' ? parsed.pluginVersion : 'unknown',
        registeredAt: parsed.registeredAt,
        pid: parsed.pid,
      }
    }
  } catch {}
  return undefined
}

export function processStartTimeMs(pid: number): number | undefined {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'wmic',
        ['process', 'where', `processid=${pid}`, 'get', 'CreationDate'],
        { encoding: 'utf8', windowsHide: true },
      )
      const m = out.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+([+-]\d{4})/)
      if (m === null) return undefined
      const [, y, mo, d, h, mi, s] = m
      const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
      return Number.isFinite(ms) ? ms : undefined
    }
    const out = execFileSync(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
    ).trim()
    if (out === '') return undefined
    const ms = Date.parse(out)
    return Number.isFinite(ms) ? ms : undefined
  } catch {
    return undefined
  }
}

export function isHeartbeatProcessAlive(heartbeat: WorkBuddyDualHostHeartbeat): boolean {
  try {
    process.kill(heartbeat.pid, 0)
  } catch {
    return false
  }
  const startAtMs = processStartTimeMs(heartbeat.pid)
  if (startAtMs === undefined) return true
  return startAtMs <= heartbeat.registeredAt
}
