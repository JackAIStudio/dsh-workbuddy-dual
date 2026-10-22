import { describe, expect, it } from 'vitest'
import {
  GATEWAY_BODY_LIMIT_BYTES,
  MAX_REQUEST_BODY_BYTES,
  MAX_REQUEST_IMAGE_BYTES,
  NON_IMAGE_BODY_RESERVE_BYTES,
  REQUEST_IMAGE_MAX_BYTES,
} from '../src/budget.ts'
import { RequestBodyTooLargeError } from '../src/shim.ts'

describe('request size budgets', () => {
  it('keeps the image budget below the gateway cap so the harness can offload', () => {
    // The whole point: `IMAGE_OFFLOAD_REQUIRED` must fire before WorkBuddy sees
    // an oversized body. If this ever inverts, long sessions die at the wall
    // again with a gateway 400 or a local 500 instead of dropping old images.
    expect(MAX_REQUEST_IMAGE_BYTES).toBeLessThan(GATEWAY_BODY_LIMIT_BYTES)
    expect(MAX_REQUEST_IMAGE_BYTES + NON_IMAGE_BODY_RESERVE_BYTES).toBeLessThanOrEqual(GATEWAY_BODY_LIMIT_BYTES)
  })

  it('leaves the gateways room for everything that is not image payload', () => {
    // The tool catalog alone is ~190 KB and is regenerated per request; the
    // reserve also covers the system prompt, text, tool results, and framing.
    expect(NON_IMAGE_BODY_RESERVE_BYTES).toBeGreaterThan(1024 * 1024)
    expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(MAX_REQUEST_IMAGE_BYTES)
    expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(GATEWAY_BODY_LIMIT_BYTES)
  })

  it('stays conservatively under the CN gateway rejection point', () => {
    // Measured on this machine: a 15.97 MB body was accepted and a 16.08 MB
    // body was rejected as 11133. The constant is a deliberate safety margin
    // below the accepted size, not a discovery of the exact cap.
    expect(GATEWAY_BODY_LIMIT_BYTES).toBeLessThan(15_970_000)
    expect(GATEWAY_BODY_LIMIT_BYTES).toBeGreaterThan(14_000_000)
  })

  it('describes an oversized body with both sizes', () => {
    const error = new RequestBodyTooLargeError(25_000_000, MAX_REQUEST_BODY_BYTES)
    expect(error.receivedBytes).toBe(25_000_000)
    expect(error.limitBytes).toBe(MAX_REQUEST_BODY_BYTES)
    expect(error.message).toContain('25000000')
  })

  it('targets a per-image size that fits several images in one budget', () => {
    // A 1 MiB raw target becomes ~1.33 MiB as base64, so the aggregate keeps
    // roughly seven full-size screenshots on the wire at once.
    expect(Math.floor(MAX_REQUEST_IMAGE_BYTES / (REQUEST_IMAGE_MAX_BYTES * 4 / 3))).toBeGreaterThanOrEqual(5)
  })
})
