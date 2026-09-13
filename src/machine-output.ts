/**
 * Public machine-output schema major.
 *
 * Additive fields may ship without changing this value. Removing/renaming a
 * required field, changing its type, or changing a discriminator's meaning
 * requires a new major and new published *-vN.schema.json files.
 */
export const MACHINE_SCHEMA_VERSION = 1 as const;
export type MachineSchemaVersion = typeof MACHINE_SCHEMA_VERSION;

export function machineOutput<T extends Record<string, unknown>>(
  payload: T,
): T & { schema_version: MachineSchemaVersion } {
  return { ...payload, schema_version: MACHINE_SCHEMA_VERSION };
}
