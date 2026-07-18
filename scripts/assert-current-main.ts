const token = process.env["GITHUB_TOKEN"];
const repository = process.env["GITHUB_REPOSITORY"];
const candidate = process.env["CANDIDATE_SHA"];
if (!token || !repository || !candidate) throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY, and CANDIDATE_SHA are required");
const response = await fetch(`https://api.github.com/repos/${repository}/git/ref/heads/main`, {
  headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
});
if (!response.ok) throw new Error(`GitHub main ref returned ${response.status}`);
const responseBody = expectRecord(await response.json(), "GitHub main-ref response");
const object = expectRecord(responseBody["object"], "GitHub main-ref response.object");
const current = expectString(object["sha"], "GitHub main-ref response.object.sha");
if (current !== candidate) {
  process.stderr.write(
    `Candidate ${candidate} is superseded by main ${current}; the next serialized run will deploy the cumulative state.\n`,
  );
  const outputPath = process.env["GITHUB_OUTPUT"];
  if (outputPath) {
    await appendFile(outputPath, "current=false\n");
  }
  process.exit(0);
}
const outputPath = process.env["GITHUB_OUTPUT"];
if (outputPath) {
  await appendFile(outputPath, "current=true\n");
}
import { appendFile } from "node:fs/promises";
import { expectRecord, expectString } from "../src/decoding.js";
