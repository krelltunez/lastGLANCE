// Types for the plain-JS reviewer-access module. It is plain JS (not TS) so the
// `npm run reviewer-code` CLI can import it under plain node with no loader; the
// app side imports it as TypeScript through these declarations. See
// reviewerAccess.js.
export declare const REVIEWER_SECRET: string
export declare function deriveReviewerCode(): Promise<string>
export declare function sha256Hex(text: string): Promise<string>
