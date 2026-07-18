import { execFileSync } from "node:child_process";
import { expectArray, expectOptionalString, expectRecord, expectString, parseJson } from "../src/decoding.js";

const prefix = "/sst/profound-proxy-router/";
const output = execFileSync(
  "aws",
  [
    "ssm",
    "get-parameters-by-path",
    "--path",
    prefix,
    "--recursive",
    "--query",
    "Parameters[?ends_with(Name, `/deployed-integration`)].{Name:Name,Value:Value}",
    "--output",
    "json",
  ],
  { encoding: "utf8" },
);
const now = Date.now();
for (const [index, value] of expectArray(
  parseJson(output, "expired-stage parameter response"),
  "expired-stage parameter response",
).entries()) {
  const parameter = expectRecord(value, `expired-stage parameter ${index}`);
  const rawValue = expectString(parameter.Value, `expired-stage parameter ${index}.Value`);
  let metadata: Record<string, unknown>;
  try {
    metadata = expectRecord(parseJson(rawValue, `expired-stage parameter ${index}.Value`), `expired-stage parameter ${index}.Value`);
  } catch {
    continue;
  }
  const stage = expectOptionalString(metadata.stage, `expired-stage parameter ${index}.stage`);
  const expiresAtValue = expectOptionalString(metadata.expiresAt, `expired-stage parameter ${index}.expiresAt`);
  if (stage === undefined || !stage.startsWith("ci-pr-")) continue;
  const expiresAt = Date.parse(expiresAtValue ?? "");
  if (!Number.isFinite(expiresAt) || expiresAt > now) continue;
  execFileSync("pnpm", ["aws:remove", "--stage", stage], { stdio: "inherit" });
}
