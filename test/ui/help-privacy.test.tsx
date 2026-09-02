import { describe, it, expect, beforeEach, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Help } from '../../src/web/components/Help.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { renderApp, resetStore } from './helpers.tsx'

/*
 * The help page is the one screen that names the machine it runs on, and a
 * tailnet name is usually a person's name plus their household's or company's.
 * The threat is not the viewer — they may reveal it whenever they like — it is
 * every place this screen gets copied to: a screenshot in an issue, a
 * screen-share, a demo on a projector.
 */
const TAILSCALE = {
  cliPath: '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  dnsName: 'someones-laptop.tail1a2b3c.ts.net',
  ip: '100.110.12.63',
  running: true,
}

const withTailscale = () =>
  useStore.setState({
    env: { tailscale: TAILSCALE, tmux: true, port: 4317, platform: 'darwin', version: '0.8.1' },
  })

describe('the help page and the machine it names', () => {
  beforeEach(() => {
    resetStore()
    vi.restoreAllMocks()
  })

  it('does not show the tailnet name until it is asked to', () => {
    withTailscale()
    renderApp(<Help onClose={() => {}} />)

    expect(screen.getByTestId('tailscale-host').textContent).not.toMatch(/someones-laptop/)
    expect(screen.getByTestId('tailscale-host').textContent).not.toMatch(/tail1a2b3c/)
    // Still legible as an address rather than a row of dots.
    expect(screen.getByTestId('tailscale-host').textContent).toMatch(/\.ts\.net$/)
  })

  /* The whole page, not just the one element: the address is repeated in the
     phone-setup step and the tailnet IP in the fallback command, and a mask
     that covers one of the three is not a mask. */
  it('keeps it out of every command on the page', () => {
    withTailscale()
    const { container } = renderApp(<Help onClose={() => {}} />)

    expect(container.textContent).not.toMatch(/someones-laptop/)
    expect(container.textContent).not.toMatch(/tail1a2b3c/)
    expect(container.textContent).not.toMatch(/110\.12\.63/)
  })

  it('reveals it on request, and hides it again', async () => {
    const user = userEvent.setup()
    withTailscale()
    const { container } = renderApp(<Help onClose={() => {}} />)

    await user.click(screen.getByTestId('tailscale-reveal'))
    expect(container.textContent).toMatch(/someones-laptop\.tail1a2b3c\.ts\.net/)
    expect(container.textContent).toMatch(/100\.110\.12\.63/)

    await user.click(screen.getByTestId('tailscale-reveal'))
    expect(container.textContent).not.toMatch(/someones-laptop/)
  })

  /*
   * The point of masking rather than removing: the address still has to reach
   * the phone. Copy hands over the real one while the screen shows the mask —
   * a password manager's copy button, for the same reason.
   */
  it('copies the real address while the screen shows the mask', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    /*
     * Two things fight over this property. `navigator.clipboard` is an accessor
     * with no setter, so assigning to it throws rather than stubbing it — and
     * `userEvent.setup()` installs a clipboard stub of its own, so this has to
     * land after that call or it is the one that gets overwritten.
     */
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    withTailscale()
    renderApp(<Help onClose={() => {}} />)

    const copyPhoneUrl = screen
      .getAllByRole('button', { name: /^copy:/ })
      .find((b) => (b.getAttribute('aria-label') ?? '').includes('https://'))
    expect(copyPhoneUrl).toBeTruthy()

    await user.click(copyPhoneUrl as HTMLElement)
    expect(writeText).toHaveBeenCalledWith('https://someones-laptop.tail1a2b3c.ts.net/')
  })

  /* A screen reader announcing what the screen is hiding would undo the
     masking for the one user who cannot see that it happened. */
  it('does not leak it through an accessible name', () => {
    withTailscale()
    renderApp(<Help onClose={() => {}} />)

    for (const button of screen.getAllByRole('button')) {
      expect(button.getAttribute('aria-label') ?? '').not.toMatch(/someones-laptop/)
    }
  })

  /* Masking the placeholder would only obscure the example for the people who
     have not set Tailscale up yet — there is nobody's name in it to protect. */
  it('leaves the worked example alone when there is no Tailscale', () => {
    useStore.setState({
      env: { tailscale: null, tmux: true, port: 4317, platform: 'darwin', version: '0.8.1' },
    })
    const { container } = renderApp(<Help onClose={() => {}} />)

    expect(container.textContent).toMatch(/your-mac\.tailnet-name\.ts\.net/)
    expect(screen.queryByTestId('tailscale-reveal')).toBeNull()
  })

  /*
   * Not remembered across opens. A preference that survives is one you set once
   * and then forget you set; the value here is that the safe state is the one
   * you get without thinking about it.
   */
  it('is masked again the next time the page opens', async () => {
    const user = userEvent.setup()
    withTailscale()
    const first = renderApp(<Help onClose={() => {}} />)
    await user.click(screen.getByTestId('tailscale-reveal'))
    expect(first.container.textContent).toMatch(/someones-laptop/)
    first.unmount()

    const second = renderApp(<Help onClose={() => {}} />)
    expect(second.container.textContent).not.toMatch(/someones-laptop/)
  })
})
