import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH's shared home directory; Dorothy's own home is the `dot` child of it. */
export function dshHomeDir(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}
