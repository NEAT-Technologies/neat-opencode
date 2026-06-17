/**
 * The 8 read-only NEAT tools exposed to KimiReviewer's verification loop.
 *
 * These are OpenAI-style function definitions accepted as-is by Moonshot.
 * Names exactly match NeatReadOnlyClient method names; the descriptions
 * are written for Kimi's tool-selection step.
 */

export type ToolName =
  | "get_node"
  | "get_edges"
  | "get_blast_radius"
  | "get_dependencies"
  | "get_root_cause"
  | "get_divergences"
  | "list_incidents"
  | "get_policy_violations"

export const TOOL_NAMES: ReadonlySet<ToolName> = new Set<ToolName>([
  "get_node",
  "get_edges",
  "get_blast_radius",
  "get_dependencies",
  "get_root_cause",
  "get_divergences",
  "list_incidents",
  "get_policy_violations",
])

export interface MoonshotTool {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export const READ_ONLY_TOOLS: readonly MoonshotTool[] = Object.freeze([
  {
    type: "function" as const,
    function: {
      name: "get_node",
      description:
        "Look up a NEAT node by id. Use to confirm the patched service exists and to see its language, repo, and kind before deciding whether the patch makes sense in context.",
      parameters: {
        type: "object",
        properties: {
          nodeId: { type: "string", description: "NEAT node id, e.g. 'service:order-api'." },
        },
        required: ["nodeId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_edges",
      description:
        "Get inbound and outbound edges for a node. Use to identify which services call into the patched node (callers that might break) and which services it depends on.",
      parameters: {
        type: "object",
        properties: {
          nodeId: { type: "string" },
        },
        required: ["nodeId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_blast_radius",
      description:
        "Estimate the downstream impact of a node failing. Returns the set of nodes reachable within `depth` edges. Use to quantify how much breaks if the patch is wrong.",
      parameters: {
        type: "object",
        properties: {
          nodeId: { type: "string" },
          depth: { type: "integer", minimum: 1, maximum: 3, default: 2 },
        },
        required: ["nodeId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_dependencies",
      description:
        "List declared dependencies of a node and whether each was recently changed. Use to spot if the bug or fix touches a dep with recent churn.",
      parameters: {
        type: "object",
        properties: {
          nodeId: { type: "string" },
          depth: { type: "integer", minimum: 1, maximum: 3 },
        },
        required: ["nodeId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_root_cause",
      description:
        "Fetch NEAT's current root-cause candidate for a node. Use to re-verify that the root cause Flash captured is still the current candidate, since the graph evolves.",
      parameters: {
        type: "object",
        properties: {
          nodeId: { type: "string" },
          errorId: { type: "string" },
        },
        required: ["nodeId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_divergences",
      description:
        "List observed-vs-declared drift in the graph. Optionally filter to a single node. Use to catch implicit assumptions the patch makes about state that has drifted from declared truth.",
      parameters: {
        type: "object",
        properties: {
          nodeId: { type: "string" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_incidents",
      description:
        "List recent NEAT incidents. Use to check if the node is already in a bad state we should not pile more changes onto.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_policy_violations",
      description:
        "List current policy violations. Use to block patches that would land on a node already non-compliant.",
      parameters: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["low", "medium", "high"] },
          policyId: { type: "string" },
        },
      },
    },
  },
])
