/** Names of the Artifacts agent tools; kept dependency-free for the tool catalog and permission policy. */
export const ARTIFACT_TOOL_NAMES = [
  "list_artifacts",
  "search_artifacts",
  "delete_artifact",
] as const;

export type ArtifactToolName = typeof ARTIFACT_TOOL_NAMES[number];

/** The read-only ones: they never change an artifact or its file. */
export const ARTIFACT_READ_TOOL_NAMES = ["list_artifacts", "search_artifacts"] as const satisfies readonly ArtifactToolName[];

/**
 * The artifact tools a session with this tool profile has, for the prompt
 * that names them. Without an allow-list it is an ordinary chat, which has
 * all of them. An allow-list (an Agent Run's, a primary Agent's) is built
 * from the capability catalog, which leaves out chat-only tools, so it
 * names only the ones it lists: in practice none. The Michi assistant has
 * none on any runtime (its own catalog replaces the chat tools).
 */
export function artifactToolsForProfile(
  profile?: { allowedToolNames?: readonly string[]; assistant?: boolean } | null,
): ArtifactToolName[] {
  if (profile?.assistant === true) return [];
  const allowed = profile?.allowedToolNames;
  return allowed ? ARTIFACT_TOOL_NAMES.filter((name) => allowed.includes(name)) : [...ARTIFACT_TOOL_NAMES];
}

/**
 * Whether a session with these artifact tools can find artifacts a first
 * message does not name: list_artifacts browses all of them. Without it the
 * first message has to name them itself (artifactTools.workspaceArtifactManifest).
 */
export function canLookUpArtifacts(tools: readonly ArtifactToolName[]): boolean {
  return tools.includes("list_artifacts");
}
