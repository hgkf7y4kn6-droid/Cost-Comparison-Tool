# Privacy answers for the stores

Matches `frontend/privacy.html` and what the app does today. Re-check if you add an SDK, analytics or a feature.
The app has **no** advertising, analytics, crash-reporting or attribution SDKs, and does **not** track users.

## Apple: App Privacy ("nutrition labels")

**Do you or your third-party partners collect data from this app?** Yes.
**Tracking** (ATT): **No.** Data is not used to track people across other companies' apps or sites.

| Data type | Collected | Linked to the user | Used for tracking | Purpose |
|---|---|---|---|---|
| Contact info → **Email address** (the rep's work email, to sign in) | Yes | Yes | No | App functionality |
| User content → **Other user content** (leads, accounts, notes, proposals, coach knowledge the rep enters) | Yes | Yes | No | App functionality |
| User content → **Photos or videos** (business card photo; processed to read the text, not kept) | Yes (sent to the server for processing) | No | No | App functionality |
| Identifiers, usage data, diagnostics, location, financial info, health, contacts-from-phone | No | | | |

Notes: the card photo is not retained, so you may judge it "not collected" under Apple's real-time-processing rule;
declaring it is the conservative choice. Third parties that receive data for a feature: Google (Maps/Places),
Apollo, Anthropic (only after the user allows AI), and the hosting provider; all act on the app's behalf for the
purposes above.

`ios/App/App/PrivacyInfo.xcprivacy` declares the same types and the required-reason API Capacitor uses
(UserDefaults, `CA92.1`).

## Google Play: Data safety

**Does your app collect or share any of the required user data types?** Yes (collects); **data is encrypted in
transit:** Yes (HTTPS). **Users can request data deletion:** Yes: in-app (*Account → Delete my account*) and via the
public page `support.html` (use it as the *Data deletion URL*; it explains the in-app path and the support email).

| Section | Data type | Collected | Shared | Optional | Purpose |
|---|---|---|---|---|---|
| Personal info | Email address | Yes | No | Required (to sign in) | App functionality, Account management |
| App activity / Files and docs | *Other user-generated content* (leads, notes, proposals) | Yes | No* | Required | App functionality |
| Photos and videos | Photos (card scan) | Yes | No* | Optional | App functionality |
| Location, financial, health, messages, audio, contacts, device or other IDs, web browsing | No | | | | |

\* Google counts sending data to a *service provider* that processes it on your behalf as not "sharing". If you
treat Anthropic (AI), Apollo or Google as third parties receiving user content, answer "Shared: Yes" for the
affected rows (purpose: App functionality). The user is asked before AI processing begins.

**Permissions to declare:** Camera (optional, feature "Scan card"; `required=false` in the manifest). No location,
microphone, contacts, SMS or storage-wide permissions.

**Ads:** No ads. **Target audience:** 18+. **App category:** Business. **News / government / health / financial
features:** none.

## Age rating (both stores)
No violence, sexual content, gambling, profanity, user-to-user chat, unrestricted web access, or purchases.
Apple: 4+. Google IARC: Everyone (answer the questionnaire "No" throughout; it covers the app's behavior, not its
audience, which you set to 18+ separately).
