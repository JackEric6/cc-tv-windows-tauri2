const FEEDBACK_ENDPOINT = 'https://api.web3forms.com/submit'
const FEEDBACK_ACCESS_KEY = '0184e5ef-d565-41c8-a4ce-9909208a02ee'
const FEEDBACK_CONTACT_EMAIL = 'andybrain688@gmail.com'
const MAX_FEEDBACK_LENGTH = 5000

export async function submitFeedback(content: string, version: string): Promise<void> {
  const message = content.trim()
  if (!message || message.length > MAX_FEEDBACK_LENGTH) {
    throw new Error('反馈内容不能为空，且不能超过 5000 字')
  }

  const form = new FormData()
  form.set('access_key', FEEDBACK_ACCESS_KEY)
  form.set('name', '丛丛影视 Windows 用户')
  form.set('email', FEEDBACK_CONTACT_EMAIL)
  form.set('message', message)
  form.set('subject', `丛丛影视 Windows 反馈 v${version.slice(0, 32)}`)
  form.set('version', version.slice(0, 32))
  form.set('platform', 'Windows')
  form.set('botcheck', '')

  const response = await fetch(FEEDBACK_ENDPOINT, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(20_000)
  })
  const body = await response.text()
  let result: { success?: boolean; message?: string; error?: string } | null = null
  try {
    result = JSON.parse(body) as { success?: boolean; message?: string; error?: string }
  } catch {
    if (response.status === 403 && /cloudflare|just a moment/i.test(body)) {
      throw new Error('Web3Forms 安全验证拦截了请求，请检查网络代理或稍后重试')
    }
  }
  if (!response.ok || result?.success !== true) {
    const detail = result?.message || result?.error || `HTTP ${response.status}`
    throw new Error(detail)
  }
}
