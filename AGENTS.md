# Repository formatting and tests

- Use Prettier with the checked-in configuration for supported text files; use `cargo fmt` for Rust and Ruff for Python.
- Format tracked project source, configuration, and documentation. Do not format generated output, lockfiles, binary/map data, build output, local scratch files, or Git submodules.
- Tests should assert observable behavior and domain invariants. Keep each test focused on one failure cause, use concrete exception types, and avoid unbounded waits or assertions about implementation members being absent.
- Reuse a small number of stable fixtures. Parameterize equivalent input cases; keep distinct contracts separate. Split large suites by behavior or owner when changes become difficult to review, without deleting meaningful cases to meet a line-count target.
- Run formatter checks, relevant tests, the application build, and `git diff --check` before delivery.
