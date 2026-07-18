import { execFileSync } from "node:child_process";

// The AWS acceptance suite creates routes and access grants only through the
// public control contract. Running its control-plane subset against the baseline gives
// migration tests realistic old-version data without direct datastore writes.
execFileSync("pnpm", ["build"], { stdio: "inherit" });
execFileSync(
  "node",
  ["--test", "--test-name-pattern=deployed access grants|deployed route management", "dist/tests/deployed/control-plane.test.js"],
  { stdio: "inherit", env: { ...process.env, RUN_AWS_ACCEPTANCE_TESTS: "1" } },
);
