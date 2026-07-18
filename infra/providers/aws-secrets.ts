/// <reference path="../../.sst/platform/config.d.ts" />

export function containerSecret(name: string, value: InstanceType<typeof sst.Secret>["value"], production: boolean) {
  const secret = new aws.secretsmanager.Secret(`${name}ContainerSecret`, {
    description: `Managed by SST for ${$app.name}/${$app.stage}`,
    recoveryWindowInDays: production ? 30 : 0,
  });
  const version = new aws.secretsmanager.SecretVersion(`${name}ContainerSecretVersion`, {
    secretId: secret.id,
    secretString: value,
  });
  return secret.arn.apply((arn) => version.id.apply(() => arn));
}
