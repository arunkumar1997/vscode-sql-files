import { SavedQuery } from "./types";

export function uniqueQueryName(
    preferredName: string,
    existingNames: Iterable<string>,
): string {
    const baseName = preferredName.trim() || "untitled";
    const usedNames = new Set(
        [...existingNames].map((name) => name.toLocaleLowerCase()),
    );
    if (!usedNames.has(baseName.toLocaleLowerCase())) {
        return baseName;
    }

    let suffix = 2;
    let candidate = `${baseName} (${suffix})`;
    while (usedNames.has(candidate.toLocaleLowerCase())) {
        suffix++;
        candidate = `${baseName} (${suffix})`;
    }
    return candidate;
}

export function ensureUniqueQueryNames(queries: SavedQuery[]): SavedQuery[] {
    const usedNames: string[] = [];
    return queries.map((query) => {
        const name = uniqueQueryName(query.name, usedNames);
        usedNames.push(name);
        return { ...query, name };
    });
}