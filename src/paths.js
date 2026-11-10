/**
 * Where delta-dsh keeps its own files.
 *
 * Claude Code gives Delta a configuration folder (`CLAUDE_CONFIG_DIR` or
 * `~/.claude`) and Delta keeps its outbox, bindings and read position beneath
 * it. The port keeps the same layout under the Harness home, so Delta's
 * unchanged activation and outbox code writes to a folder the port owns:
 *
 * - `$DSH_HOME/delta-dsh/claude/delta-plugin/outbox`  staged records
 * - `$DSH_HOME/delta-dsh/claude/projects/<cwd>/<id>.jsonl` synthetic transcript
 * - `$DSH_HOME/delta-dsh/store/`  the plugin store
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The Harness home this profile uses (`DSH_HOME`, else `~/.dsh`). */
export function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
}

/** The plugin's own data folder. */
export function dataDir() {
  return join(dshHome(), 'delta-dsh')
}

/** The configuration folder Delta believes it runs under. */
export function configDir() {
  return join(dataDir(), 'claude')
}

/** Claude's folder name for a working directory: every character but a letter or digit is `-`. */
export function projectFolder(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** The synthetic transcript file the title reader and continuation checks look for. */
export function transcriptPath(cwd, session) {
  return join(configDir(), 'projects', projectFolder(cwd), `${session}.jsonl`)
}
