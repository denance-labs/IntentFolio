// Feature flag for the withdrawal tracking record (ADR-0025, frontend plan `024`).
//
// Default OFF. Turn it on only on a deployment whose ops database has migration 006 applied
// (`intentfolio-solver/db/migrations/006_withdraw_record.sql`); before that every POST would
// fail on a missing table. Off or failing, withdrawals behave exactly as before — the write is
// best-effort and the browser's localStorage record stays the one that gates the publish.
//
// Its own module, not `withdraw-flag.ts`: the ingest route imports it on the server, and that
// file pulls in the withdrawal registry and fee code the route has no use for.
//
// ⚠️ NEXT_PUBLIC_ values are inlined at BUILD time, and only when referenced as a literal.

export const WITHDRAW_RECORDS_ENABLED = process.env.NEXT_PUBLIC_WITHDRAW_RECORDS === "true";
