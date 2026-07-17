import { execFileSync } from "node:child_process";

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
for (const parameter of JSON.parse(output)) {
  let metadata;
  try {
    metadata = JSON.parse(parameter.Value);
  } catch {
    continue;
  }
  if (!String(metadata.stage ?? "").startsWith("ci-pr-")) continue;
  const expiresAt = Date.parse(metadata.expiresAt ?? "");
  if (!Number.isFinite(expiresAt) || expiresAt > now) continue;
  execFileSync("pnpm", ["aws:remove", "--stage", metadata.stage], { stdio: "inherit" });
}
