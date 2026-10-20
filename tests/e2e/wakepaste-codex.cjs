// The suite for #600's check on the real Codex (the signed-in test home): wakepaste-cli/run.cjs says what it does.
require('./wakepaste-cli/run.cjs')('codex').catch((e) => {
  console.error(e)
  process.exit(1)
})
