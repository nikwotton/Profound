const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const candidate = process.env.CANDIDATE_SHA;
if (!token || !repository || !candidate) throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY, and CANDIDATE_SHA are required");
const response = await fetch(`https://api.github.com/repos/${repository}/git/ref/heads/main`, {
  headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
});
if (!response.ok) throw new Error(`GitHub main ref returned ${response.status}`);
const current = (await response.json()).object.sha;
if (current !== candidate) {
  process.stderr.write(
    `Candidate ${candidate} is superseded by main ${current}; the next serialized run will deploy the cumulative state.\n`,
  );
  if (process.env.GITHUB_OUTPUT) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_OUTPUT, "current=false\n");
  }
  process.exit(0);
}
if (process.env.GITHUB_OUTPUT) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(process.env.GITHUB_OUTPUT, "current=true\n");
}
