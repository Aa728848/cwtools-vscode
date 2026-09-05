# Agent Note: Subscription channel proxy

Status: implemented

## Problem

Codex subscription and Antigravity (Gemini OAuth) needed configurable proxy routing for OAuth and provider traffic, following the interaction in `dsh-chatgpt-subscription`.

## Decision

Added a shared auto/custom/direct proxy setting in both providers' AI settings. The machine-scoped mode uses user configuration; custom HTTP, HTTPS and SOCKS5 addresses, including authentication, live in SecretStorage. Status messages redact credentials. Auto detection prioritizes user-level VS Code `http.proxy`, proxy environment variables, then Windows/macOS manual system proxy settings with a five-second cache. PAC is not evaluated.

Both OAuth services and their completion paths receive one transport. Per-request Undici dispatchers preserve native fetch streaming and cancellation without changing the process-wide dispatcher. SOCKS5 uses the `socks` connector with remote destination DNS and Undici's normal TLS validation. Undici 6 retains compatibility with the extension's supported Node runtime. Configured proxy failures do not fall back to direct connections. Pool retirement waits for active streams and limits simultaneous old pools; extension disposal destroys owned pools.

## Alternatives considered

- A global dispatcher would also redirect unrelated providers and extension traffic.
- Plain settings URLs would expose authenticated proxy credentials in configuration and Webview state.
- The reference's HTTP-only ProxyAgent cannot implement SOCKS5 by accepting a SOCKS URL. The newer Undici SOCKS agent requires a newer Node runtime; the compatible connector avoids changing the VS Code support baseline.

## Consequences

The shared setting covers token exchange and refresh, model/account/quota queries, and chat. Changes affect subsequent requests. Browser sign-in keeps browser proxy settings and local OAuth callbacks stay on loopback. English and Chinese UI, settings descriptions and docs are synchronized.

Regression tests cover validation/redaction, detection precedence, secret persistence, invalid/missing proxies, real HTTP CONNECT and SOCKS5 routing, credential separation, streaming cancellation, in-flight configuration changes, and both providers' integration with API-key provider isolation. A local TLS smoke check also verified HTTP/HTTPS proxies and authenticated SOCKS5 against HTTPS targets using an ephemeral test CA. Compile, strict typecheck, targeted lint, docs generation and full unit/rules-sync tests were run; release validation includes the resulting package and bilingual catalogs.
