import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  bestEffortDeleteProfile,
  controlRequest,
  createRoute,
  deleteProfile,
  e2eEnvironment,
  e2eTest,
  issuedProxyEndpoint,
  type IssuedAccessGrantResponse,
  proxyWithCredentials,
  requestViaHttpProxy,
  requestViaSocks5,
} from "./helpers.js";

function optionalHeader(response: { headers: import("node:http").IncomingHttpHeaders }, name: string): string | undefined {
  const value = response.headers[name];
  return typeof value === "string" ? value : undefined;
}

e2eTest("a caller can discover service health and must authenticate management requests", async () => {
  const live = await controlRequest("/health/live", {}, null);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "live" });

  const ready = await controlRequest("/health/ready", {}, null);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready" });

  assert.equal((await controlRequest("/v1/profiles", {}, null)).status, 401);
});

e2eTest("a caller can create, use, inspect, and delete a provider-neutral profile", async (t) => {
  const environment = e2eEnvironment();
  const route = await createRoute({
    customerId: `e2e-residential-${randomUUID()}`,
    geography: { countryCode: "US" },
    isTargetAuthenticated: false,
    allowConnectionRetry: false,
  });
  let deleted = false;
  t.after(async () => {
    if (!deleted) await bestEffortDeleteProfile(route.profile.profileId);
  });

  assert.equal(new URL(route.proxyUrls.http).protocol, "http:");
  assert.equal(new URL(route.proxyUrls.socks5).protocol, "socks5h:");
  assert.equal(decodeURIComponent(new URL(route.proxyUrls.http).username), route.credential.username);
  assert.notEqual(route.proxyUsername, route.accessGrant.grantId);

  const http = await requestViaHttpProxy(route.proxyUrls.http, environment.targetUrl, {
    headers: { "x-profound-e2e-id": randomUUID() },
  });
  assert.equal(http.status, environment.expectedTargetStatus);

  const socks = await requestViaSocks5(route.proxyUrls.socks5, environment.targetUrl);
  assert.equal(socks.status, environment.expectedTargetStatus);

  const wrongCredential = await requestViaHttpProxy(
    proxyWithCredentials(route.proxyUrls.http, route.credential.username, "wrong-e2e-credential"),
    environment.targetUrl,
  );
  assert.equal(wrongCredential.status, 407);

  const detail = await controlRequest(`/v1/profiles/${route.profile.profileId}`);
  assert.equal(detail.status, 200);
  const detailText = await detail.text();
  const credentialPassword = decodeURIComponent(new URL(route.proxyUrls.http).password);
  assert.ok(credentialPassword.length >= 32);
  assert.ok(!detailText.includes(credentialPassword));

  const deletion = await deleteProfile(route.profile.profileId);
  assert.equal(deletion.status, 204);
  deleted = true;
  assert.equal((await requestViaHttpProxy(route.proxyUrls.http, environment.targetUrl)).status, 407);
  assert.equal((await controlRequest(`/v1/profiles/${route.profile.profileId}`)).status, 404);
});

e2eTest("a grant credential can be rotated and independently revoked", async (t) => {
  const environment = e2eEnvironment();
  const route = await createRoute({
    customerId: `e2e-credential-${randomUUID()}`,
    geography: { countryCode: "US" },
    isTargetAuthenticated: false,
    allowConnectionRetry: true,
  });
  t.after(() => bestEffortDeleteProfile(route.profile.profileId));

  const rotationResponse = await controlRequest(`/v1/grants/${route.accessGrant.grantId}/credentials/rotate`, { method: "POST" });
  assert.equal(rotationResponse.status, 200);
  const rotated = (await rotationResponse.json()) as IssuedAccessGrantResponse;
  const rotatedUrl = issuedProxyEndpoint(rotated, "http");
  assert.equal(
    rotated.grant.credentials.find((credential) => credential.credentialId === route.credential.credentialId)?.status,
    "overlap",
  );
  assert.equal(rotated.credential.status, "active");
  assert.equal((await requestViaHttpProxy(route.proxyUrls.http, environment.targetUrl)).status, environment.expectedTargetStatus);
  assert.equal((await requestViaHttpProxy(rotatedUrl, environment.targetUrl)).status, environment.expectedTargetStatus);

  const revokeOld = await controlRequest(`/v1/grants/${route.accessGrant.grantId}/credentials/${route.credential.credentialId}`, {
    method: "DELETE",
  });
  assert.equal(revokeOld.status, 204);
  assert.equal((await requestViaHttpProxy(route.proxyUrls.http, environment.targetUrl)).status, 407);
  assert.equal((await requestViaHttpProxy(rotatedUrl, environment.targetUrl)).status, environment.expectedTargetStatus);

  const revokeGrant = await controlRequest(`/v1/grants/${route.accessGrant.grantId}`, { method: "DELETE" });
  assert.equal(revokeGrant.status, 204);
  assert.equal((await requestViaHttpProxy(rotatedUrl, environment.targetUrl)).status, 407);
});

e2eTest("authenticated profile updates apply exact-city requirements to new connections", async (t) => {
  const environment = e2eEnvironment();
  const customerId = `e2e-authenticated-${randomUUID()}`;
  const route = await createRoute({
    customerId,
    geography: { countryCode: "US", regionCode: "NY", city: "New York" },
    isTargetAuthenticated: true,
    allowConnectionRetry: false,
  });
  t.after(() => bestEffortDeleteProfile(route.profile.profileId));

  const first = await requestViaHttpProxy(route.proxyUrls.http, environment.targetUrl);
  assert.equal(first.status, environment.expectedTargetStatus);
  const firstCity = optionalHeader(first, "x-mock-city");
  if (firstCity !== undefined) assert.equal(firstCity.toLowerCase().replaceAll(" ", ""), "newyork");

  const update = await controlRequest(`/v1/profiles/${route.profile.profileId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerId,
      geography: { countryCode: "US", regionCode: "CA", city: "Los Angeles" },
      isTargetAuthenticated: true,
      allowConnectionRetry: false,
    }),
  });
  assert.equal(update.status, 200);
  const updateText = await update.text();
  assert.doesNotMatch(updateText, /"provider"|proxySlot|endpointId|deviceId/i);

  const updated = await requestViaHttpProxy(route.proxyUrls.http, environment.targetUrl);
  assert.equal(updated.status, environment.expectedTargetStatus);
  const updatedCity = optionalHeader(updated, "x-mock-city");
  if (updatedCity !== undefined) assert.equal(updatedCity.toLowerCase().replaceAll(" ", ""), "losangeles");
});
