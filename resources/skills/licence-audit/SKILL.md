---
name: licence-audit
description: "Audit the licences of what ships: dependencies, vendored files, installer parts. Use when releasing or adding assets."
metadata:
  audience: agents
---

# Licence audit

An audit that reads only the package manager's licence fields misses most of what ships: files vendored inside packages, fonts and icons, what the installer adds. Inventory what actually ships, read each licence from its own files, and put every call that isn't plainly fine to the user. The project's own notes (a RELEASING or CONTRIBUTING file) say where its notices live and how they are built.

## 1. Inventory what ships

- **Runtime dependencies** and their transitive ones (not dev tools, test runners or build-only packages: check what the build bundles or copies).
- **Front-end libraries** bundled into the app, which a runtime dependency list can leave out.
- **Vendored material inside packages**: read each package's `LICENSE`, `NOTICE` and `ThirdPartyNotices` files, not only its declared licence. An editor, icon set or compiler often carries other people's work under other terms.
- **Assets**: fonts, icons, images, sounds, data files.
- **What the installer or packager adds**: inspect the built installer or package (its plug-ins, helpers, runtimes), not just its configuration.
- **Runtime binaries** shipped with the app (a browser engine, an interpreter, native modules).

## 2. Identify each licence

- From the files themselves: the licence text, headers in the source, the notices file.
- **Dual licences**: note which one the project takes, and why.
- **Conflicts**: a `LICENSE` that says one thing and a source header or the package metadata another. Record both, with where each is.
- **Missing or unclear**: no licence, "freeware", "see website", a custom text. These are findings, not gaps to fill with a guess.

## 3. Classify and flag

- **Clearly permissive** (MIT, BSD, ISC, Apache-2.0, zlib and the like): fine; Apache-2.0 and others may require their NOTICE to be carried.
- **Anything else** (copyleft such as GPL, LGPL or MPL; attribution licences such as CC-BY; custom, unclear or missing): **flag it for the user** with the facts (what, where it ships, the licence, what it requires) and a recommendation.
- Never replace, remove or downgrade a dependency without asking: the call is the user's.

## 4. Record and regenerate

- Each call the user makes goes on the card as a decision (their words).
- Regenerate the project's third-party notices with its own command, and check they cover what ships, the vendored material and installer parts included.

## 5. Report

A table, one row per component: **component**, **version**, **licence** (as found, with the file), **where it ships**, and **the call** (fine, flagged, the user's decision). Below it, the flags with your recommendation, and what you couldn't determine.
