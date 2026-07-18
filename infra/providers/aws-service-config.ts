type Duration = `${number} second` | `${number} seconds` | `${number} minute` | `${number} minutes`;

export function containerHttpHealth(port: number, path: string, startPeriod: Duration = "20 seconds") {
  return {
    command: ["CMD-SHELL", `node -e "fetch('http://127.0.0.1:${port}${path}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`],
    startPeriod,
    interval: "30 seconds" as const,
    timeout: "5 seconds" as const,
    retries: 3,
  };
}

export function privateHttpLoadBalancer(port: number, healthPath: string) {
  const target: `${number}/http` = `${port}/http`;
  const health: Record<`${number}/http`, { path: string; interval: "30 seconds" }> = {
    [target]: { path: healthPath, interval: "30 seconds" as const },
  };
  return {
    public: false as const,
    rules: [{ listen: "80/http" as const, forward: target, container: "app" as const }],
    health,
  };
}
