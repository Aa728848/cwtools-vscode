# Rust LSP benchmarks

The production soak harness stages the selected standalone Rust executable in an isolated directory, then exercises initialize/initialized/shutdown/exit, open/full-edit/range-edit/save/close, mixed LSP queries, cancellation, and deterministic restarts. RSS is sampled from the server PID (`tasklist` on Windows or `ps` elsewhere), never from Node. Reports include repository and artifact identity, counters, RSS growth analysis, and explicit pass criteria.

Smoke run:

    npm run soak:rust-smoke

After every non-long-running acceptance gate passes on a clean repository, run the final lane for exactly 1440 minutes:

    npm run soak:rust-24h

Verify the completed final report:

    npm run soak:rust-verify

The final verifier requires a clean repository identity, a staged standalone Rust artifact, at least 1440 elapsed minutes, clean lifecycle/restart/cancellation accounting, no deadlock, timeout, orphan, protocol error, unexpected exit, or sustained RSS growth. Run the final lane only after `npm run verify`, `npm run check:rust-only`, package inspection, and all other non-long-running acceptance gates pass. Generated reports remain outside version control unless intentionally reviewed.
