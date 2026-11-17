/**
 * Test-only fault adapter around the real DotHost composition root.
 * Production leaves it idle unless DSH_DOT_HOST_FAULT is set.
 * It does not add a dispose RPC and it does not rewrite work records.
 */
import { existsSync, readFileSync } from 'node:fs'
import type { DotHost } from './host.ts'

export interface HostFaultOptions {
  /** After the real relay call succeeds, hide one proof read and surface an uncertain ack. */
  readonly relayAckUnknown?: boolean
  /** Keep owned-job confirmation past the timeout jobs.wait was given, then let the real wait finish. */
  readonly holdJobConfirm?: boolean
  /** When this file contains "release", the job hold ends. Hannah flips it between the two stops. */
  readonly releaseFile?: string
}

export interface HostFaultControl {
  readonly relayCalls: number
  wrapService<T>(name: string, value: T): T
  wrapHost(host: DotHost): DotHost
  releaseJobHold(): void
}

interface FaultState {
  relayAckUnknown: boolean
  holdJobConfirm: boolean
  releaseFile?: string
  relayCalls: number
  hideProofs: number
}

export function hostFaultFromEnv(env: NodeJS.ProcessEnv = process.env): HostFaultControl {
  const names = (env.DSH_DOT_HOST_FAULT ?? '').split(',').map(item => item.trim()).filter(Boolean)
  return createHostFault({
    relayAckUnknown: names.includes('relay-ack'),
    holdJobConfirm: names.includes('job-hold'),
    ...(env.DSH_DOT_HOST_FAULT_RELEASE ? { releaseFile: env.DSH_DOT_HOST_FAULT_RELEASE } : {}),
  })
}

export function createHostFault(options: HostFaultOptions = {}): HostFaultControl {
  const state: FaultState = {
    relayAckUnknown: options.relayAckUnknown === true,
    holdJobConfirm: options.holdJobConfirm === true,
    ...(options.releaseFile ? { releaseFile: options.releaseFile } : {}),
    relayCalls: 0,
    hideProofs: 0,
  }
  return {
    get relayCalls() { return state.relayCalls },
    wrapService<T>(name: string, value: T): T {
      if (name !== 'jobs' || !state.holdJobConfirm || !value || typeof value !== 'object') return value
      return wrapJobs(value as JobsApi, state) as T
    },
    wrapHost(host) {
      if (!state.relayAckUnknown) return host
      return {
        ...host,
        async relay(targetId, senderId, text, deliveryId) {
          await host.relay(targetId, senderId, text, deliveryId)
          state.relayCalls += 1
          state.hideProofs += 1
          throw new Error('relay ack unknown')
        },
        async readEvents(sessionId) {
          if (state.hideProofs > 0) {
            state.hideProofs -= 1
            throw new Error('relay proof unreadable')
          }
          return host.readEvents(sessionId)
        },
      }
    },
    releaseJobHold() { state.holdJobConfirm = false },
  }
}

interface JobsApi {
  list?: (caller?: string) => readonly { id?: string; status?: string; owner?: string }[]
  kill?: (id: string, caller?: string, reason?: string) => 'requested' | 'already-finished'
  wait?: (id: string, timeoutMs: number, caller?: string) => Promise<{ id?: string; status?: string; owner?: string }>
}

function wrapJobs(jobs: JobsApi, state: FaultState): JobsApi {
  const wait = jobs.wait
  if (typeof wait !== 'function') return jobs
  // rc.3 methods live on the prototype and are not enumerable. Spreading the
  // registry keeps only `wait` and drops `list` / `kill`, so settlement stays
  // unknown after the hold ends. Forward every other call to the real registry.
  const held = async (id: string, timeoutMs: number, caller?: string) => {
    const started = Date.now()
    while (holding(state)) {
      if (Date.now() - started >= timeoutMs) throw new Error('jobs.wait confirmation exceeded the window')
      await delay(20)
    }
    const remaining = Math.max(1, timeoutMs - (Date.now() - started))
    return wait.call(jobs, id, remaining, caller)
  }
  return new Proxy(jobs, {
    get(target, prop, receiver) {
      if (prop === 'wait') return held
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => value.apply(target, args)
    },
  })
}

function holding(state: FaultState): boolean {
  if (!state.holdJobConfirm) return false
  if (!state.releaseFile || !existsSync(state.releaseFile)) return true
  try { return !readFileSync(state.releaseFile, 'utf8').includes('release') } catch { return true }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
