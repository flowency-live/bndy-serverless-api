# BNDY SAM Route Inventory

Generated: 2026-08-02T15:56:08.834Z

> Baseline only. This report does not change production behaviour. A missing event-level authorizer is reported from the SAM declaration; handler-level checks require separate review.

## Summary

- Total routes: 199
- Mutation routes: 123
- Mutation routes without a declared event authorizer: 123
- HTTP routes containing /mcp: 6
- Duplicate method/path declarations: 0

## Routes

| Method | Path | Resource | Event | Declared authorizer | Baseline zone | Risk |
|---|---|---|---|---|---|---|
| GET | `/api/artists` | ArtistsFunction | GetAllArtists | None | public-read-review-required |  |
| POST | `/api/artists` | ArtistsFunction | CreateArtist | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/{artistId}/calendar` | CalendarFunction | GetArtistCalendar | None | public-read-review-required |  |
| POST | `/api/artists/{artistId}/calendar/subscribe` | CalendarFunction | CreateCalendarSubscription | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/{artistId}/calendar/subscriptions` | CalendarFunction | GetCalendarSubscriptions | None | public-read-review-required |  |
| DELETE | `/api/artists/{artistId}/calendar/subscriptions/{subscriptionId}` | CalendarFunction | DeleteCalendarSubscription | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/artists/{artistId}/check-vote-reminders` | ArtistSongsFunction | CheckVoteReminders | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/{artistId}/crm/venues` | VenueCRMFunction | GetArtistCrmVenues | None | public-read-review-required |  |
| POST | `/api/artists/{artistId}/crm/venues` | VenueCRMFunction | CreateArtistCrmVenue | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/artists/{artistId}/crm/venues/{venueId}` | VenueCRMFunction | DeleteArtistCrmVenue | None | admin | unauthenticated-mutation-declared-in-sam |
| PUT | `/api/artists/{artistId}/crm/venues/{venueId}` | VenueCRMFunction | UpdateArtistCrmVenue | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/{artistId}/crm/venues/{venueId}/contacts` | VenueCRMFunction | GetArtistCrmVenueContacts | None | public-read-review-required |  |
| POST | `/api/artists/{artistId}/crm/venues/{venueId}/contacts` | VenueCRMFunction | CreateArtistCrmVenueContact | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/artists/{artistId}/crm/venues/{venueId}/contacts/{contactId}` | VenueCRMFunction | DeleteArtistCrmVenueContact | None | admin | unauthenticated-mutation-declared-in-sam |
| PUT | `/api/artists/{artistId}/crm/venues/{venueId}/contacts/{contactId}` | VenueCRMFunction | UpdateArtistCrmVenueContact | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/{artistId}/crm/venues/{venueId}/gigs` | VenueCRMFunction | GetArtistCrmVenueGigs | None | public-read-review-required |  |
| GET | `/api/artists/{artistId}/crm/venues/{venueId}/notes` | VenueCRMFunction | GetArtistCrmVenueNotes | None | public-read-review-required |  |
| POST | `/api/artists/{artistId}/crm/venues/{venueId}/notes` | VenueCRMFunction | CreateArtistCrmVenueNote | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/artists/{artistId}/crm/venues/{venueId}/notes/{noteId}` | VenueCRMFunction | DeleteArtistCrmVenueNote | None | admin | unauthenticated-mutation-declared-in-sam |
| PUT | `/api/artists/{artistId}/crm/venues/{venueId}/notes/{noteId}` | VenueCRMFunction | UpdateArtistCrmVenueNote | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/{artistId}/events` | ArtistsFunction | GetArtistEvents | None | public-read-review-required |  |
| POST | `/api/artists/{artistId}/events` | EventsFunction | CreateArtistEvent | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/artists/{artistId}/events/{id}` | EventsFunction | DeleteArtistEvent | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/{artistId}/events/{id}` | EventsFunction | GetArtistEvent | None | public-read-review-required |  |
| PUT | `/api/artists/{artistId}/events/{id}` | EventsFunction | UpdateArtistEvent | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/{artistId}/events/{id}/ical` | CalendarFunction | GetEventIcal | None | public-read-review-required |  |
| POST | `/api/artists/{artistId}/events/{id}/leave` | EventsFunction | LeaveEvent | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/artists/{artistId}/events/bulk-availability` | EventsFunction | BulkAvailability | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/artists/{artistId}/events/check-conflicts` | EventsFunction | CheckConflicts | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/artists/{artistId}/events/toggle-availability` | EventsFunction | ToggleAvailability | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/{artistId}/expenses` | ExpensesFunction | GetExpenses | None | public-read-review-required |  |
| POST | `/api/artists/{artistId}/expenses` | ExpensesFunction | CreateExpense | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/artists/{artistId}/expenses/{id}` | ExpensesFunction | DeleteExpense | None | admin | unauthenticated-mutation-declared-in-sam |
| PUT | `/api/artists/{artistId}/expenses/{id}` | ExpensesFunction | UpdateExpense | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/{artistId}/finances` | ExpensesFunction | GetFinances | None | public-read-review-required |  |
| GET | `/api/artists/{artistId}/income` | ExpensesFunction | GetIncome | None | public-read-review-required |  |
| POST | `/api/artists/{artistId}/income` | ExpensesFunction | CreateIncome | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/artists/{artistId}/income/{id}` | ExpensesFunction | DeleteIncome | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/{artistId}/invites` | InvitesFunction | GetArtistInvites | None | public-read-review-required |  |
| POST | `/api/artists/{artistId}/invites/general` | InvitesFunction | CreateGeneralInvite | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/artists/{artistId}/invites/phone` | InvitesFunction | CreatePhoneInvite | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/{artistId}/members` | MembershipsFunction | GetArtistMembers | None | public-read-review-required |  |
| POST | `/api/artists/{artistId}/members` | MembershipsFunction | CreateArtistMember | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/{artistId}/pipeline` | ArtistSongsFunction | GetPipeline | None | public-read-review-required |  |
| DELETE | `/api/artists/{artistId}/pipeline/{artistSongId}` | ArtistSongsFunction | DeletePipelineSong | None | admin | unauthenticated-mutation-declared-in-sam |
| PUT | `/api/artists/{artistId}/pipeline/{artistSongId}/comment` | ArtistSongsFunction | UpdatePipelineComment | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/artists/{artistId}/pipeline/{artistSongId}/rag` | ArtistSongsFunction | UpdatePipelineRag | None | admin | unauthenticated-mutation-declared-in-sam |
| PUT | `/api/artists/{artistId}/pipeline/{artistSongId}/rag-status` | ArtistSongsFunction | UpdatePipelineRagStatus | None | admin | unauthenticated-mutation-declared-in-sam |
| PUT | `/api/artists/{artistId}/pipeline/{artistSongId}/status` | ArtistSongsFunction | UpdatePipelineStatus | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/artists/{artistId}/pipeline/{artistSongId}/vote` | ArtistSongsFunction | VotePipelineSong | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/artists/{artistId}/pipeline/suggestions` | ArtistSongsFunction | AddPipelineSuggestion | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/{artistId}/playbook` | ArtistSongsFunction | GetPlaybook | None | public-read-review-required |  |
| POST | `/api/artists/{artistId}/playbook` | ArtistSongsFunction | AddToPlaybook | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/artists/{artistId}/playbook/{artistSongId}` | ArtistSongsFunction | DeletePlaybookSong | None | admin | unauthenticated-mutation-declared-in-sam |
| PUT | `/api/artists/{artistId}/playbook/{artistSongId}` | ArtistSongsFunction | UpdatePlaybookSong | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/{artistId}/public-availability` | EventsFunction | GetPublicAvailability | None | public-read-review-required |  |
| GET | `/api/artists/{artistId}/public-events` | EventsFunction | GetArtistPublicEvents | None | public-read-review-required |  |
| POST | `/api/artists/{artistId}/public-gigs` | EventsFunction | CreatePublicGig | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/{artistId}/setlists` | SetlistsFunction | GetArtistSetlists | None | public-read-review-required |  |
| POST | `/api/artists/{artistId}/setlists` | SetlistsFunction | CreateArtistSetlist | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/artists/{artistId}/setlists/{setlistId}` | SetlistsFunction | DeleteArtistSetlist | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/{artistId}/setlists/{setlistId}` | SetlistsFunction | GetArtistSetlistById | None | public-read-review-required |  |
| PUT | `/api/artists/{artistId}/setlists/{setlistId}` | SetlistsFunction | UpdateArtistSetlist | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/{artistId}/songs` | ArtistSongsFunction | GetArtistSongs | None | public-read-review-required |  |
| POST | `/api/artists/{artistId}/songs` | ArtistSongsFunction | AddArtistSong | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/artists/{artistId}/songs/{songId}` | ArtistSongsFunction | DeleteArtistSong | None | admin | unauthenticated-mutation-declared-in-sam |
| PUT | `/api/artists/{artistId}/songs/{songId}` | ArtistSongsFunction | UpdateArtistSong | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/artists/{id}` | ArtistsFunction | DeleteArtist | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/{id}` | ArtistsFunction | GetArtistById | None | public-read-review-required |  |
| PUT | `/api/artists/{id}` | ArtistsFunction | UpdateArtist | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/artists/{id}/mcp` | ArtistsFunction | DeleteArtistMcp | None | deprecated | unauthenticated-mutation-declared-in-sam |
| PUT | `/api/artists/{id}/mcp` | ArtistsFunction | UpdateArtistMcp | None | deprecated | unauthenticated-mutation-declared-in-sam |
| POST | `/api/artists/{id}/refresh-facebook-image` | ArtistsFunction | RefreshFacebookImage | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/by-external-id` | ArtistsFunction | GetArtistByExternalId | None | public-read-review-required |  |
| GET | `/api/artists/check-name` | ArtistsFunction | CheckArtistName | None | public-read-review-required |  |
| POST | `/api/artists/community` | ArtistsFunction | CreateCommunityArtist | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/artists/find-or-create` | ArtistsFunction | FindOrCreateArtist | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/artists/list` | ArtistsFunction | ListArtistsMcp | None | public-read-review-required |  |
| GET | `/api/artists/search` | ArtistsFunction | SearchArtists | None | public-read-review-required |  |
| GET | `/api/builders` | BuildersFunction | GetMyBuilders | None | public-read-review-required |  |
| POST | `/api/builders` | BuildersFunction | CreateBuilder | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/builders/{id}` | BuildersFunction | DeleteBuilder | None | admin | unauthenticated-mutation-declared-in-sam |
| PUT | `/api/builders/{id}` | BuildersFunction | UpdateBuilder | None | admin | unauthenticated-mutation-declared-in-sam |
| PUT | `/api/builders/{id}/publish` | BuildersFunction | PublishBuilder | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/builders/{id}/venues` | BuildersFunction | GetBuilderVenues | None | public-read-review-required |  |
| POST | `/api/builders/{id}/venues` | BuildersFunction | AddBuilderVenue | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/builders/{id}/venues/{venueId}` | BuildersFunction | DeleteBuilderVenue | None | admin | unauthenticated-mutation-declared-in-sam |
| PUT | `/api/builders/{id}/venues/{venueId}` | BuildersFunction | UpdateBuilderVenue | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/builders/by-subdomain/{slug}` | BuildersFunction | GetBuilderBySubdomain | None | public-read-review-required |  |
| GET | `/api/calendar/ical/{token}` | CalendarFunction | GetCalendarIcal | None | public-read-review-required |  |
| GET | `/api/events` | EventsFunction | GetAllEvents | None | public-read-review-required |  |
| POST | `/api/events` | EventsFunction | CreateEvent | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/events/{id}` | EventsFunction | DeleteEvent | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/events/{id}` | EventsFunction | GetEventById | None | public-read-review-required |  |
| PUT | `/api/events/{id}` | EventsFunction | UpdateEvent | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/events/{id}/mcp` | EventsFunction | DeleteEventMcp | None | deprecated | unauthenticated-mutation-declared-in-sam |
| GET | `/api/events/{id}/mcp` | EventsFunction | GetEventMcp | None | deprecated |  |
| PUT | `/api/events/{id}/mcp` | EventsFunction | UpdateEventMcp | None | deprecated | unauthenticated-mutation-declared-in-sam |
| POST | `/api/events/batch` | EventsFunction | BatchEventsWithJoins | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/events/by-external-id` | EventsFunction | GetEventByExternalId | None | public-read-review-required |  |
| POST | `/api/events/community` | EventsFunction | CreateCommunityEvent | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/events/public` | EventsFunction | GetPublicEvents | None | public-read-review-required |  |
| GET | `/api/events/public/geo` | EventsFunction | GetPublicEventsGeo | None | public-read-review-required |  |
| GET | `/api/festivals/by-external-id` | FestivalsFunction | GetFestivalByExternalId | None | public-read-review-required |  |
| GET | `/api/festivals/public` | FestivalsFunction | GetPublicFestivals | None | public-read-review-required |  |
| GET | `/api/festivals/slug/{slug}` | FestivalsFunction | GetFestivalBySlug | None | public-read-review-required |  |
| POST | `/api/ingest/bulk-import` | EventsAgentFunction | BulkImport | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/ingest/enrich-venue-facebook` | EventsAgentFunction | EnrichVenueFacebook | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/ingest/extract-from-html` | EventsAgentFunction | ExtractFromHtml | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/ingest/extract-from-url` | EventsAgentFunction | ExtractFromUrl | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/ingest/extract-venues` | EventsAgentFunction | ExtractVenues | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/ingest/load-poc` | EventsAgentFunction | LoadPoc | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/ingest/queue` | EventsAgentFunction | IngestQueue | None | public-read-review-required |  |
| POST | `/api/ingest/queue/{id}/approve` | EventsAgentFunction | ApproveIngestItem | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/ingest/queue/{id}/reject` | EventsAgentFunction | RejectIngestItem | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/ingest/update-venue-placeid` | EventsAgentFunction | UpdateVenuePlaceId | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/integration/events` | CalendarFunction | IntegrationFindOrCreateEvent | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/integration/venues` | VenuesFunction | IntegrationVenues | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/invites` | InvitesFunction | GetInvites | None | public-read-review-required |  |
| POST | `/api/invites` | InvitesFunction | CreateInvite | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/invites/{token}` | InvitesFunction | DeleteInvite | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/invites/{token}` | InvitesFunction | GetInviteByToken | None | public-read-review-required |  |
| POST | `/api/invites/{token}/accept` | InvitesFunction | AcceptInvite | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/invites/{token}/decline` | InvitesFunction | DeclineInvite | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/issues` | IssuesFunction | GetIssues | None | public-read-review-required |  |
| POST | `/api/issues` | IssuesFunction | CreateIssue | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/issues/{id}` | IssuesFunction | DeleteIssue | None | admin | unauthenticated-mutation-declared-in-sam |
| PUT | `/api/issues/{id}` | IssuesFunction | UpdateIssue | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/issues/batch` | IssuesFunction | CreateIssuesBatch | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/me` | AuthFunction | GetMe | None | public-read-review-required |  |
| POST | `/api/memberships` | MembershipsFunction | CreateMembership | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/memberships/{membershipId}` | MembershipsFunction | DeleteMembership | None | admin | unauthenticated-mutation-declared-in-sam |
| PUT | `/api/memberships/{membershipId}` | MembershipsFunction | UpdateMembership | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/memberships/all` | MembershipsFunction | GetAllMemberships | None | public-read-review-required |  |
| GET | `/api/memberships/artist/{artistId}` | MembershipsFunction | GetArtistMemberships | None | public-read-review-required |  |
| GET | `/api/memberships/me` | MembershipsFunction | GetMyMemberships | None | public-read-review-required |  |
| GET | `/api/notifications` | NotificationsFunction | GetNotifications | None | public-read-review-required |  |
| POST | `/api/notifications` | NotificationsFunction | CreateNotification | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/notifications/{id}` | NotificationsFunction | DeleteNotification | None | admin | unauthenticated-mutation-declared-in-sam |
| PUT | `/api/notifications/{id}/dismiss` | NotificationsFunction | DismissNotification | None | admin | unauthenticated-mutation-declared-in-sam |
| PUT | `/api/notifications/{id}/read` | NotificationsFunction | MarkNotificationRead | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/notifications/mark-all-read` | NotificationsFunction | MarkAllNotificationsRead | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/review-items` | SourceRunsFunc | F | None | public-read-review-required |  |
| GET | `/api/setlists` | SetlistsFunction | GetSetlists | None | public-read-review-required |  |
| POST | `/api/setlists` | SetlistsFunction | CreateSetlist | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/setlists/{id}` | SetlistsFunction | DeleteSetlist | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/setlists/{id}` | SetlistsFunction | GetSetlistById | None | public-read-review-required |  |
| PUT | `/api/setlists/{id}` | SetlistsFunction | UpdateSetlist | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/songs` | SongsFunction | GetAllSongs | None | public-read-review-required |  |
| POST | `/api/songs` | SongsFunction | CreateSong | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/songs/{id}` | SongsFunction | DeleteSong | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/songs/{id}` | SongsFunction | GetSongById | None | public-read-review-required |  |
| PUT | `/api/songs/{id}` | SongsFunction | UpdateSong | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/source-runs` | SourceRunsFunc | A | None | public-read-review-required |  |
| GET | `/api/source-runs/{sourceId}` | SourceRunsFunc | D | None | public-read-review-required |  |
| GET | `/api/source-runs/{sourceId}/{runId}` | SourceRunsFunc | E | None | public-read-review-required |  |
| GET | `/api/source-runs/coverage` | SourceRunsFunc | C | None | public-read-review-required |  |
| GET | `/api/source-runs/summaries` | SourceRunsFunc | B | None | public-read-review-required |  |
| GET | `/api/spotify/search` | SpotifyFunction | SpotifySearch | None | public-read-review-required |  |
| POST | `/api/users/me/unavailability` | CalendarFunction | CreateUserUnavailability | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/venue-crm` | VenueCRMFunction | GetVenueCRM | None | public-read-review-required |  |
| POST | `/api/venue-crm` | VenueCRMFunction | CreateVenueCRM | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/venues` | VenuesFunction | GetAllVenues | None | public-read-review-required |  |
| POST | `/api/venues` | VenuesFunction | CreateVenue | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/venues/{id}` | VenuesFunction | DeleteVenue | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/venues/{id}` | VenuesFunction | GetVenueById | None | public-read-review-required |  |
| PUT | `/api/venues/{id}` | VenuesFunction | UpdateVenue | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/venues/{id}/enrich` | VenuesFunction | EnrichVenueMcp | None | admin | unauthenticated-mutation-declared-in-sam |
| DELETE | `/api/venues/{id}/mcp` | VenuesFunction | DeleteVenueMcp | None | deprecated | unauthenticated-mutation-declared-in-sam |
| GET | `/api/venues/{venueId}/events` | EventsFunction | GetVenueEvents | None | public-read-review-required |  |
| GET | `/api/venues/by-external-id` | VenuesFunction | GetVenueByExternalId | None | public-read-review-required |  |
| POST | `/api/venues/community` | VenuesFunction | CreateCommunityVenue | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/api/venues/find-or-create` | VenuesFunction | FindOrCreateVenue | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/api/venues/list` | VenuesFunction | ListVenuesMcp | None | public-read-review-required |  |
| GET | `/auth/apple` | AuthFunction | AppleOAuthInit | None | public-read-review-required |  |
| GET | `/auth/callback` | AuthFunction | OAuthCallback | None | public-read-review-required |  |
| POST | `/auth/check-identity` | AuthFunction | CheckIdentity | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/auth/email/request-magic` | AuthFunction | EmailRequestMagic | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/auth/facebook/callback` | AuthFunction | FacebookAuth | None | public-read-review-required |  |
| GET | `/auth/google` | AuthFunction | GoogleOAuthInit | None | public-read-review-required |  |
| GET | `/auth/google/callback` | AuthFunction | GoogleAuth | None | public-read-review-required |  |
| POST | `/auth/login` | AuthFunction | Login | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/auth/logout` | AuthFunction | Logout | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/auth/magic/{token}` | AuthFunction | MagicLinkVerify | None | public-read-review-required |  |
| POST | `/auth/phone/request-otp` | AuthFunction | PhoneRequestOtp | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/auth/phone/verify-and-onboard` | AuthFunction | PhoneVerifyAndOnboard | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/auth/phone/verify-otp` | AuthFunction | PhoneVerifyOtp | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/auth/refresh` | AuthFunction | Refresh | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/auth/register` | AuthFunction | Register | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/festivals` | FestivalsFunction | SearchFestivals | None | public-read-review-required |  |
| POST | `/festivals` | FestivalsFunction | CreateFestival | None | admin | unauthenticated-mutation-declared-in-sam |
| PATCH | `/festivals/{id}` | FestivalsFunction | UpdateFestival | None | admin | unauthenticated-mutation-declared-in-sam |
| POST | `/uploads/presigned-url` | UploadsFunction | GetPresignedUrl | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/users` | UsersFunction | GetAllUsers | None | public-read-review-required |  |
| DELETE | `/users/{userId}` | UsersFunction | DeleteUser | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/users/{userId}` | UsersFunction | GetUserById | None | public-read-review-required |  |
| PUT | `/users/{userId}` | UsersFunction | UpdateUser | None | admin | unauthenticated-mutation-declared-in-sam |
| GET | `/users/profile` | UsersFunction | GetUserProfile | None | public-read-review-required |  |
| PUT | `/users/profile` | UsersFunction | UpdateUserProfile | None | admin | unauthenticated-mutation-declared-in-sam |

## Duplicate declarations

None detected.

## Interpretation

- `public-read-review-required` does not mean the route has been approved for anonymous public use. SEC-01 will replace this broad baseline with an explicit allowlist.
- `admin` is the target trust zone for existing mutations, not evidence that the route is currently protected.
- `deprecated` identifies legacy HTTP MCP routes. The local stdio MCP repository remains out of scope.
- Handler-level authentication and authorisation are not inferred by this script and must be inspected separately.
