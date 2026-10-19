export async function submitFeedback(content: string, version: string): Promise<void> {
  await window.api.feedback.submit(content, version)
}
