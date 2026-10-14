# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

OpenCodex operators who configure LLM providers and inspect their proxy activity.

## Product Purpose

OpenCodex is a Bun-native local provider proxy for Codex and Claude Code. Its existing React management dashboard configures the proxy and exposes operational data.

## Capabilities and Constraints

The Usage Insights page analyzes requests recorded by the OpenCodex proxy. The user explicitly selected proxy data as the scope. Client-local conversation history, project attribution, session duration, and skill usage are outside this page's available data.

The dashboard supports ten locales, light and dark themes, connected hub scopes, keyboard navigation, and mobile layouts. New surfaces reuse the existing authentication and data-resource layers. Costs are API list-price estimates, not receipts. Unknown measurements and partial histories must remain visible.

## Evidence on Hand

The user's reference image shows a compact usage dashboard with a summary strip, purple trend bars, rankings, and an activity grid. The existing usage API supplies totals, daily aggregates, model/provider breakdowns, pricing coverage, and positive incomplete-history diagnostics.

## Product Principles

- Base displayed measurements on actual proxy data.
- Explain pricing and measurement coverage alongside results.
- Support exploration without changing proxy configuration.
- Preserve existing dashboard workflows and navigation.
