# Usage accounting contract

WhereMyTokens estimates local AI coding usage and API-equivalent cost. It does not reconstruct an invoice. All sources use the same provider rules, durable index, and local observation boundaries; no personal session list, repair receipt, or manual certification is required.

## Quantities and identity

- Codex input includes cached input, and output includes reasoning. Cached input is split out of input for pricing; reasoning stays inside output. These fields are never added twice.
- A continuous Codex segment uses cumulative differences when available. `last_token_usage` does not override a positive cumulative difference. Without a cumulative counter, individual usage records are counted.
- Moving from individual usage to cumulative usage establishes a baseline. An unexplained initial nonzero cumulative value is also a baseline; only confirmed new last usage is charged. This may omit unrecoverable earlier usage.
- Notifications and detailed records are views of the same cumulative quantity. Covered delayed details add identity links without adding quantities. Notification progress is tracked separately so a delayed notification cannot rewind a detailed interval. A notification's own regression establishes a new segment; a turn/settings/abort boundary alone does not establish usage. New assistant output does not make an already covered detailed record a new charge.
- Identified fork prefixes update context and baseline only, including when the parent is absent. An own turn, or an explicit child execution at/after child creation, ends the prefix. The scanner never opens the parent log or reconstructs a lineage graph.
- Counter regressions never subtract committed history. Known observations are skipped; otherwise the counter establishes a new baseline and only confirmed new usage and subsequent increments are counted. Unidentifiable old snapshots can leave estimation error.
- Stable execution IDs identify one record. Confirmed monotonic revisions replace that record; conflicting models, regressing components, or inconsistent owners preserve the first valid record. A conflict does not fail the rest of the source.
- Ordinary new records without IDs use physical source, generation, and position (or remote row/step position). Similar time, model, or token count alone is not a duplicate test.
- Durable aliases point to one existing canonical owner in `usage_identity`. Late aliases carry no quantity. Bootstrap identities bind retained original requests when available, including same-source protected identities; aliases are updated together. If only old sealed aggregates remain, ambiguous overlap stays protected.
- Antigravity identity is scoped by known account, independent of process restart. Unknown-to-known transitions preserve historical totals once and establish the new baseline. The resolved scope is storage-owned metadata that survives later unknown-source refreshes. Separate known accounts remain separate.

## Metadata and cost

Missing model, time, or category does not discard otherwise usable quantities. An explicit current model takes precedence over preceding context. Missing categories remain represented in the total without speculative historical reconstruction.

For missing/invalid timestamps, local logs use the preceding valid log timestamp, session creation time, file modification time, then first collection time. The chosen file fallback is normalized to integer milliseconds before persistence, including fractional filesystem modification times; parser context is persisted with it. Antigravity uses preceding valid call time, then its persisted source fallback. Negative/invalid provider dates are not accepted as usage dates. Estimated dates can concentrate records into one day.

Existing named and date-sensitive price rules remain in `modelPricing.ts` and Antigravity `pricing.ts`.

