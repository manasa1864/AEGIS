// YAML well-formedness check used by the fix validator: a fix must never turn
// a parseable workflow / compose file / manifest into an unparseable one.

import yaml from 'js-yaml';

// CI dialects use custom tags — accept them rather than reporting false errors.
const CI_SCHEMA = yaml.DEFAULT_SCHEMA.extend(
  ['!reference', '!Ref', '!Sub', '!GetAtt', '!If', '!Join', '!Select', '!Split', '!FindInMap', '!Base64', '!Equals', '!Not', '!And', '!Or', '!Condition', '!ImportValue', '!GetAZs', '!Cidr']
    .flatMap(tag => [
      new yaml.Type(tag, { kind: 'scalar', construct: d => d }),
      new yaml.Type(tag, { kind: 'sequence', construct: d => d }),
      new yaml.Type(tag, { kind: 'mapping', construct: d => d }),
    ]),
);

export const isYamlPath = (path: string) => /\.ya?ml$/i.test(path);

/** Paths that are YAML *templates* (Helm, Jinja) — not parseable until rendered. */
const isTemplated = (path: string, content: string) =>
  /(^|\/)templates\//.test(path) || /\{\{-?\s|\{%/.test(content.replace(/\$\{\{[^}]*\}\}/g, ''));

/** Returns the parse error message, or null when the YAML is well-formed (or not checkable). */
export function yamlParseError(path: string, content: string): string | null {
  if (!isYamlPath(path) || isTemplated(path, content)) return null;
  try {
    yaml.loadAll(content, null, { schema: CI_SCHEMA, filename: path }); // multi-document (k8s ---)
    return null;
  } catch (e) {
    return (e as Error).message.split('\n')[0];
  }
}
