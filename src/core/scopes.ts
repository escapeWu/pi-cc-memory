/**
 * Storage scope.
 *
 * Scope is a routing decision, never inferred from the memory type. The type
 * taxonomy is advisory: a `user` fact written with `scope=project` stays in the
 * project store. `typeScopeWarning()` reports the mismatch so the model can
 * correct itself without the store silently re-routing the write.
 */
export const MEMORY_SCOPES = ["project", "global"] as const;

export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export function isMemoryScope(value: unknown): value is MemoryScope {
	return typeof value === "string" && (MEMORY_SCOPES as readonly string[]).includes(value);
}

/**
 * Advisory split: cross-project identity/preferences live in `global`,
 * project facts and external pointers live in the project store.
 * Returns a warning message, or undefined when the pairing is expected.
 */
export function typeScopeWarning(type: string, scope: MemoryScope): string | undefined {
	if (scope === "global" && (type === "project" || type === "reference")) {
		return `"${type}" memories usually belong to the project store; scope=global makes this visible in every project`;
	}
	if (scope === "project" && (type === "user" || type === "feedback")) {
		return `"${type}" memories are usually cross-project; scope=project confines this to the current repository`;
	}
	return undefined;
}
