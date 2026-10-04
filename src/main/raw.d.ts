/** A file's text, bundled by Vite (`import doc from '…/AGENT_API.md?raw'`). */
declare module '*.md?raw' {
  const text: string
  export default text
}
