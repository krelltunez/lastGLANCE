// Reviewer bypass for Play Console App-access policy and Apple Guideline 2.1: a
// hard-gated store build must give the reviewer a way past the paywall. This is
// the ONE place lastGLANCE's secret appears. Both the running app (billing.ts,
// as the engine's `reviewerSecret`) and the `npm run reviewer-code` CLI import
// from here, so they can never disagree and the secret is never typed on a
// command line. @glance-apps/billing does the HMAC math; this binds our secret
// to it. Client-side gating is honor-system by design — this is light
// obfuscation, not real security.
import {
  deriveReviewerCode as deriveWithSecret,
  sha256Hex,
} from '@glance-apps/billing'

// lastGLANCE's OWN secret — deliberately different from dayGLANCE's so one
// month's code never unlocks both apps. Split across a concat so it isn't a
// single greppable string literal. Pick once and leave it: changing it after a
// build reaches store review invalidates any code already pasted into the
// review notes.
const _S = 'lg-r3v13w-' + 'c6f3e6cca00a20393e2ed8702eb4a2d331f181e5'

/** Passed into the billing engine config as `reviewerSecret`. */
export const REVIEWER_SECRET = _S

/** No-arg: HMAC-SHA256 over the current UTC month ("YYYY-MM"), 12-char hex. */
export function deriveReviewerCode() {
  return deriveWithSecret(_S)
}

export { sha256Hex }
