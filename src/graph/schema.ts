/**
 * Kuzu graph schema DDL statements.
 *
 * Node table  : Symbol — one node per indexed symbol (class/method/field/…)
 * Rel tables  : CALLS, REFERENCES, EXTENDS, IMPLEMENTS, CONTAINS
 *
 * All CREATE statements use IF NOT EXISTS so opening an existing DB is safe.
 */

export const CREATE_NODE_SYMBOL = `
  CREATE NODE TABLE IF NOT EXISTS Symbol(
    id         INT64   PRIMARY KEY,
    name       STRING,
    kind       STRING,
    file_path  STRING,
    project_id INT64,
    start_line INT32
  )
`;

/** Direct call from one symbol's body to another */
export const CREATE_REL_CALLS = `
  CREATE REL TABLE IF NOT EXISTS CALLS(FROM Symbol TO Symbol)
`;

/** Non-call reference: field_access, type_reference, annotation */
export const CREATE_REL_REFERENCES = `
  CREATE REL TABLE IF NOT EXISTS REFERENCES(FROM Symbol TO Symbol, kind STRING)
`;

/** Class extends another class */
export const CREATE_REL_EXTENDS = `
  CREATE REL TABLE IF NOT EXISTS EXTENDS(FROM Symbol TO Symbol)
`;

/** Class/enum implements an interface */
export const CREATE_REL_IMPLEMENTS = `
  CREATE REL TABLE IF NOT EXISTS IMPLEMENTS(FROM Symbol TO Symbol)
`;

/** Inner class / method contained in outer class */
export const CREATE_REL_CONTAINS = `
  CREATE REL TABLE IF NOT EXISTS CONTAINS(FROM Symbol TO Symbol)
`;

export const ALL_DDL = [
  CREATE_NODE_SYMBOL,
  CREATE_REL_CALLS,
  CREATE_REL_REFERENCES,
  CREATE_REL_EXTENDS,
  CREATE_REL_IMPLEMENTS,
  CREATE_REL_CONTAINS,
];
