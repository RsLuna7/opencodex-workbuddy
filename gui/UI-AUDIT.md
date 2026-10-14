# Dashboard UI audit — 2026-10-02

The dashboard already has a coherent light/dark palette, role-based typography,
shared controls, responsive workspace layouts and translated copy. The main
consistency problems are consumers bypassing those existing rules.

## Findings and implemented repair plan

| Priority | Finding and impact | Repair | Status |
| --- | --- | --- | --- |
| P1 | Remote device removal suppresses the keyboard focus outline. Keyboard users cannot reliably locate the focused action. | Preserve the outline and explicitly style `:focus-visible`. | Fixed |
| P2 | Provider usage tables use undefined `--font-mono` and `--font-sans`, falling back to different browser fonts. | Use `--font-code` for identifiers/numbers and `--font-ui` for attribution; align sizes and weights with existing roles. | Fixed |
| P2 | The remote message composer references an undefined font, and the later `textarea.input` rule overrides its intended prose font. | Use `--font-ui` with a selector specific enough to survive the cascade. Keep JSON/code editors monospaced. | Fixed |
| P2 | Storage help/metadata and remote section headings use undefined size variables. | Map dense help/metadata to `--text-control` and section headings to `--text-subtitle`. | Fixed |
| P2 | API-key labels, usage metadata and active provider catalog tabs use undefined color variables. | Use existing `--muted`, `--text` and `--red` semantic colors. | Fixed |
| P2 | Provider warning states use the same bright yellow fallback in both themes. Usage table backgrounds/borders use independent gray fallbacks. | Use theme-aware `--amber`, `--hover`, `--raised` and `--border-soft`. | Fixed |
| P2 | Models rail hover/selection backgrounds reference an undefined surface token, dropping visual state feedback. | Use `--raised-hover` and `--raised`. | Fixed |
| P2 | Device removal has a 30px target on touch devices. | Use the existing 44px touch token on coarse pointers. | Fixed |
| P3 | Provider JSON editor carries an independent font stack, and usage detail columns have rigid minimum content widths. | Reuse the code font; allow detail columns and long attribution text to wrap. | Fixed |

The repair order was: inspect existing roles and cascade → reproduce font/focus
failures in Chromium → correct consumers of shared tokens → add regression
checks → build and verify the resulting CSS. No new font assets or dependencies
were introduced, and no routing, configuration or visible copy was changed.

## Verification and limits

- 31 focused tests passed across token references, provider usage attribution,
  remote workspace, storage metadata, provider catalog search and API-key layout.
- GUI TypeScript/bundler build and GUI lint passed.
- Structure documentation checks, privacy scan and `git diff --check` passed.
- Chromium checked built CSS at 375px and 1280px in both themes: model and JSON
  font roles, prose and attribution font roles, actual keyboard Tab focus,
  coarse-pointer touch targets and fixture overflow all passed.
- Browser captures are isolated representative markup using the real dashboard
  stylesheet, not screenshots of a running account-connected dashboard. No
  management API, credentials or user configuration were accessed.
- This pass inspected dashboard CSS and representative consumers. It does not
  certify every interactive flow or full WCAG conformance.
- Representative narrow-screen captures: [light](ui-audit-evidence/light-375.png)
  and [dark](ui-audit-evidence/dark-375.png).
- The mechanical detector reported an existing 2px left border on remote chat
  messages. It distinguishes message/error roles; it is not a new card decoration
  and was retained within the existing visual language.

## Maintenance recommendations

1. Use the existing font/size/color roles in new components. Run
   `bun test tests/design-token-references.test.ts` from `gui/` to catch undefined
   CSS references. The test excludes references with intentional CSS fallbacks.
2. Rerun the offline Chromium regression after changing typography, input styles
   or remote controls: build the GUI, then set `CHROME_BIN` to a Chrome/Chromium
   executable and run `bun tests/ui-consistency-browser.ts`. Captures and measured
   results go under `gui/.tmp/ui-consistency-browser/` by default.
3. The build reports a 3.57MB JS bundle (974KB gzip), and `App.tsx` eagerly imports
   pages. A separate performance pass should measure startup and consider lazy
   page/locale loading with localized loading/error states and navigation tests.
   This is a recommendation, not a claim that startup timing was measured here.
4. The base body size is 14px with 10–11px micro/caption roles. Review prolonged
   reading surfaces and 200% zoom before increasing dense table labels globally;
   reserve the smallest roles for genuinely secondary compact metadata.
5. The shared font stack relies on installed fonts. If identical glyph rendering
   across operating systems is required, choose licensed self-hosted UI/CJK fonts
   and verify loading/reflow and language coverage as a separate asset change.
