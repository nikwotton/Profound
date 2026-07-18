import { expectRecord } from "./decoding.js";

export async function callDynamicExport(modulePath: string, exportName: string, args: readonly unknown[]): Promise<unknown> {
  const moduleValue: unknown = await import(modulePath);
  const moduleRecord = expectRecord(moduleValue, `Dynamic module ${modulePath}`);
  const exported = moduleRecord[exportName];
  if (typeof exported !== "function") throw new TypeError(`Dynamic module ${modulePath} must export ${exportName}`);
  const result: unknown = Reflect.apply(exported, undefined, [...args]);
  return await Promise.resolve(result);
}
