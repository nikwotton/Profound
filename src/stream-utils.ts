import { Transform } from "node:stream";

export function byteCounter(onBytes: (bytes: number) => void, highWaterMark: number): Transform {
  return new Transform({
    highWaterMark,
    transform(chunk: Buffer, _encoding, callback) {
      onBytes(chunk.length);
      callback(null, chunk);
    },
  });
}
