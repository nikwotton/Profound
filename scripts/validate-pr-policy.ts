import { readFile } from "node:fs/promises";
import { expectArray, expectNumber, expectRecord, expectString, parseJson } from "../src/decoding.js";
import { validateMigrationDeclaration } from "../src/release-policy.js";

const eventPath = process.env["GITHUB_EVENT_PATH"];
if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
const event = expectRecord(parseJson(await readFile(eventPath, "utf8"), "GitHub event"), "GitHub event");
if (event["pull_request"] === undefined) {
  process.stdout.write("Migration declaration validation is only required for pull requests.\n");
  process.exit(0);
}

const pullRequest = expectRecord(event["pull_request"], "GitHub event.pull_request");
const pullRequestNumber = expectNumber(pullRequest["number"], "GitHub event.pull_request.number");
const labels = expectArray(pullRequest["labels"] ?? [], "GitHub event.pull_request.labels").map((value, index) => {
  const label = expectRecord(value, `GitHub event.pull_request.labels[${index}]`);
  return expectString(label["name"], `GitHub event.pull_request.labels[${index}].name`);
});
const repository = process.env["GITHUB_REPOSITORY"];
const token = process.env["GITHUB_TOKEN"];
if (!repository || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");

const files: string[] = [];
for (let page = 1; ; page += 1) {
  const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub files API returned ${response.status}`);
  const pageFiles = expectArray(await response.json(), `GitHub files API page ${page}`);
  files.push(
    ...pageFiles.map((value, index) => {
      const file = expectRecord(value, `GitHub files API page ${page}[${index}]`);
      return expectString(file["filename"], `GitHub files API page ${page}[${index}].filename`);
    }),
  );
  if (pageFiles.length < 100) break;
}

const result = validateMigrationDeclaration(labels, files);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.errors.length > 0) {
  for (const error of result.errors) process.stderr.write(`::error::${error}\n`);
  process.exit(1);
}
