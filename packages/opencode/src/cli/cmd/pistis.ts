/**
 * Thin OpenCode CLI registration for Pistis.
 *
 * The actual command tree lives in `@opencode-ai/pistis/cli`; this file only
 * imports it. Keeping the bridge thin matches the architectural decision that
 * all Pistis logic stays inside `packages/pistis` except for command
 * registration.
 */
import { PistisCommand as PistisRoot } from "@opencode-ai/pistis/cli"

export const PistisCommand = PistisRoot
