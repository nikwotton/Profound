import { readFile } from "node:fs/promises";
import { validateMigrationDeclaration } from "../dist/src/release-policy.js";

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
const event = JSON.parse(await readFile(eventPath, "utf8"));
if (!event.pull_request) {
  process.stdout.write("Migration declaration validation is only required for pull requests.\n");
  process.exit(0);
}

const labels = (event.pull_request.labels ?? []).map((label) => label.name).filter(Boolean);
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repository || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");

const files = [];
for (let page = 1; ; page += 1) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/pulls/${event.pull_request.number}/files?per_page=100&page=${page}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok) throw new Error(`GitHub files API returned ${response.status}`);
  const pageFiles = await response.json();
  files.push(...pageFiles.map((file) => file.filename));
  if (pageFiles.length < 100) break;
}

const result = validateMigrationDeclaration(labels, files);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.errors.length > 0) {
  for (const error of result.errors) process.stderr.write(`::error::${error}\n`);
  process.exit(1);
}
