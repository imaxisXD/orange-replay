const MAX_SQL_TEXT_LENGTH = 16_384;

/**
 * Turns user-controlled text into one SQL string value.
 *
 * R2 SQL does not currently accept bound values. Doubling single quotes is
 * the SQL-standard way to keep the whole value inside one string literal.
 */
export function sqlText(value: string): string {
  if (value.length > MAX_SQL_TEXT_LENGTH) {
    throw new Error("Analytics filter text is too long");
  }

  return `'${value.replaceAll("'", "''")}'`;
}

/** Keep numbers out of SQL unless they are exact, non-negative integers. */
export function sqlWholeNumber(value: number, name: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a whole number`);
  }

  return String(value);
}

/**
 * Identifier values never come straight from a request. Callers must provide
 * the fixed list they accept, then this helper quotes the chosen value.
 */
export function sqlAllowedName<const Name extends string>(
  value: string,
  allowedNames: readonly Name[],
  label: string,
): `"${Name}"` {
  if (!allowedNames.includes(value as Name)) {
    throw new Error(`Unknown analytics ${label}`);
  }

  return `"${value}"` as `"${Name}"`;
}
