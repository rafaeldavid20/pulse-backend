export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

/** Branch naming convention used across the app: `pul/eng-142-slug-of-title`. */
export function suggestedBranchName(identifier: string, title: string): string {
  return `pul/${identifier.toLowerCase()}-${slugify(title)}`;
}
