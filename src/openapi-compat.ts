import { isUnknownRecord } from "./decoding.js";

export interface OpenApiDocument {
  openapi?: string;
  info?: { version?: string };
  paths?: Record<string, unknown>;
  components?: { schemas?: Record<string, unknown> };
}

interface ApiVersion {
  major: number;
  minor: number;
  patch: number;
}

type JsonRecord = Record<string, unknown>;

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

function record(value: unknown): JsonRecord | undefined {
  return isUnknownRecord(value) ? value : undefined;
}

export function decodeOpenApiDocument(value: unknown): OpenApiDocument {
  const document = record(value);
  if (document === undefined) throw new TypeError("OpenAPI document must be an object");
  const infoRecord = document["info"] === undefined ? undefined : record(document["info"]);
  if (document["info"] !== undefined && infoRecord === undefined) throw new TypeError("OpenAPI info must be an object");
  const version = infoRecord?.["version"];
  if (version !== undefined && typeof version !== "string") throw new TypeError("OpenAPI info.version must be a string");
  const paths = document["paths"] === undefined ? undefined : record(document["paths"]);
  if (document["paths"] !== undefined && paths === undefined) throw new TypeError("OpenAPI paths must be an object");
  const componentsRecord = document["components"] === undefined ? undefined : record(document["components"]);
  if (document["components"] !== undefined && componentsRecord === undefined) {
    throw new TypeError("OpenAPI components must be an object");
  }
  const schemas = componentsRecord?.["schemas"] === undefined ? undefined : record(componentsRecord["schemas"]);
  if (componentsRecord?.["schemas"] !== undefined && schemas === undefined) {
    throw new TypeError("OpenAPI components.schemas must be an object");
  }
  const openapi = document["openapi"];
  if (openapi !== undefined && typeof openapi !== "string") throw new TypeError("OpenAPI openapi must be a string");
  return {
    ...document,
    ...(openapi === undefined ? {} : { openapi }),
    ...(infoRecord === undefined ? {} : { info: { ...infoRecord, ...(version === undefined ? {} : { version }) } }),
    ...(paths === undefined ? {} : { paths }),
    ...(componentsRecord === undefined ? {} : { components: { ...componentsRecord, ...(schemas === undefined ? {} : { schemas }) } }),
  };
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is JsonRecord => item !== undefined) : [];
}

