---
name: OpenCodex dashboard
description: Existing console styling with a scoped Usage Insights data palette.
colors:
  background: "light-dark(#ffffff, #212121)"
  surface: "light-dark(#ffffff, #262626)"
  rail: "light-dark(#f9f9f9, #171717)"
  foreground: "light-dark(#0d0d0d, #ececec)"
  muted: "light-dark(#6e6e6e, #a6a6a6)"
  border: "light-dark(#e6e6e6, #3d3d3d)"
  action: "light-dark(#0d0d0d, #ececec)"
  insights-data: "light-dark(#7765d7, #ac9af5)"
  insights-data-strong: "light-dark(#5944bb, #cabdfd)"
  insights-data-soft: "light-dark(#eeebfa, #342e46)"
  insights-data-muted: "light-dark(#c3b8ee, #6e5ea0)"
typography:
  body:
    fontFamily: '"OpenAI Sans", "Pretendard Variable", Pretendard, system-ui, sans-serif'
    fontSize: "14px"
    lineHeight: 1.5
  title:
    fontSize: "20px"
    fontWeight: 600
  label:
    fontSize: "12px"
  insights-number:
    fontSize: "28px"
    fontWeight: 600
    letterSpacing: "-0.03em"
rounded:
  panel: "12px"
  compact: "8px"
  control: "6px"
spacing:
  small: "8px"
  group: "16px"
  panel: "20px"
  section: "24px"
---

# Design System: OpenCodex dashboard

## Overview

The dashboard uses its existing monochrome console styling, shared sidebar, compact controls, flat content surfaces, and light/dark scheme tokens. This record describes the current implementation; CSS remains the source of truth. Usage Insights at `/#insights` adds a scoped violet palette for data visualization, while application actions retain the existing monochrome palette.

## Colors

Shared colors come from `gui/src/styles.css`. The four `insights-data` colors above come from the `.usage-insights` namespace in `gui/src/styles/usage-insights.css`; they are scoped to charts, ranking bars, calendar intensity, and chart focus. Prices use the existing semantic green token. Multicolor provider marks keep their artwork; the monochrome Grok mark adapts to dark mode.

## Typography

Use the existing `--font-ui` stack for interface text and `--mono` for model identifiers. Usage Insights numbers use tabular numerals. Summary values are 28px at full width, 24px below the 650px container breakpoint, and 23px below 400px. Supporting labels use the existing 12px token; controls use 13px.

## Layout

The existing shell has a 232px desktop sidebar and a default 980px main container. Usage Insights alone expands the main container to 1320px. Its summary strip has six columns, changing to three below 900px and two below 400px of available content width. Rankings are paired; panels stack below 650px. These thresholds are container queries, not viewport breakpoints. Content panels use 20px padding, reduced to 16px below 650px. Large history charts and calendars scroll within their own region.

## Elevation & Depth

Usage Insights panels use one-pixel shared borders and opaque surfaces. They do not add shadows. Existing shell and overlay elevation remain governed by the shared stylesheet.

## Shapes

Content panels and the summary strip use the existing 12px radius. Segmented controls use 8px groups and 6px buttons. Chart bars and calendar cells use small corners; horizontal ranking tracks use the existing pill radius.

## Components

The page combines existing buttons, notices, data-resource loading indicators, and authenticated fetch behavior with a six-metric strip, daily bar chart, provider/model ranking lists, Monday-first activity calendar, and token composition bar. Day selection links the chart, calendar, and rankings. Controls expose pressed states; chart dates use roving keyboard focus. Hover transitions use the existing 120ms token; reduced-motion preferences remove transitions. Unknown measurements remain unavailable, and coverage/pricing explanations accompany the values.

## Do's and Don'ts

- Reuse existing application tokens, locale catalogs, navigation, and loading/error states.
- Keep the violet data palette scoped to Usage Insights.
- Preserve numeric coverage and unknown-value semantics when changing charts.
- Keep model names in the existing code font, and ordinary labels in the UI font.
- Use existing provider artwork without recoloring multicolor marks.
