import { networkFetch } from './http'

const FEEDBACK_ENDPOINT = 'https://api.web3forms.com/submit'
const FEEDBACK_ACCESS_KEY = '0184e5ef-d565-41c8-a4ce-9909208a02ee'
const FEEDBACK_CONTACT_EMAIL = 'andybrain688@gmail.com'
const MAX_FEEDBACK_LENGTH = 5000

export async function submitFeedback(content: string, version: string): Promise<void> {
  const message = typeof content === 'string' ? content.trim() : ''
  if (!message || message.length > MAX_FEEDBACK_LENGTH) {
    throw new Error('反馈内容不能为空，且不能超过 5000 字')
  }

  const form = new FormData()
  form.set('access_key', FEEDBACK_ACCESS_KEY)
  form.set('subject', `丛丛影视 Windows 反馈 v${String(version).slice(0, 32)}`)
  form.set('from_name', '丛丛影视 Windows 用户')
  form.set('email', FEEDBACK_CONTACT_EMAIL)
  form.set('message', message)
  form.set('version', String(version).slice(0, 32))
  form.set('platform', 'Windows')
  form.set('botcheck', '')

  const response = await networkFetch(FEEDBACK_ENDPOINT, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: form,
    signal: AbortSignal.timeout(20_000)
  })

  const result = await response.json().catch(() => null) as { success?: boolean; message?: string; error?: string } | null
  if (!response.ok || result?.success !== true) {
    const detail = result?.message || result?.error
    throw new Error(detail ? `${detail} (HTTP ${response.status})` : `HTTP ${response.status}`)
  }
}
