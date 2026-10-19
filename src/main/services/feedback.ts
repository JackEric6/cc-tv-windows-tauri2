import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from '../../tauri/platform'

const MAX_FEEDBACK_LENGTH = 5000
const FEEDBACK_FILE = 'feedback.jsonl'

export async function submitFeedback(content: string, version: string): Promise<void> {
  const message = typeof content === 'string' ? content.trim() : ''
  if (!message || message.length > MAX_FEEDBACK_LENGTH) {
    throw new Error('反馈内容不能为空，且不能超过 5000 字')
  }

  const directory = app.getPath('userData')
  await mkdir(directory, { recursive: true })
  await appendFile(join(directory, FEEDBACK_FILE), `${JSON.stringify({
    submittedAt: new Date().toISOString(),
    version: String(version).slice(0, 32),
    platform: 'Windows',
    message
  })}\n`, 'utf-8')
}
