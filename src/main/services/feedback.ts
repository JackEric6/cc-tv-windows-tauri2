import { networkFetch } from './http'

const FEEDBACK_ENDPOINT = 'https://api.web3forms.com/submit'
const FEEDBACK_ACCESS_KEY = '0184e5ef-d565-41c8-a4ce-9909208a02ee'
const MAX_FEEDBACK_LENGTH = 5000

export async function submitFeedback(content: string, version: string): Promise<void> {
  const message = typeof content === 'string' ? content.trim() : ''
  if (!message || message.length > MAX_FEEDBACK_LENGTH) {
    throw new Error('反馈内容不能为空，且不能超过 5000 字')
  }

  const response = await networkFetch(FEEDBACK_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      access_key: FEEDBACK_ACCESS_KEY,
      subject: `丛丛影视 Windows 反馈 v${String(version).slice(0, 32)}`,
      from_name: '丛丛影视 Windows 用户',
      message,
      version: String(version).slice(0, 32),
      platform: 'Windows',
      botcheck: ''
    }),
    signal: AbortSignal.timeout(20_000)
  })

  const result = await response.json().catch(() => null) as { success?: boolean; message?: string; error?: string } | null
  if (!response.ok || result?.success !== true) {
    throw new Error(result?.message || result?.error || `反馈提交失败：HTTP ${response.status}`)
  }
}
