# Meta Facebook Login review pack

Status: implementation and production initiation flow proven on 28 August 2026.

## Production implementation

Facebook Login is offered as one of several account sign-in methods on BNDY. It is not mandatory. Users may also use phone, email, Google or Apple.

Production login page:

- `https://bndy.live/login`
- To demonstrate return-path handling: `https://bndy.live/login?next=%2Fjoin`

The UI contains a `Socials` tab with:

- Continue with Google
- Continue with Facebook
- Continue with Apple

The Facebook button starts the BNDY auth route:

- `https://api.bndy.co.uk/auth/facebook`

The backend validates the requested BNDY return URL, creates a one-time OAuth state record, and redirects through Amazon Cognito Hosted UI using `identity_provider=Facebook`.

Production proof on 28 August 2026 returned HTTP 302 to:

- Cognito domain `eu-west-2lqtkkhs1p.auth.eu-west-2.amazoncognito.com`
- Cognito client `ajln84krd9kp6jj70qp1irmn2`
- callback `https://bndy.live/auth/callback`
- `identity_provider=Facebook`

The deployed `bndy.live` JavaScript bundle was also proven to contain `Continue with Facebook` and `/auth/facebook`, alongside the existing Google and Apple options.

## Facebook data requested

Facebook identity-provider configuration requests only:

- `public_profile`
- `email`

Attribute mapping:

- Facebook `id` -> Cognito username
- Facebook `email` -> Cognito email
- Facebook `name` -> Cognito name

BNDY does not request permission to post to Facebook and does not receive the user's Facebook password.

## Why BNDY uses the data

BNDY uses Facebook Login solely to let a person create or access their BNDY account without creating another password. The name and email returned through the identity provider are used to identify the BNDY account and provide the signed-in BNDY experience.

## Reviewer test instructions

1. Open `https://bndy.live/login?next=%2Fjoin`.
2. Select the `Socials` tab.
3. Select `Continue with Facebook`.
4. Complete Facebook authentication and consent.
5. After successful authentication, confirm the browser returns to BNDY and the BNDY session is authenticated.
6. Confirm the requested return path is preserved and the user can continue into the BNDY Join journey.

No special artist or venue account is required to test Facebook Login itself.

## Suggested Meta permission explanations

### public_profile

BNDY uses the person's basic Facebook profile identity as part of Facebook Login so the person can create or access the correct BNDY user account. It is used only for account authentication/identity and is not used for advertising, profiling or posting to Facebook.

### email

BNDY uses the email address supplied by Facebook to associate the Facebook identity with the person's BNDY account and to support the signed-in account experience. It is not sold, rented or used for third-party advertising.

## Public legal URLs

The BNDY public website contains dedicated legal pages, including:

- Privacy policy: `https://bndy.co.uk/privacy`
- Data deletion instructions: `https://bndy.co.uk/data-deletion`
- Terms: `https://bndy.co.uk/terms`
- Contact: `https://bndy.co.uk/contact`

The privacy policy explicitly covers social sign-in, including Facebook, and states that BNDY receives name and email but not the user's password and does not post on the user's behalf.

The data deletion page explicitly covers Facebook/Google sign-in data and provides deletion instructions. It states that deleting the BNDY account also deletes the name and email received from the sign-in provider and provides a route for requesting deletion of sign-in data.

## Human-only proof still required

Before treating the feature as fully end-to-end accepted, perform one real Facebook account login from the production BNDY login page. This proves the portion that automated infrastructure checks cannot prove without an authorised Facebook user session: Meta consent, Cognito federation, callback token exchange, BNDY session cookie creation and final return to BNDY.

If the Meta dashboard requires a screencast for review, record exactly that successful production flow from `/login?next=%2Fjoin` through Facebook and back into BNDY.

## Submission guardrails

- Request only the permissions BNDY actually uses.
- Do not describe Facebook data as being used for artist/venue enrichment, discovery or Backline. This Facebook Login integration is account identity only.
- Keep the review instructions reproducible from a clean signed-out browser session.
- Confirm the app is in the Meta mode/access state required for non-role users before public launch.
