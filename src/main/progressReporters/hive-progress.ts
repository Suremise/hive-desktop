// The hive-progress command (a .cmd and a sh script in Hive's bin folder, on each session's PATH, start this with
// Hive's own executable as Node): see wrapper.ts.
import { runWrapped } from './wrapper'

// Ctrl+C reaches the command too: wait for it to end, so its exit code is returned and Hive hears how it ended.
process.on('SIGINT', () => undefined)
void runWrapped(process.argv.slice(2), { env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr }).then((code) => process.exit(code))