`gpt-6-astra` uses the [official Standard API rates](https://developers.openai.com/api/docs/models/gpt-6-astra), verified on 2026-09-07: $10 uncached input, $1 cached input, $12.50 cache writes, and $50 output per million tokens. Above 272,000 total prompt tokens, input and cache rates double and output is multiplied by 1.5 for the full request; the boundary itself retains the standard rates. Input, cache writes, and cache reads are disjoint quantities at the pricing boundary. Codex cached input is split out of reported input before pricing; cache writes are priced only when supplied, not inferred from every input token. These are API-equivalent estimates, not ChatGPT/Codex subscription credits or service-tier-specific charges.

### Automatic price revisions

`USAGE_PRICE_REVISIONS` records an immutable revision ID, exact provider/model, effective start, optional exclusive end, rates, and official source. The same rules price new records and drive historical cost updates. GPT-6 Astra's initial rule starts at `2026-09-03T00:00:00Z`, using the UTC date boundary of its [documented release day](https://developers.openai.com/api/docs/changelog), not a claimed exact rollout hour. A later price change adds a new dated revision instead of changing a completed revision's meaning.

After opening/migrating UsageIndex and before collection starts, a worker applies pending revisions from retained `usage_entry` facts. It never reads or reparses provider logs. For each affected source/model, all impacted hour/day/month buckets must reconcile with retained detail: request counts, every token component, existing costs, and cache savings. Otherwise the source's costs remain unchanged and the receipt records it as preserved. Long-context prices are evaluated per retained request, never from summed daily tokens. Records before the effective start, at/after an exclusive end, and other models are not repriced; a shared month bucket receives only the affected records' cost difference.

The existing usage tables and schema 6 remain intact. The only added table is `usage_pricing_revision`, containing revision IDs, rule signatures, and completion reports. Before a pending revision is applied, a validated SQLite backup is created under the application's `usage-pricing-backups` directory. Cost updates and completion receipts commit in one transaction, with before/after hashes of all non-cost source, identity ownership, attribution, entry, bucket, and session-projection data. The existing execution fingerprint includes cost, so matching fingerprints are refreshed as derived metadata; identity keys, owners, aliases, and timestamps never change. This prevents a later duplicate from being mistaken for conflicting usage. Failed transactions leave no completion receipt and can retry at the next start. A completed revision, including preserved incomplete sources, is not repeatedly retried. Restoring the database also restores its receipt state.

After successful revision processing, the startup presentation snapshot is invalidated once for that revision set so cached old totals cannot overwrite revised costs. Session projections contain no monetary totals and remain unchanged. Initial indexing, parser state, token quantities, and Git accounting are unaffected. Failure is logged and collection can still start; no destructive Reset or automatic raw-log replay is used as recovery. The explicit raw-source lossless repricing CLI remains a separate maintenance operation.

Unlisted models use these deterministic reference rates, in USD per million tokens:

| Reference | Uncached input | Output | Cache write | Cache read |
|---|---:|---:|---:|---:|
| Unlisted GPT / missing Codex model | 2.50 | 15.00 | 2.50 | 0.25 |
| Unlisted Claude / unidentified local model | 3.00 | 15.00 | 3.75 | 0.30 |
| Unlisted Antigravity model | 2.00 | 12.00 | 2.00 | 0.20 |

These are application estimates, not claims about an unknown model's actual rate or subscription charge. The dashboard labels cost as estimated. Approximation diagnostics do not create a user review task or permanently incomplete coverage. Real pending scans, read failures, and database failures remain visible operational states.

## Historical continuity and migration

Normal refresh preserves stored history. A missing source does not delete its totals. File truncation or prefix change freezes the current readable end, reconstructs parser state without charging that prefix again, then continues from subsequent appends. Parser upgrades likewise reconstruct context through the committed boundary without replacing historical aggregates. Physical generations distinguish genuine later usage from pre-rewrite counter values.

Schema 6 is the single active database model. The one-time schema 4/5 migration preserves buckets, identities, source boundaries, and retained detail. It removes old repair receipts and global date guards, extracts the prior fingerprint where present, and discards obsolete parser resume state. No legacy parser, dual-write path, or repair authorization remains in normal collection. Earlier supported schema migrations advance to this same model.

History protection is source/boundary based: another source on the same day is not blocked. Missing original detail cannot prove either exact historical correctness or a safe historical rewrite. Declared price revisions can correct derived costs from complete retained facts, but never change historical token quantities or infer missing detail. The explicit destructive Reset index action remains separate and rebuilds only currently available sources.

## Git output scope

Git output uses a separate ledger of committed local-branch activity. Its schema 3 tracked-repository directory persists repository identities, locators, and project keys independently of recent sessions. Migration retains existing daily rows, including temporarily unavailable or unresolved repositories. Resolving the common Git directory prevents multiple worktree paths from counting one repository twice.

Code Output, Trend net lines, and category breakdowns apply the same repository scope. Project exclusion is a reversible query filter; a selected scope with no repositories returns zero rather than all repositories. Removing an exclusion restores retained history. Scanning uses the configured local Git author email when available; human-authored commits are included and model/provider selection does not attribute Git output to a particular AI session.

## Architecture and bounded work

The path is provider discovery → one source scanner → `UsageSourceBatch` → transactional `DefaultUsageIndex` storage → source-attributed buckets and UI queries. Quantity decisions are made before extraction/pricing and are shared by all projections. This uses the existing SQLite index and its in-memory test counterpart, without another ledger or service.

Codex keeps a cumulative baseline, notification progress, generation/segment, and at most 128 recent observation keys. Claude retains at most 128 recent applied requests and 256 blocks per retained request. Persistent execution identities grow with distinct observed executions; they are not an in-memory history-matching buffer.

JSONL parsing resumes at the byte checkpoint. Prefix verification currently hashes the entire committed prefix, and writing the next checkpoint hashes its prefix too. Consequently a changed file can require roughly old-prefix plus new-prefix validation reads even when only its tail is parsed. This cost is measured separately with `onValidationBytesRead`; tail parsing does not imply overall O(new bytes) I/O. Rebase/bootstrap necessarily parses the bounded current file snapshot. No anomaly triggers a parent-log read or an unbounded similarity search.

## Validation map

`scripts/usage-accounting.test.mjs` covers cumulative/last divergence; contained cache/reasoning; unknown baselines; mixed record order and restart cuts; delayed details with new timestamps and unrelated output; fork prefixes without parents; own child execution; known replay and unknown regressions; physical generations; missing IDs/time/model/prices; bounded state; stable revisions/conflicts; schema 4/5 history preservation; protected seed promotion; account transitions; and operational coverage independent of approximation diagnostics.

The broader usage-index, provider, pricing, startup/readiness, and UI tests remain part of `npm test`. Snapshot replay and packaged-module smoke verification are delivery evidence, not a prerequisite involving users' personal repair data. Synthetic and sampled real-log tests do not prove every historical error is small or reconstruct all provider invoices.

## Quiet incremental updates

Once full discovery and history indexing have completed, bounded discovery retains that coverage. Ordinary appended records and newly discovered sources use the `updating` state and update totals silently without a history-indexing banner. Pending counts remain accurate. Initial discovery, explicit Reset index, and parser-version upgrade backlog use `incomplete` until complete. Read failures remain visible with a dedicated update-failure message; database health errors remain separate. A failure does not erase completed historical coverage, and successful recovery returns to quiet updating or complete.
