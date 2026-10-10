# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Chore series tools**:
  - `get_chore_series` — lists recurring chores one row per series (with series ID, assignee, repeat rule, next dates) and flags one-off chores that were copied by hand.
  - `create_rotating_chore` — creates weekly rotations (e.g. two kids alternating weeks) as a handful of every-N-weeks series (`FREQ=WEEKLY;INTERVAL=N`), so a rotation is no longer one chore per week.
  - `delete_chore_series` — removes a whole series in one call using `apply_to=all` (the same request the Skylight app sends), plus matching one-off copies; or ends a series as of a date by adding `UNTIL` to its RRULE, keeping completed history. Previews by default; requires `confirm: true`.
- New endpoint wrappers matching captured app traffic: `POST /chores/create_multiple`, `DELETE /chores/{instanceId}?apply_to=all`, flat-body `PUT /chores/{seriesId}`.

### Fixed

- **Login**: Skylight retired `POST /api/sessions` (it now returns "This version of Skylight is no longer supported"). Email/password login now uses the Rails form + OAuth code flow the mobile app uses, with `Authorization: Bearer` and a `skylight-api-version` header on API calls. Expired tokens are refreshed automatically, falling back to a full login.
- **Plus detection**: the new login doesn't report the subscription, so Plus is detected by probing the rewards endpoint. Override with `SKYLIGHT_PLUS=true|false`.
- **create_chore** now uses `POST /chores/create_multiple` (the old endpoint returned HTTP 422; same fix as upstream PR #26). `update_chore` sends the flat body the Skylight app uses.
- Empty response bodies (e.g. from deletes) no longer cause JSON parse errors.
- **Chore status**: Skylight reports finished chores as `complete` (lists use `completed`). `get_chores` with `status: "completed"` now returns finished chores, and `update_chore` sends `complete` when marking a chore done.

## [1.1.7] - 2025-12-30

### Fixed

- **Authentication**: Fixed email/password authentication to use correct `Basic base64(userId:token)` format instead of `Bearer token`. The Skylight API requires the user ID and token to be combined and base64-encoded for Basic auth.
- **Calendar Events**: Fixed `get_calendar_events` returning no events when querying a single day. The API treats `date_max` as exclusive, so we now add 1 day to ensure events on the end date are included.

### Changed

- Added debug logging for authentication flow to help troubleshoot login issues
- Added automatic retry on 401 errors for email/password auth (attempts re-login once before failing)

## [1.1.6] - 2025-12-29

- Initial public release
