// The suite for #600's check on the real Copilot CLI (offline, against the stand-in model): wakepaste-cli/run.cjs says what it does.
require('./wakepaste-cli/run.cjs')('copilot').catch((e) => {
  console.error(e)
  process.exit(1)
})
