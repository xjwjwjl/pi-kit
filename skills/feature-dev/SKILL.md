---
name: feature-dev
description: "Structured feature development workflow covering requirements, codebase exploration, architecture design, implementation, and review. For multi-file changes, new modules, complex integrations, or features with architectural decisions. Trigger: 新功能开发, feature-dev, 功能设计, 架构设计, feature development."
---

# Feature Dev

Pi adaptation of Anthropic's feature-dev plugin: the multi-agent workflow is converted into a **single-agent, sequential, multi-pass workflow**.

## Boundary

This skill guides feature development. It does not edit code until Phase 5 (Implementation). Each phase must complete before the next begins. Do not skip Phase 3 (Clarifying Questions).

## Pi-specific behavior

- Pi has no subagents. Run exploration/design/review as sequential passes with different lenses.
- Use `codegraph` (via the codegraph skill) for codebase exploration when available.
- Use `code-review` skill for Phase 6 quality review when available.
- Use project-specific skills (e.g., `autosync-api`, `autosync-menu`) when their conventions apply.
- Track progress with TodoWrite. One task per phase.

## Workflow

### Phase 1: Discovery

Goal: understand what needs to be built.

- Parse the feature description. If vague, ask ONE round of clarifying questions: scope, constraints, success criteria, affected user flows.
- If the description is already clear, restate your understanding and confirm before proceeding.
- Mark Phase 1 complete only when you and the user agree on what to build.

Output: one-paragraph feature summary. No code yet.

### Phase 2: Codebase Exploration

Goal: understand existing patterns, related code, and architectural context.

1. If `codegraph` is available: run `codegraph sync`, then use `codegraph explore "<feature keywords>"` and `codegraph callers/callees` on related symbols.
2. If codegraph unavailable: use `grep` to find related files, then `read` key files.
3. Read at minimum: similar existing features, routing/entry points, data models, service layer patterns, and project conventions (AGENTS.md, .pi/ files).
4. Identify: naming conventions, file layout, DI patterns, error handling style, test placement.

Output:
- List of key files that inform the implementation (with paths)
- Summary of conventions and patterns to follow
- Architecture notes: layers, data flow, dependencies

### Phase 3: Clarifying Questions

Goal: resolve ALL ambiguity before designing. **Do not skip this phase.**

Identify underspecified aspects:
- Edge cases and error states
- Integration points with existing code
- Backward compatibility requirements
- Data validation rules
- Authorization/permission boundaries
- Performance or scale expectations

Ask concise, specific questions. Group related questions together. Wait for user answers before proceeding. If the user says "just build it," flag at least the top 2-3 risks and confirm they accept them.

### Phase 4: Architecture Design

Goal: design the approach before coding.

Since Pi has no subagents, run three sequential design passes:

1. **Minimal Changes Lens**: Smallest diff. Maximum reuse of existing patterns. Fewest new files. What's the simplest thing that works?
2. **Clean Architecture Lens**: Best maintainability. Clear separation of concerns. Testable design. What would a principled approach look like?
3. **Pragmatic Balance**: Weigh speed vs quality for this specific feature. Recommend one approach with rationale.

Output:
- Brief summary of each approach (2-3 sentences each)
- Comparison table: files touched, complexity, risk, maintainability
- **Recommendation** with reasoning
- Wait for user to approve before Phase 5

### Phase 5: Implementation

Goal: build the feature.

1. Read all files identified in Phase 2 that you haven't read yet.
2. Follow the chosen architecture from Phase 4.
3. Follow all project conventions identified in Phase 2.
4. Implement incrementally: data models → service logic → API/UI → wiring.
5. Use TodoWrite to track sub-steps.
6. After implementation, verify: does it compile/run? Are new files registered correctly?

Rules:
- Match existing code style exactly (error handling, naming, imports).
- Do not refactor unrelated code.
- Do not introduce new patterns or dependencies unless explicitly approved.

### Phase 6: Quality Review

Goal: find and fix issues before declaring done.

1. If `code-review` skill is available: load and execute it on the diff.
2. Otherwise, run three sequential review passes:
   - **Simplicity/DRY**: Any duplicated logic? Over-engineered abstractions? Dead code?
   - **Bugs/Correctness**: Null access, missing error handling, edge cases, race conditions.
   - **Conventions**: Does the new code match project patterns from Phase 2? Correct file locations? Proper registration?

Output:
- List of findings with severity (Critical / Important)
- Ask user which to fix
- Fix approved items, re-verify

### Phase 7: Summary

Goal: document what happened.

Output:
- What was built (one sentence)
- Key architectural decisions and why
- Files added, modified, and deleted
- New dependencies or configuration changes
- Suggested next steps (tests to write, docs to update, follow-up features)

## Red flags

- Skipping Phase 3: the #1 cause of rework. Always ask clarifying questions.
- Designing in isolation: always read existing code before designing.
- Over-engineering: prefer the minimal approach unless the user explicitly asks for more abstraction.
- Phase 5 without approval: always get explicit confirmation before implementing if the architecture is non-trivial.

## Interaction with other skills

- **codegraph**: preferred for Phase 2 codebase exploration
- **code-review**: preferred for Phase 6 quality review
- **autosync-api / autosync-menu**: use in Phase 5 when adding new Gin routes or menus
