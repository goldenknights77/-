export function maskApiKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '••••••••'
  return `${key.slice(0, 6)}${'•'.repeat(Math.max(4, key.length - 10))}${key.slice(-4)}`
}
