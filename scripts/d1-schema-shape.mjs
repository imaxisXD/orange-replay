/** Compare the database contract without treating ALTER TABLE column order as drift. */
export function readSchema(database) {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();

  return Object.fromEntries(
    tables.map(({ name }) => {
      const columns = database
        .prepare(
          'SELECT name, type, "notnull" AS not_null, dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY name',
        )
        .all(name)
        .map((column) => ({
          name: column.name,
          type: String(column.type).toUpperCase(),
          notNull: Number(column.not_null),
          defaultValue: normalizeDefault(column.dflt_value),
          primaryKeyOrder: Number(column.pk),
          hidden: Number(column.hidden),
        }));

      const indexes = database
        .prepare(
          "SELECT name, \"unique\" AS is_unique, partial FROM pragma_index_list(?) WHERE origin = 'c' ORDER BY name",
        )
        .all(name)
        .map((indexRow) => ({
          name: indexRow.name,
          unique: Number(indexRow.is_unique),
          partial: Number(indexRow.partial),
          columns: database
            .prepare(
              'SELECT name, "desc" AS is_desc, coll FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno',
            )
            .all(indexRow.name)
            .map((column) => ({
              name: column.name,
              descending: Number(column.is_desc),
              collation: column.coll,
            })),
        }));

      return [name, { columns, indexes }];
    }),
  );
}

function normalizeDefault(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  // SQLite treats unquoted TRUE/FALSE as integer literals. Quoted text stays text.
  if (/^true$/i.test(text)) return "1";
  if (/^false$/i.test(text)) return "0";
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return String(Number(text));
  return text;
}
