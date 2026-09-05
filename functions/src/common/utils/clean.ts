/**
 * Deeply removes `undefined` values from an object or array so it is safe to
 * pass to Firestore's `set()`/`update()` (which reject `undefined`, including
 * when nested inside plain objects or arrays).
 *
 * Recurses into plain objects and arrays. Firestore `Timestamp`, `Date`,
 * `DocumentReference`, `GeoPoint` and other class instances are treated as
 * opaque values and returned as-is (only plain `Object` literals are
 * recursed into, so these are never mistaken for a nested map).
 */
export function cleanUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== undefined)
      .map((item) => cleanUndefined(item)) as unknown as T;
  }

  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    const clean: Record<string, any> = {};
    Object.keys(value as Record<string, any>).forEach((key) => {
      const v = (value as Record<string, any>)[key];
      if (v !== undefined) {
        clean[key] = cleanUndefined(v);
      }
    });
    return clean as T;
  }

  return value;
}
