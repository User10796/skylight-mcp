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
