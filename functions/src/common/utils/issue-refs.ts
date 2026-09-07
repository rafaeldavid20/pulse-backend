const IDENTIFIER_RE = /([A-Za-z]{2,10}-\d+)/;

/** `pul/tes-112-some-slug` -> `TES-112`. Matches the branch convention from slug.ts. */
export function identifierFromBranch(branch: string): string | null {
  const match = IDENTIFIER_RE.exec(branch.replace(/^pul\//, ''));
  return match ? match[1].toUpperCase() : null;
}

/** `Closes TES-112` / `fixes: eng-9` / `Resolves ENG-9.` anywhere in PR title or body. */
export function identifierFromClosesKeyword(text: string): string | null {
  const match = /\b(?:closes?|fixe?s?|resolves?)\s*:?\s*([A-Za-z]{2,10}-\d+)/i.exec(text);
  return match ? match[1].toUpperCase() : null;
}