function apiVersion(value: string | undefined): ApiVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value ?? "");
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function permitsVersionedBreakingChanges(previousVersion: string | undefined, currentVersion: string | undefined): boolean {
  const previous = apiVersion(previousVersion);
  const current = apiVersion(currentVersion);
  if (previous === undefined || current === undefined) return false;
  if (current.major > previous.major) return true;
  return previous.major === 0 && current.major === 0 && current.minor > previous.minor;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mediaTypes(value: unknown): Set<string> {
  return new Set(Object.keys(record(value) ?? {}));
}

function parameterKey(parameter: JsonRecord): string | undefined {
  return typeof parameter["name"] === "string" && typeof parameter["in"] === "string"
    ? `${parameter["in"]}:${parameter["name"]}`
    : undefined;
}

function compareSchema(previousValue: unknown, currentValue: unknown, location: string, changes: string[]): void {
  const previous = record(previousValue);
  const current = record(currentValue);
  if (previous === undefined || current === undefined) return;

  if (typeof previous["type"] === "string" && current["type"] !== previous["type"]) {
    changes.push(`${location} changed type from ${previous["type"]} to ${String(current["type"])}`);
  }

  const previousEnum = strings(previous["enum"]);
  const currentEnum = new Set(strings(current["enum"]));
  for (const value of previousEnum) {
    if (currentEnum.size > 0 && !currentEnum.has(value)) changes.push(`${location} removed enum value ${JSON.stringify(value)}`);
  }

  const previousRequired = new Set(strings(previous["required"]));
  for (const name of strings(current["required"])) {
    if (!previousRequired.has(name)) changes.push(`${location} made property ${name} required`);
  }

  const previousProperties = record(previous["properties"]) ?? {};
  const currentProperties = record(current["properties"]) ?? {};
  for (const [name, property] of Object.entries(previousProperties)) {
    if (!(name in currentProperties)) {
      changes.push(`${location} removed property ${name}`);
      continue;
    }
    compareSchema(property, currentProperties[name], `${location}.${name}`, changes);
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const previousOptions = unknownArray(previous[keyword]);
    const currentOptions = unknownArray(current[keyword]);
    if (currentOptions.length < previousOptions.length) {
      changes.push(`${location} removed a ${keyword} schema option`);
    }
  }
}

function compareParameters(
  previousPath: JsonRecord,
  previousOperation: JsonRecord,
  currentPath: JsonRecord,
  currentOperation: JsonRecord,
  location: string,
  changes: string[],
): void {
  const previousParameters = [...records(previousPath["parameters"]), ...records(previousOperation["parameters"])];
  const currentParameters = [...records(currentPath["parameters"]), ...records(currentOperation["parameters"])];
  const currentByKey = new Map(
    currentParameters.flatMap((parameter) => {
      const key = parameterKey(parameter);
      return key === undefined ? [] : [[key, parameter] as const];
    }),
  );
  const previousKeys = new Set<string>();

  for (const parameter of previousParameters) {
    const key = parameterKey(parameter);
    if (key === undefined) continue;
    previousKeys.add(key);
    const currentParameter = currentByKey.get(key);
    if (currentParameter === undefined) {
      changes.push(`${location} removed parameter ${key}`);
      continue;
    }
    if (parameter["required"] !== true && currentParameter["required"] === true) {
      changes.push(`${location} made parameter ${key} required`);
    }
    compareSchema(parameter["schema"], currentParameter["schema"], `${location} parameter ${key}`, changes);
  }

  for (const parameter of currentParameters) {
    const key = parameterKey(parameter);
    if (key !== undefined && parameter["required"] === true && !previousKeys.has(key)) {
      changes.push(`${location} added required parameter ${key}`);
    }
  }
}

function compareRequestBody(previousOperation: JsonRecord, currentOperation: JsonRecord, location: string, changes: string[]): void {
  const previous = record(previousOperation["requestBody"]);
  const current = record(currentOperation["requestBody"]);
  if (previous === undefined && current?.["required"] === true) {
    changes.push(`${location} added a required request body`);
    return;
  }
  if (previous === undefined) return;
  if (current === undefined) {
    changes.push(`${location} removed its request body`);
    return;
  }
  if (previous["required"] !== true && current["required"] === true) changes.push(`${location} made its request body required`);

  const previousContent = record(previous["content"]) ?? {};
  const currentContent = record(current["content"]) ?? {};
  for (const mediaType of mediaTypes(previous["content"])) {
    if (!(mediaType in currentContent)) {
      changes.push(`${location} removed request media type ${mediaType}`);
      continue;
    }
    compareSchema(
      record(previousContent[mediaType])?.["schema"],
      record(currentContent[mediaType])?.["schema"],
      `${location} request ${mediaType}`,
      changes,
    );
  }
}

function compareResponses(previousOperation: JsonRecord, currentOperation: JsonRecord, location: string, changes: string[]): void {
  const previousResponses = record(previousOperation["responses"]) ?? {};
  const currentResponses = record(currentOperation["responses"]) ?? {};
  for (const [status, previousResponseValue] of Object.entries(previousResponses)) {
    const currentResponseValue = currentResponses[status];
    if (currentResponseValue === undefined) {
      changes.push(`${location} removed response ${status}`);
      continue;
    }
    const previousResponse = record(previousResponseValue);
    const currentResponse = record(currentResponseValue);
    if (previousResponse === undefined || currentResponse === undefined) continue;
    const currentContent = record(currentResponse["content"]) ?? {};
    for (const mediaType of mediaTypes(previousResponse["content"])) {
      if (!(mediaType in currentContent)) {
        changes.push(`${location} response ${status} removed media type ${mediaType}`);
        continue;
      }
      const previousMedia = record(record(previousResponse["content"])?.[mediaType]);
      const currentMedia = record(currentContent[mediaType]);
      compareSchema(previousMedia?.["schema"], currentMedia?.["schema"], `${location} response ${status} ${mediaType}`, changes);
    }
  }
}

export function findBreakingOpenApiChanges(previous: OpenApiDocument, current: OpenApiDocument): string[] {
  const changes: string[] = [];
  const previousPaths = record(previous.paths) ?? {};
  const currentPaths = record(current.paths) ?? {};

  for (const [path, previousPathValue] of Object.entries(previousPaths)) {
    const previousPath = record(previousPathValue);
    const currentPath = record(currentPaths[path]);
    if (currentPath === undefined) {
      changes.push(`removed path ${path}`);
      continue;
    }
    if (previousPath === undefined) continue;
    for (const method of HTTP_METHODS) {
      const previousOperation = record(previousPath[method]);
      if (previousOperation === undefined) continue;
      const currentOperation = record(currentPath[method]);
      const location = `${method.toUpperCase()} ${path}`;
      if (currentOperation === undefined) {
        changes.push(`removed operation ${location}`);
        continue;
      }
      const previousSecurity = Array.isArray(previousOperation["security"]) ? previousOperation["security"] : undefined;
      const currentSecurity = Array.isArray(currentOperation["security"]) ? currentOperation["security"] : undefined;
      if (
        (previousSecurity === undefined || previousSecurity.length === 0) &&
        currentSecurity !== undefined &&
        currentSecurity.length > 0
      ) {
        changes.push(`${location} now requires authorization`);
      }
      compareParameters(previousPath, previousOperation, currentPath, currentOperation, location, changes);
      compareRequestBody(previousOperation, currentOperation, location, changes);
      compareResponses(previousOperation, currentOperation, location, changes);
    }
  }

  const previousSchemas = record(previous.components)?.["schemas"];
  const currentSchemas = record(current.components)?.["schemas"];
  const previousSchemaRecords = record(previousSchemas) ?? {};
  const currentSchemaRecords = record(currentSchemas) ?? {};
  for (const [name, schema] of Object.entries(previousSchemaRecords)) {
    if (!(name in currentSchemaRecords)) {
      changes.push(`removed component schema ${name}`);
      continue;
    }
    compareSchema(schema, currentSchemaRecords[name], `schema ${name}`, changes);
  }
  return [...new Set(changes)].sort();
}
