// What a Windows exit code means, for the agent running the tests (#599): a process that fails to start, or crashes,
// ends with an NTSTATUS code (0xc0000142…), which Node reports as a bare 3221225794. The runners say it with a line of
// meaning, so the agent can react (rerun with fewer runs at once) instead of guessing at a number.
//
// That it ends at once, rather than waiting behind Windows' "Application Error" dialog until someone clicks OK, is the
// error mode's doing: a process started with SEM_FAILCRITICALERRORS (SetErrorMode) gets no such dialog, and a child
// inherits its parent's mode when it is started directly (CreateProcess). Node sets it for itself as it starts (libuv:
// SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX) and Electron keeps SEM_FAILCRITICALERRORS,
// so everything the runners, the suites, the unit test workers and the test copies of Hive start with child_process
// (or node-pty) has it, however deep. What doesn't: a process started through the shell (ShellExecute: PowerShell's
// Start-Process, `start`, opening a file by its association), which starts with the default mode. So test tooling never
// starts anything that way (tests/windowsExits.test.ts checks), and nothing machine-wide is changed.

/** The codes worth a sentence: what happened, and what to do when it isn't the code's fault. */
const STATUS = {
  0xc0000142: "a DLL failed to initialise as it started, usually Windows' desktop heap running short with many processes at once: rerun with fewer runs at once",
  0xc0000135: "a DLL it needs wasn't found",
  0xc0000139: 'a DLL it loads lacks a function it needs (a mismatched DLL)',
  0xc000007b: 'its executable or a DLL is damaged or for another architecture',
  0xc0000428: 'Windows blocked its executable or a DLL (code integrity)',
  0xc0000022: 'access was denied as it started',
  0xc0000017: 'out of memory',
  0xc000012d: "the machine's memory (its page file) is full: rerun with fewer runs at once",
  0xc0000005: 'it crashed (access violation)',
  0xc00000fd: 'it crashed (stack overflow)',
  0xc0000374: 'it crashed (heap corruption)',
  0xc0000409: 'it stopped itself at once (a fail-fast abort or security check)',
  0xc000013a: 'it was interrupted (Ctrl+C, or its console closed)'
}

/** The NTSTATUS error code an exit code is (unsigned, as 0xc0000142 is), or null for an ordinary exit code. */
function ntstatus(code) {
  if (typeof code !== 'number' || !Number.isInteger(code)) return null
  const u = code >>> 0
  return u >= 0xc0000000 && (code < 0 || code === u) ? u : null
}

const hex = (u) => `0x${u.toString(16).padStart(8, '0')}`

/** "0xc0000142: a DLL failed to initialise…" for an NTSTATUS exit code (any: an unknown one says what kind it is), else null. */
function describeExit(code) {
  const u = ntstatus(code)
  if (u === null) return null
  return `${hex(u)}: ${STATUS[u] ?? 'the process ended abnormally (a Windows status code)'}`
}

/** An exit code as the runners print it: described when it is a Windows status code, else the number. */
const exitText = (code) => describeExit(code) ?? String(code)

/**
 * The known Windows codes a suite's output mentions (a child's "exit code 3221225794", Playwright's "exitCode=3221225794",
 * a "0xC0000142"), each described once, in the order first seen. Only the codes in STATUS: a number that merely looks
 * like one is no reason to say anything.
 */
function windowsCodesIn(text) {
  const seen = new Map()
  for (const m of String(text ?? '').matchAll(/\b0x([0-9a-f]{8})\b|(?<![\w.])(-?\d{10})(?![\w.])/gi)) {
    const u = m[1] ? parseInt(m[1], 16) : ntstatus(Number(m[2]))
    if (u !== null && STATUS[u] && !seen.has(u)) seen.set(u, describeExit(u))
  }
  return [...seen.values()]
}

module.exports = { STATUS, ntstatus, describeExit, exitText, windowsCodesIn }
