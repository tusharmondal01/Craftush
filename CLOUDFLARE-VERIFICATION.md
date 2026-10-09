# v17 Cloudflare preparation verification

Validated locally on 9 October 2026 with Node 24 and Wrangler 4.149.0.

- Existing v17 regression suite and Cloudflare adapter checks: **128 passed**.
- Compiled Worker in Cloudflare's local runtime with real SQLite storage:
  **7 passed** (six checks and their parent integration test).
- Worker bundle: approximately **701 KiB**, about **150 KiB compressed**.

Checks cover correct and incorrect admin passwords, private credential handling,
saved model propagation, GitHub CORS preflight, isolated request bindings, large
Hindi/Unicode values, atomic storage rollback, API routing, team-code checks,
original Runware task IDs, usage updates and uploaded thumbnail retrieval. The
original suite also checks complete-sentence splitting, scene/image pairing,
narration alignment, transitions, Premiere packaging and ChatGPT task handoff.
Provider calls used fixtures and created no live Runware jobs.

Production deployment is **pending Cloudflare account access and secrets**.
The dashboard displayed “There was a problem with verification. Please reload
and try again.” Sign-in remained disabled after one refresh. No backend has been
created in that account, and the live GitHub frontend remains on its existing
pinned static release. Live sign-in and real provider generation are not yet
verified. The Pages publisher verifies the real backend before it can promote
this connected frontend.
