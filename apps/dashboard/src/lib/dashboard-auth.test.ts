/**
 * Unit tests for the shared dashboard auth gate: local-request convenience
 * path, bearer-token matching, and the fail-closed remote-without-token case.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { authorizeInterventionRequest, authorizeStatusRequest } from "./dashboard-auth"

const ENV_KEYS = [
  "SYMPHONY_ALLOW_REMOTE_STATUS",
  "SYMPHONY_DASHBOARD_TOKEN",
  "SYMPHONY_ALLOW_REMOTE_INTERVENTION",
  "SYMPHONY_INTERVENTION_TOKEN",
] as const

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key]
}

function req(host: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://${host}/x`, { headers: { host, ...headers } })
}

describe.each([
  {
    label: "authorizeStatusRequest",
    authorize: authorizeStatusRequest,
    allowRemoteEnvVar: "SYMPHONY_ALLOW_REMOTE_STATUS",
    tokenEnvVar: "SYMPHONY_DASHBOARD_TOKEN",
  },
  {
    label: "authorizeInterventionRequest",
    authorize: authorizeInterventionRequest,
    allowRemoteEnvVar: "SYMPHONY_ALLOW_REMOTE_INTERVENTION",
    tokenEnvVar: "SYMPHONY_INTERVENTION_TOKEN",
  },
])("$label", ({ authorize, allowRemoteEnvVar, tokenEnvVar }) => {
  beforeEach(clearEnv)
  afterEach(clearEnv)

  test("local default: localhost host header is allowed with no token configured", () => {
    expect(authorize(req("localhost"))).toBeNull()
    expect(authorize(req("127.0.0.1"))).toBeNull()
  })

  test("SECURITY REGRESSION: a spoofed 'Host: localhost' header must NOT bypass a configured token", () => {
    // This is the critical bypass: an attacker who can reach the bound port
    // sends `curl -H 'Host: localhost'` with no bearer token at all. The
    // local-request heuristic must never short-circuit before the token
    // check when a token IS configured — even though SYMPHONY_ALLOW_REMOTE_*
    // is not set.
    process.env[tokenEnvVar] = "correct-token"
    const res = authorize(req("localhost"))
    expect(res).not.toBeNull()
    expect(res?.status).toBe(401)
  })

  test("SECURITY REGRESSION: a spoofed 'Host: localhost' header with a wrong bearer token is rejected when a token is configured", () => {
    process.env[tokenEnvVar] = "correct-token"
    const res = authorize(req("localhost", { authorization: "Bearer wrong-token" }))
    expect(res).not.toBeNull()
    expect(res?.status).toBe(401)
  })

  test("SECURITY REGRESSION: 'Host: localhost' with the correct bearer token is still allowed when a token is configured", () => {
    process.env[tokenEnvVar] = "correct-token"
    const res = authorize(req("localhost", { authorization: "Bearer correct-token" }))
    expect(res).toBeNull()
  })

  test("local default: a spoofed localhost Host header behind a reverse proxy (X-Forwarded-For set to a non-loopback IP) is rejected", () => {
    const res = authorize(req("localhost", { "x-forwarded-for": "203.0.113.7" }))
    expect(res).not.toBeNull()
    expect(res?.status).toBe(403)
  })

  test("missing token: non-local request with no token configured is rejected with 403", () => {
    const res = authorize(req("evil.example.com"))
    expect(res).not.toBeNull()
    expect(res?.status).toBe(403)
  })

  test("wrong token: non-local request with an incorrect bearer token is rejected with 401", () => {
    process.env[tokenEnvVar] = "correct-token"
    const res = authorize(req("evil.example.com", { authorization: "Bearer wrong-token" }))
    expect(res).not.toBeNull()
    expect(res?.status).toBe(401)
  })

  test("correct token: non-local request with a matching bearer token is allowed", () => {
    process.env[tokenEnvVar] = "correct-token"
    const res = authorize(req("evil.example.com", { authorization: "Bearer correct-token" }))
    expect(res).toBeNull()
  })

  test("remote-enabled without token: fails closed with 403 and names the missing env var", () => {
    process.env[allowRemoteEnvVar] = "1"
    const res = authorize(req("evil.example.com"))
    expect(res).not.toBeNull()
    expect(res?.status).toBe(403)
  })

  test("remote-enabled without token: also fails closed even for a request presenting no credentials at all", async () => {
    process.env[allowRemoteEnvVar] = "1"
    const res = authorize(req("evil.example.com"))
    const body = (await res?.json()) as { message: string }
    expect(body.message).toContain(tokenEnvVar)
    expect(body.message).toContain(allowRemoteEnvVar)
  })

  test("remote-enabled with token: matching bearer token is allowed", () => {
    process.env[allowRemoteEnvVar] = "1"
    process.env[tokenEnvVar] = "correct-token"
    const res = authorize(req("evil.example.com", { authorization: "Bearer correct-token" }))
    expect(res).toBeNull()
  })

  test("remote-enabled with token: wrong bearer token is rejected with 401 even from a localhost Host header", () => {
    process.env[allowRemoteEnvVar] = "1"
    process.env[tokenEnvVar] = "correct-token"
    const res = authorize(req("localhost", { authorization: "Bearer wrong-token" }))
    expect(res).not.toBeNull()
    expect(res?.status).toBe(401)
  })
})
