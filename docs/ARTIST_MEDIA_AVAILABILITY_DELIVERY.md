# Artist media and availability API delivery

Date: 29 August 2026

This release adds the narrow authenticated contracts used by the lightweight bndy artist profile:

- `GET /api/artists/{id}/profile` for an active artist owner/admin to read private editable settings.
- `PATCH /api/artists/{id}/profile` for whitelisted public profile, media and availability settings.
- `GET /api/artists/{artistId}/availability` for saved availability and booked-date conflicts.
- Public availability remains on `GET /api/artists/{artistId}/public-availability`.

Public artist reads redact booking phone and WhatsApp details while availability publishing is off. YouTube, Spotify, SoundCloud and Bandcamp links are supported.

The feature consumes active memberships established by Claim V2. It does not change claim evidence, review, relationship creation or ownership conflict handling.

Verification completed before merge:

- 170 artist Lambda tests passed.
- 229 events Lambda tests passed.
- Deployment validation and route verification passed.

Source pull request: #61.