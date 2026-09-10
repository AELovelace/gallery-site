# LiDOLL gallery contributor instructions

This repository contains only the LiDOLL photo/video gallery. The GameMaker
project and main website index live in a separate repository. Keep the owner
login, collection API, and uploaded data independent of the game/editor.

- Preserve the plum/pink palette and decorative rails in `web/gallery/theme.css`.
  That file is a snapshot of the main site's theme; gallery deployment must not
  depend on a stylesheet served by the game host.
- Keep inline comments explaining substantial functions and authentication or
  storage behavior. Use `textContent` for user-authored titles and captions.
- Content management requires owner authentication, same-origin checks and CSRF.
  Public view/like endpoints accept anonymous sessions with signed visitor cookies,
  and must still enforce same-origin and CSRF checks; this grants no editing rights.
  Keep credentials, uploads and SQLite outside the public web directory and Git.
- Put Python scripts in `python/`, PowerShell scripts in `ps/`, and Fedora Bash
  deployment scripts in `server/gallery/fedora/`.
- Update `README.md`, `FEDORA.md` and the service/config templates when deployment
  behavior changes. The production origin is `https://lidoll.dev`, the gallery
  host is `10.1.1.23:8787`, and the nginx proxy is `10.1.1.20`.
- Run API tests for backend changes. Run the browser test for visitor/owner-flow
  changes. Check Bash syntax and rebuild the tarball for deployment changes.
- Do not push, publish, or change either live server without user authorization.
