import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";

const sha = process.env.DEPLOYED_SHA;
const image = process.env.RELEASE_IMAGE_URI;
if (!sha || !image) throw new Error("DEPLOYED_SHA and RELEASE_IMAGE_URI are required");
const parameter = "/sst/profound-proxy-router/production/deployed-release";
let previous;
try {
  previous = JSON.parse(
    execFileSync("aws", ["ssm", "get-parameter", "--name", parameter, "--query", "Parameter.Value", "--output", "text"], {
      encoding: "utf8",
    }),
  );
} catch {
  previous = undefined;
}
const from = previous?.sha;
const subjects = execFileSync("git", ["log", "--format=%s", ...(from ? [`${from}..${sha}`] : [sha])], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);
const manifest = JSON.stringify({ schemaVersion: 1, sha, image, deployedAt: new Date().toISOString(), releaseNotes: subjects });
execFileSync("aws", ["ssm", "put-parameter", "--name", parameter, "--type", "String", "--overwrite", "--value", manifest], {
  stdio: "inherit",
});
if (process.env.GITHUB_STEP_SUMMARY) {
  const notes = subjects.length === 0 ? "- No commit subjects were found." : subjects.map((subject) => `- ${subject}`).join("\n");
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## Production release ${sha.slice(0, 12)}\n\nImage: \`${image}\`\n\nChanges since the previous successful production deployment:\n\n${notes}\n`,
  );
}
