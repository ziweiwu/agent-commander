/**
 * The actions INV-17 requires on every shape of the agent screen.
 *
 * `test/ui/inv17-parity.test.tsx` and `e2e/responsive.spec.ts` used to keep
 * two hand-written copies of this list, on the stated (and correct) grounds
 * that a list *discovered* from a rendered tree would agree with itself: if a
 * control stopped rendering everywhere, both the desktop reading and the
 * phone reading would come back equally empty, and a "compare the shapes"
 * test would find nothing to disagree about. That reasoning is why this
 * module exports a **declared** constant rather than something harvested
 * from a render — the two tests read the same array, but neither test (nor
 * this file) ever derives it from what is on screen.
 *
 * The other direction is safe precisely because it is not a render:
 * `test/surfaces.test.ts` walks the component source for a `data-testid` on
 * an interactive element and checks it names every id below, which catches a
 * declared id that no longer matches anything in the app without ever
 * needing to ask what a render looks like.
 */
export const AGENT_SCREEN_ACTIONS = [
  'tab-chat',
  'tab-attach',
  'fullscreen-toggle',
  // The agent's own settings and the two context actions.
  'model-select',
  'clear-agent',
  'compact-agent',
  // Folds at every width now (INV-8), so it is asserted everywhere too.
  'close-agent',
  // The composer, and everything in the strip above it.
  'composer-input',
  'composer-send',
  // The one thing the composer sends that cannot be typed, and the shape this
  // exists for is the phone: the picture is already in the hand holding it.
  'attach-picture',
  'send-mode-queue',
  'send-mode-interrupt',
  'goal-toggle',
  'strip-toggle',
  'shift-tab',
] as const
