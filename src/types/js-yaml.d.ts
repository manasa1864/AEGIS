// Minimal typings for the parts of js-yaml 4 that Aegis uses (the package ships no types).
declare module 'js-yaml' {
  export class Type {
    constructor(tag: string, options: { kind: 'scalar' | 'sequence' | 'mapping'; construct?: (data: unknown) => unknown });
  }
  export interface Schema {
    extend(types: Type[]): Schema;
  }
  export const DEFAULT_SCHEMA: Schema;
  export function loadAll(str: string, iterator?: null, opts?: { schema?: Schema; filename?: string }): unknown[];
  const yaml: { Type: typeof Type; DEFAULT_SCHEMA: Schema; loadAll: typeof loadAll };
  export default yaml;
}
