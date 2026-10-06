/** A file's text, bundled by Vite (`import doc from '…/AGENT_API.md?raw'`). */
declare module '*.md?raw' {
  const text: string
  export default text
}

/** Electron's own fs promises, without its .asar handling (electron.d.ts declares only `original-fs`). */
declare module 'original-fs/promises' {
  export * from 'fs/promises'
}
