# Agent Rules — devops-projects

Source: adapted from zulhardy/infrastructure-agents-guide
(Ch 5 Credential Management, Ch 7 Change Control, Ch 8 Policy & Guardrails, Ch 13 Risk Framework),
the same rules as the homelab repo (zulhardy-lab/homelab).

These rules are the *prompt-level* layer. The guide treats this layer as the weakest one,
so each rule is also enforced structurally where possible (see "Enforced by").

## Purpose

- This repo holds **mini DevOps projects** (e.g. `apps/hpa-demo`) for learning and showcasing skills. PUBLIC repo.
- They are built and tested on GitHub-hosted runners and deployed to the **homelab** (k3s on ops01 / dev01 / prd01),
  through the homelab's shared self-hosted runner on ops01.
- The homelab itself (VMs, k3s, OpenBao, Ansible, the runner, **onboarding of apps**) lives in
  **zulhardy-lab/homelab**, not here. This repo can only **deploy** apps that the homelab has onboarded.
- The group capstone project is **not** here either: it has its own repository and its own CLAUDE.md.

## Autonomy level

- Level 1: PROPOSE. The agent writes code and opens pull requests. The repo owner merges.
- The agent never merges, deploys, or runs commands on the VMs.

## Hard rules — NEVER violate these

1. NEVER push directly to `main`. ALWAYS create a new branch per change.
   - Enforced by: GitHub ruleset on `main` (PR + passing checks required).
2. NEVER run commands on the VMs or the Hyper-V host. Changes reach the VMs only through merged PRs executed by the
   runner, or through steps the repo owner runs.
   - Enforced by: the agent holds no SSH keys, passwords, or runner tokens.
3. NEVER merge or approve a pull request or a deployment, or change rulesets, environments or repository settings.
   - Enforced by: the scope of the GitHub token the agent is given. The ruleset on `main` requires 0 approvals,
     so the ruleset alone does not block a merge.
4. NEVER store, request, print, or commit credentials (SSH private keys, passwords, runner tokens, PATs, `.env` files
   with secrets). The repo owner enters every secret.
   - Enforced by: `.gitignore`; secret scanning / push protection on the repo; Trivy secret scan on every PR.
5. The self-hosted runner (ops01) may ONLY be used by workflows triggered by `push` to `main` or `workflow_dispatch`.
   NEVER target it from `pull_request` or `pull_request_target` workflows. PR checks run on GitHub-hosted runners.
   - Enforced by: repo setting "Require approval for all outside collaborators" for fork PR workflows; OpenBao only
     accepts this repo's `apps.yml` on `main`.
6. NEVER commit anything that should not be public: secrets, real passwords, personal data.
7. NEVER modify files outside `apps/`, `scripts/` and `docs/`. `.github/workflows/` only on an explicit request from
   the repo owner.
8. NEVER try to onboard an app from this repo (create namespaces, accounts, RBAC or OpenBao roles). Onboarding is a
   platform change: propose it as a PR in zulhardy-lab/homelab (its `homelab_apps` list) when asked.
9. NEVER open a ready-for-review PR until lint checks have run. If they don't pass after 10 iterations, open a DRAFT
   PR titled `[not converged]` and NEVER describe it as a fix.
10. Anything irreversible — deleting data, volumes, namespaces, images, users, or keys — is done by the repo owner.
11. When something is unclear, STOP and ask. Fail safe, not fail open.

## Every pull request must include

- Summary: what changed and why
- Changes: list of files
- Validation: lint / test / scan results
- Impact: which environment(s) (DEV on dev01, PRD on prd01) are affected and what will change there
- Anything destructive, called out explicitly at the top

## Conventions

- One folder per project under `apps/<name>/` (layout in [README.md](README.md#adding-a-project)).
- Image builds, tests and scans run on GitHub-hosted runners, not on the VMs. Docker is not installed on the VMs.
- Pipeline logic lives in `scripts/`; workflow YAML stays thin.
- Pin versions (action commit SHAs, base images by digest, tool binaries by checksum). No `latest`.
- Images: `ghcr.io/zulhardy-lab/<app>:sha-<commit>`.
- Branch naming: `feat/<short-name>`, `fix/<short-name>`, `chore/<short-name>`

## Skills, MCP servers, and third-party code

- Vendor-official sources only, pinned to a version or commit hash.
- Review files before installing. Nothing that fetches remote URLs at runtime or asks for static keys.

## Emergency stop

- The repo owner disables GitHub Actions for this repo, and/or stops the shared runner on ops01
  (`sudo systemctl stop 'actions.runner.*'`; this also stops the homelab repo's pipelines).

## Behavioral guidelines

Guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.
If anything here conflicts with the Hard rules, the Hard rules win.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.
Judgment applies to these guidelines only, never to the Hard rules.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified, up to the 10-iteration limit in the Hard rules.**

For the agent, "verified" means lint / syntax checks and the PR checks on GitHub-hosted runners.
It never means running anything on the VMs.

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication,
and clarifying questions come before implementation rather than after mistakes.
