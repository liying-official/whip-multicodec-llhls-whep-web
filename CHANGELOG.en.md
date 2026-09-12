# v1.35 · fix10 update summary

English | [简体中文](CHANGELOG.md)

- Fix credential deletion after failed or unconfirmed stops; retain default stop, explicit preserve and deployment ownership checks.
- Validate required metadata types before packaging reads, rejecting FIFOs/symlinks while preserving SHA regeneration and the strict managed-file list.
- Replace a real public address remaining in tests with a documentation address; exclude deployment certificates/private keys, runtime data and detailed local records.
- Add stop-authorization and packaging regressions. Player logic, weak-network policy, dependencies and all six binaries remain unchanged.

Validation: targeted regressions, Go/JS and installation-trust checks, manifests and reproducible packaging passed. Detailed Chinese/English records remain local.

Known limits: manual WHEP may rebuild its session shortly after switching; the trigger remains unconfirmed and this candidate does not change that player logic. See [security notes](SECURITY.txt) for dependency advisories. This publication is not a full production-suitability certification.
