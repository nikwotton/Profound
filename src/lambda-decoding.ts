import { Schema } from "effect";

const exactOptional = <S extends Schema.Schema.All>(schema: S) => Schema.optionalWith(schema, { exact: true });

export interface CanaryGatewayEvent {
  rawPath?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Readonly<Record<string, string>>;
  requestContext?: { http?: { method?: string; path?: string; sourceIp?: string } };
}

export interface BufferedLog {
  level: string;
  time: string;
  message: string;
  context?: Readonly<Record<string, unknown>>;
}

const CanaryGatewayEventSchema: Schema.Schema<CanaryGatewayEvent> = Schema.Struct({
  rawPath: exactOptional(Schema.String),
  body: exactOptional(Schema.NullOr(Schema.String)),
  isBase64Encoded: exactOptional(Schema.Boolean),
  headers: exactOptional(Schema.Record({ key: Schema.String, value: Schema.String })),
  requestContext: exactOptional(
    Schema.Struct({
      http: exactOptional(
        Schema.Struct({
          method: exactOptional(Schema.String),
          path: exactOptional(Schema.String),
          sourceIp: exactOptional(Schema.String),
        }),
      ),
    }),
  ),
});

const BufferedLogSchema: Schema.Schema<BufferedLog> = Schema.Struct({
  level: Schema.String,
  time: Schema.String,
  message: Schema.String,
  context: exactOptional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

export function decodeCanaryGatewayEvent(value: unknown): CanaryGatewayEvent {
  return Schema.decodeUnknownSync(CanaryGatewayEventSchema)(value);
}

export function decodeBufferedLogLine(line: string): BufferedLog | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    const decoded = Schema.decodeUnknownSync(BufferedLogSchema)(parsed);
    return Number.isFinite(Date.parse(decoded.time)) ? decoded : undefined;
  } catch {
    return undefined;
  }
}
