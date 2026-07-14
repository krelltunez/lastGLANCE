// Prints the current month's reviewer bypass code to paste into the store
// review notes (Play Console App access / App Store Connect App Review).
//   npm run reviewer-code
// Preview a future month before a store update near month-end:
//   npm run reviewer-code -- 2026-08
//
// Imports the bound deriveReviewerCode() from src/config/reviewerAccess.js, so
// the secret is never passed on the command line and the printed code always
// matches what the running app will accept.
import { deriveReviewerCode } from '../src/config/reviewerAccess.js'

const arg = process.argv[2]
if (arg && !/^\d{4}-\d{2}$/.test(arg)) {
  console.error(`Invalid month "${arg}" — expected YYYY-MM (e.g. 2026-08).`)
  process.exit(1)
}

let code
if (arg) {
  // Preview a different month by pinning the clock deriveReviewerCode() reads.
  const real = Date.prototype.toISOString
  Date.prototype.toISOString = function () { return `${arg}-01T00:00:00.000Z` }
  try { code = await deriveReviewerCode() } finally { Date.prototype.toISOString = real }
} else {
  code = await deriveReviewerCode()
}

const period = arg || new Date().toISOString().slice(0, 7)
console.log(`Reviewer code for ${period}: ${code}`)
