# LICENSE — recommendation & options (for the maintainer's final call)

> **Status:** The repo currently ships a permissive **MIT License** (`/LICENSE`,
> `Copyright (c) 2026 knofler`). This document exists so the licensing choice is
> a deliberate decision, not an accident of scaffolding. Pick one, then (if you
> change it) replace `/LICENSE` and update the reference in `dashboard/src/app/terms/page.tsx`.

Trust pack context: a buyer evaluating myAI before paying will look for (1) a
clear license on the code, (2) a privacy policy, (3) terms of service, and (4) a
data-locality/security statement. The last three now live at `/privacy`,
`/terms`, and `/security`. This file covers (1).

---

## TL;DR recommendation

| If your goal is… | Choose | Why |
|---|---|---|
| Maximum adoption, contributions, and "just use it" | **MIT** (current) | Shortest, most familiar, zero friction. Best for a self-hosted OSS tool that monetises via a hosted tier + support. |
| Same, but with an explicit patent grant + contributor protection | **Apache-2.0** | Permissive like MIT, adds a patent license and a NOTICE mechanism. Slightly heavier but enterprise-friendly. |
| Protect against a cloud provider reselling your hosted service | **BUSL-1.1** (source-available, converts to Apache after N years) | Keeps the code open to read/self-host while blocking commercial competing hosting until it converts. |
| Open core with a paid commercial edition | **AGPL-3.0 + commercial dual-license** | Copyleft deters closed forks; sell exceptions to companies that can't accept AGPL. |

**Default recommendation: keep MIT.** myAI's moat is the hosted convenience,
the brain/continuity data, and support — not code secrecy. MIT maximises trust
and adoption, and the trust pack (privacy/terms/security) already carves out the
commercial surface. Only move to BUSL/AGPL if a competitor cloning your *hosted*
offering becomes a real risk.

---

## Option A — MIT (current, recommended)

Already in `/LICENSE`. Nothing to do. Permissive, ~170 words, universally
understood. Downside: someone could offer a competing hosted myAI. Given the
architecture (customers self-host and own their data), that risk is low.

## Option B — Apache License 2.0 (permissive + patent grant)

Draft: use the canonical text from <https://www.apache.org/licenses/LICENSE-2.0.txt>
verbatim as `/LICENSE`, add a `NOTICE` file:

```
myAI
Copyright 2026 knofler

This product includes software developed by knofler.
```

Add the standard header to source files if you want strict compliance. Choose
this if enterprise buyers ask for an explicit patent license.

## Option C — Business Source License 1.1 (source-available)

Draft the parameters block (the rest is the standard BUSL-1.1 text from
<https://mariadb.com/bsl11/>):

```
Licensor:             knofler
Licensed Work:        myAI (this repository)
Additional Use Grant: You may use the Licensed Work for any purpose other than
                      offering a commercial, hosted "myAI"-equivalent service to
                      third parties.
Change Date:          Four years from each release's publication date
Change License:       Apache License, Version 2.0
```

Source stays open to read and self-host; competing commercial hosting is barred
until the Change Date, when each release auto-converts to Apache-2.0. This is
the "protect the hosted business without going closed" option.

## Option D — AGPL-3.0 + commercial dual license

Put the GNU AGPL-3.0 text (<https://www.gnu.org/licenses/agpl-3.0.txt>) in
`/LICENSE`, and offer a separate commercial license for buyers who cannot accept
copyleft. Strong deterrent to closed forks; heaviest compliance burden and can
scare off some permissive-only shops. Only worth it with an open-core strategy.

---

## Checklist if you change the license

1. Replace `/LICENSE` with the chosen text (add `NOTICE` for Apache).
2. Update the license link/wording in `dashboard/src/app/terms/page.tsx` §1.
3. Update `package.json` `"license"` fields (root + `dashboard/`) to the SPDX id
   (`MIT` / `Apache-2.0` / `BUSL-1.1` / `AGPL-3.0-only`).
4. Note the change in `CHANGELOG.md` and the handoff.
5. If moving *away* from a permissive license, confirm all contributors agree
   (or that you hold the copyright) — you cannot unilaterally relicense others'
   contributions.
