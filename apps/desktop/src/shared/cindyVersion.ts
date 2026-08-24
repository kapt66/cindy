export function supportsCindyVersion(
  currentVersion: string,
  minVersion: string | undefined,
): boolean {
  if (minVersion === undefined) return true;
  const parse = (value: string): [number, number, number] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-|\+|$)/.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const current = parse(currentVersion);
  const minimum = parse(minVersion);
  if (!current || !minimum) return false;
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== minimum[index]) return current[index]! > minimum[index]!;
  }
  return true;
}
