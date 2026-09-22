# Security and local-data policy

## Security model

AIT Planning Optimizer is a static application. Workbook parsing, validation, optimization, rendering and export generation occur on the user's device. There is no server-side application component and no authorized runtime destination for project data.

The public repository and bundled synthetic workbook contain fictitious data only. Operational workbooks and generated schedules must remain outside Git.

## Runtime controls

- Network operations are read-only and same-origin. The application uses `GET` only for bundled static assets, including the synthetic example and WebAssembly runtime.
- No workbook bytes, normalized records, schedules, diagnostics or exports are transmitted to an external origin.
- No analytics, telemetry, advertising, remote fonts, runtime CDN or external optimization service is used.
- Workbook and result state is held in memory only. The application does not write project data to Web Storage, IndexedDB, Cache Storage or a service worker.
- **Clear local data** aborts an active solve and removes the imported model, validation state and schedule from React memory. Refreshing or closing the page has the same effect.
- ZIP exports are assembled locally and downloaded through a temporary object URL that is revoked immediately after the download starts.
- The HTML Content Security Policy restricts scripts, Workers, connections, images and fonts to the application origin. It grants only the inline-style support required by the Gantt and `wasm-unsafe-eval` required to instantiate the bundled HiGHS WebAssembly module.
- `object-src` and form submission are disabled. Clickjacking protection requires an HTTP `Content-Security-Policy` or `X-Frame-Options` response header because `frame-ancestors` is not enforced from an HTML meta policy; GitHub Pages does not provide repository-defined response headers.

Automated tests exercise the fictitious example through validation and the real HiGHS solver while instrumenting network and browser-storage APIs. Tests fail on an external-origin request, a mutating HTTP method, a storage write or a missing final result.

## User responsibilities

- Open workbooks only from trusted sources. Spreadsheet parsers process complex attacker-controlled input.
- Do not commit operational workbooks or downloaded result bundles.
- Treat downloaded ZIP files according to the source project's information classification.
- Use HTTPS when the static application is hosted.
- Clear local data or close the tab when work is complete, especially on a shared workstation.

## Known residual dependency risk

The browser build uses SheetJS `xlsx` 0.20.3 from the project's authoritative distribution tarball because the public npm registry is limited to the vulnerable 0.18.5 release. Version 0.20.3 includes the fixes for [GHSA-4r6h-8v6p-xvw6](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6) and [GHSA-5pgg-2g8v-p4x9](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9). The tarball URL and integrity digest are pinned in `package-lock.json`; it is a build-time dependency and is bundled into the same-origin production assets, not loaded from a runtime CDN. Workbooks must still come from trusted sources because spreadsheet parsers process complex attacker-controlled input.

The remaining Vitest advisory affects development tooling rather than the deployed runtime and currently requires a major-version test-runner upgrade. It must be reassessed before the next dependency-maintenance release.

## Dependency and publication checks

Before publication:

```bash
cd web
npm ci
npm test
npm run build
npm audit
cd ..
python scripts/check_public_data.py --root .
```

Review dependency advisories rather than applying forced major upgrades automatically. A security update must preserve the workbook validation and Python-oracle parity tests.

## Reporting a vulnerability

Do not open a public issue containing a real workbook, generated schedule, credential, internal identifier or reproduction data derived from an operational project. Report the minimum reproducible case using fictitious data through a private channel agreed with the repository owner.

If sensitive material is committed, assume it has been copied. Remove it from the current tree, rewrite repository history where required, and rotate exposed credentials before further publication.
