# Agent Valley terminology

## 1. Visual Theme & Atmosphere

Preserve the current dashboard. This change standardizes role names and configuration terminology for repository operators.

| Responsibility | Product name |
|---|---|
| Goal ownership and supervision | Chief Director |
| Cost, stack, dependencies, reuse, and maintenance | Technical Director |
| Promotion, monetization, and ROI | Marketing Director |
| Usability, design exploration, and user testing | Design Director |
| Assigned execution and independent review | Actor |

Use `av.yaml` for project configuration and `av.example.yaml` for its example.

## 2. Color Palette & Roles

Retain the existing Tailwind gray surfaces, white and gray text, blue focus indicators, green status indicators, and viewport accent `#6366f1`. This terminology change introduces no color tokens.

## 3. Typography Rules

| Role | Font | Size | Weight | Line Height | Letter Spacing | Features | Notes |
|---|---|---|---|---|---|---|---|
| Panel title | Existing inherited stack | Existing `text-sm` | Existing bold | Existing | Existing | None added | Use Active Actors |
| Status and controls | Existing inherited stack | Existing | Existing | Existing | Existing | None added | Keep current semantic controls |
| Identifiers | Existing monospace stack | Existing | Existing | Existing | Existing | None added | Preserve saved IDs |

Retain the installed system font stack and CJK fallbacks. Do not add font packages.

## 4. Component Stylings

Replace product role and execution labels in place. Keep control dimensions, variants, padding, radii, keyboard handling, focus indicators, and accessible names consistent with visible labels. Agent Valley and native vendor terminology remain integration identifiers.

## 5. Layout Principles

Keep the existing dashboard layout and CLI step order. Full role names may wrap as text; do not introduce fixed widths or shrink labels to fit. Preserve existing responsive containers.

## 6. Depth & Elevation

Retain existing surfaces, borders, stacking order, drawers, and shadows. No new visual tokens or elevation levels are required.

## 7. Do's and Don'ts

- Use Chief Director, Technical Director, Marketing Director, Design Director, and Actor in product copy.
- Keep each director's existing personality and responsibilities.
- Use only `av.yaml` for project configuration reads, writes, diagnostics, and watching.
- Preserve profile aliases and saved mission fields without resetting execution.
- Protect `av.yaml` from accidental inclusion in worktrees, skills, or actor access.
- Preserve native vendor protocols, managed `.agents` definitions, and Agent Valley branding.

## 8. Responsive Behavior

Apply label changes to the existing mobile, tablet, and desktop layouts. Preserve wrapping, truncation of identifiers, and keyboard-accessible controls. This change has no new layout, motion, image, or touch target design.

## 9. Agent Prompt Guide

- Name the goal supervisor Chief Director.
- Name the cost and engineering adviser Technical Director.
- Name the revenue adviser Marketing Director.
- Name the usability adviser Design Director.
- Name team members Actors, including execution and independent review roles.
- Expose Actor terminology in CLI help and actor profiles; keep legacy inputs readable.
- Use the existing dashboard tokens and component styling. Do not redesign the dashboard during terminology implementation.

## Workflow audit

1. Setup: context established from the user's explicit names and the current product; Preserve mode.
2. Extraction: local dashboard and CLI audit; no external reference branch.
3. Enhancement: filename, role, profile, compatibility, and protection acceptance criteria recorded in `.design-context.md`.
4. Proposal: use the explicit full English role names supplied by the user.
5. Generation: terminology guidance above; existing visual tokens retained.
6. Audit: responsive and accessibility behavior must be preserved; naming consistency and actionable config errors verified during implementation. No visual redesign is claimed.
7. Handoff: implement the naming changes across configuration, CLI, dashboard copy, prompts, and reports; verify the single project filename and saved mission resume.
