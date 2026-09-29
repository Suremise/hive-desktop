// Kept separate from monaco.ts so callers can pick a language without loading Monaco.
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonl: 'json', md: 'markdown', markdown: 'markdown', py: 'python', rs: 'rust', go: 'go', java: 'java',
  cs: 'csharp', cpp: 'cpp', cc: 'cpp', c: 'c', h: 'cpp', hpp: 'cpp', css: 'css', scss: 'scss', less: 'less', html: 'html',
  htm: 'html', xml: 'xml', svg: 'xml', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', sh: 'shell', bash: 'shell',
  ps1: 'powershell', psm1: 'powershell', bat: 'bat', cmd: 'bat', sql: 'sql', php: 'php', rb: 'ruby', kt: 'kotlin',
  swift: 'swift', dart: 'dart', lua: 'lua', r: 'r', dockerfile: 'dockerfile', vue: 'html', svelte: 'html'
}

export function languageFor(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (name === 'dockerfile') return 'dockerfile'
  const ext = name.includes('.') ? name.split('.').pop()! : ''
  return EXT_LANG[ext] ?? 'plaintext'
}
