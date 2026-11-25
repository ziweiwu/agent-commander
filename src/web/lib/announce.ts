const FRAMES_TO_WAIT_FOR_THE_REGION = 60

function region(): HTMLElement | null {
  return document.getElementById('live-region')
}

export function announce(text: string): void {
  const first = region()
  if (first) first.textContent = ''
  let framesLeft = FRAMES_TO_WAIT_FOR_THE_REGION
  const write = (): void => {
    const target = region()
    if (target) {
      target.textContent = text
      return
    }
    framesLeft -= 1
    if (framesLeft > 0) window.requestAnimationFrame(write)
  }
  window.requestAnimationFrame(write)
}

export function clearAnnouncement(): void {
  const target = region()
  if (target) target.textContent = ''
}
