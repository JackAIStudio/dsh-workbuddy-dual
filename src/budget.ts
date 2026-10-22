/**
 * One place for every size limit that decides whether a request survives.
 *
 * Three independent limits have to agree, and they used to be declared far
 * apart: the pi-ai image budget in adapter.ts, the shim's body buffer in
 * shim.ts, and the WorkBuddy gateways' undocumented body cap. They disagreed
 * by enough that a long session could never trigger the harness's image
 * offload path and instead died on a gateway 400 or a local 500. Keeping the
 * numbers together makes the inequality below reviewable in one screen.
 */

const MIB = 1024 * 1024

/**
 * Both gateways refuse a whole request body at roughly 16 MB.
 *
 * Measured against real sessions on this machine: a 15.97 MB body was
 * accepted and a 16.08 MB body was rejected by the CN gateway as
 * `11133 Invalid request parameters`. The Global gateway rejects a slightly
 * larger body with a bare 500. 15.5 MB therefore sits below any observed
 * acceptance point while leaving a little slack for framing differences.
 */
export const GATEWAY_BODY_LIMIT_BYTES = 15_500_000

/**
 * Room reserved for everything that is not image payload: system prompt
 * (~12 KB), tool catalog (~190 KB), conversation text, tool results, and JSON
 * framing. The catalog alone is 190 KB and the Harness regenerates it per
 * request, so the reserve cannot be tight.
 */
export const NON_IMAGE_BODY_RESERVE_BYTES = 4 * MIB

/**
 * Aggregate base64 image payload allowed in one request.
 *
 * This is the number that must trip *before* the gateway cap, because its
 * failure code (`IMAGE_OFFLOAD_REQUIRED`) is the only one the harness's
 * image-offload plugin acts on.
 */
export const MAX_REQUEST_IMAGE_BYTES = GATEWAY_BODY_LIMIT_BYTES - NON_IMAGE_BODY_RESERVE_BYTES

/**
 * Hard cap on a body the local shim will buffer.
 *
 * Above the gateway limit so the adapter's image budget is what rejects an
 * oversized request, and below infinity so a pathological body fails locally
 * with a 413 instead of being copied into a doomed upstream fetch.
 */
export const MAX_REQUEST_BODY_BYTES = 24 * MIB

/** Per-image raw-byte target before base64 expansion. */
export const REQUEST_IMAGE_MAX_BYTES = MIB

/** Total pixels allowed in one request image. */
export const REQUEST_IMAGE_PIXEL_BUDGET = 4_194_304
