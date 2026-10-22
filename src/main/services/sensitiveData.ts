import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'

const KEY = createHash('sha256').update('congcong-tv-windows-tauri2:release-config:v1').digest()
const PREFIX = 'ccenc:v1:'

export function encryptSensitiveText(plainText: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, iv)
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
}

export function decryptSensitiveText(value: string): string {
  if (!value.startsWith(PREFIX)) return value
  const payload = Buffer.from(value.slice(PREFIX.length), 'base64')
  if (payload.length < 29) throw new Error('加密配置格式无效')
  const decipher = createDecipheriv('aes-256-gcm', KEY, payload.subarray(0, 12))
  decipher.setAuthTag(payload.subarray(12, 28))
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8')
}

export function encryptSensitiveJson(value: unknown): string {
  return encryptSensitiveText(JSON.stringify(value, null, 2))
}

export function decryptSensitiveJson<T>(value: string): T {
  return JSON.parse(decryptSensitiveText(value)) as T
}

export function decryptSensitiveCompressedJson<T>(payload: string): T {
  const packed = Buffer.from(payload, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', KEY, packed.subarray(0, 12))
  decipher.setAuthTag(packed.subarray(12, 28))
  const compressed = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()])
  return JSON.parse(inflateRawSync(compressed).toString('utf8')) as T
}
