# KIT.md — Application Setup and Evidence Kit

**Status:** discovery-first. Do not infer app capabilities from its name or AI Studio link.

## Read first
- `README.md`
- `package.json`, lockfile, source entry points and tests
- environment/deployment configuration and licence

## Requirements artefacts
Before changing code, record the user problem, one testable journey, inputs/outputs, dependency and API requirements, failure behaviour, privacy boundary, expected cost, and acceptance criteria.

## Setup
The README describes Node.js, `npm install`, a local `.env.local` containing `GEMINI_API_KEY`, and `npm run dev`. Confirm runtime and script definitions before running commands. Use a compatible free environment if available. Do not commit credentials or expose keys in browser code.

## Procedure
1. Inspect dependencies and scripts.
2. Check `.gitignore` and key references.
3. Install using the available lockfile and start the app.
4. Test the primary path and invalid/empty/network-failure cases.
5. Capture expected versus actual output and console/network errors.
6. Record any external-service price, rate limit or data transfer.
7. Provide setup, reset and known-issues notes.

## Acceptance
- [ ] A real feature is identified from evidence.
- [ ] Setup can be repeated from a clean environment.
- [ ] Test results are actual, not assumed.
- [ ] API costs, limits and data handling are documented.
- [ ] Secrets are not exposed.
- [ ] No unrelated files or history are overwritten.