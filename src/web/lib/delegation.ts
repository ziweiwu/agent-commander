/**
 * What a fleet card may say about an agent's delegates.
 *
 * The tree itself is read by the server (INV-13); this turns it into the one
 * or two lines a card has room for, without losing the distinctions that made
 * the tree worth reading. Pure, so the rules below are testable without a DOM.
 */
import type { Agent, AgentTree, SubagentNode } from '../../shared/types.ts'

/**
 * The four different things this app can know, and they are four rather than
 * three because two of them look identical on screen if nobody separates them.
 *
 * `none` is a fact: the sidecars were read and there were none. `unknown` is
 * the admission that this CLI writes no sidecars, so nothing was read and
 * "delegated nothing" is a claim nobody is in a position to make. Rendering
 * both as an absent line — which is what a bare count does when it is zero —
 * turns the admission into the fact.
 *
 * `unread` is neither: the graph has not arrived from the server yet. It says
 * nothing at all rather than briefly saying "none" on every card at load.
 */
export type DelegationClaim =
  | { kind: 'unread' }
  | { kind: 'unknown' }
  | { kind: 'none' }
  | {
      kind: 'some'
      total: number
      /** Delegates called active — every one of them a guess (INV-13). */
      active: number
      /** Stopped writing. Not done: nothing recorded an ending. */
      quiet: number
      /** Claimed only on evidence: a recorded result, or the user stopped it. */
      done: number
      /** How many of those `active` counts are this app's own guess. */
      guesses: number
      /** Delegates whose parent was not on disk, raised rather than dropped. */
      orphans: number
      deepest: number
    }

/** Every node in the tree, parents before children. */
export function flatten(nodes: readonly SubagentNode[]): SubagentNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)])
}

/**
 * Whether a delegate's state is this app's own inference.
 *
 * `done` can never be a guess however the field is set, and that is a rule
 * rather than an observation about today's server: `done` is the one state a
 * reader acts on — it is what makes them stop checking — so it is the one
 * state that must never be reachable from a timestamp. `quiet` is not a guess
 * either; it is the honest answer for a delegate that stopped writing, and
 * marking it as one would imply a better answer exists.
 */
export function isGuess(node: SubagentNode): boolean {
  return node.state === 'active' && node.stateInferred === true
}

export function claimOf(tree: AgentTree | undefined): DelegationClaim {
  if (!tree) return { kind: 'unread' }
  if (tree.unknown === true) return { kind: 'unknown' }
  if (tree.children.length === 0) return { kind: 'none' }

  const nodes = flatten(tree.children)
  return {
    kind: 'some',
    total: nodes.length,
    active: nodes.filter((node) => node.state === 'active').length,
    guesses: nodes.filter(isGuess).length,
    quiet: nodes.filter((node) => node.state === 'quiet').length,
    done: nodes.filter((node) => node.state === 'done').length,
    orphans: nodes.filter((node) => node.reparented === true).length,
    deepest: nodes.reduce((deepest, node) => Math.max(deepest, node.depth), 0),
  }
}

/**
 * An agent worth asking about, phrased as a question and never as a verdict.
 *
 * A parent that handed work off stops writing, so its own clock says nothing —
 * that is why `delegating` exists at all. The delegates are the thing still
 * moving, and when none of them is moving either, the whole family is silent
 * and nobody has checked. That is the shape a status board hides: the card
 * reads a confident "busy · delegated" for as long as you leave it.
 *
 * It is still only a question. Every delegate here is `quiet`, and quiet is
 * precisely the state that does not distinguish finished from dead (INV-13),
 * so the strongest true sentence is "nothing here has moved — is it still
 * working?". One delegate called active — inferred or not — is enough movement
 * to keep the family off this list.
 */
export function isStallCandidate(agent: Agent, claim: DelegationClaim): boolean {
  return agent.delegating === true && claim.kind === 'some' && claim.active === 0
}

/** The claim for one session out of the whole fleet's graph. */
export function claimFor(sessionId: string, trees: readonly AgentTree[]): DelegationClaim {
  return claimOf(trees.find((tree) => tree.sessionId === sessionId))
}
