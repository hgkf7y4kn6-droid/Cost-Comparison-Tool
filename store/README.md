# Shipping Sales Hub to the App Store and Google Play

The app is the web app in `../frontend/` bundled in native shells by Capacitor, calling your server. This folder
holds what the stores ask for. **Nothing here has been built or submitted:** the shells were generated and configured
on a Linux machine, so the iOS build (Xcode, macOS only) and the Android build (Android SDK) still need to be run by
you, and the first build should be tested on real devices. Items marked **You** need your accounts or decisions.

## 1. Before you build

| | |
|---|---|
| **You** | Pick the final **bundle ID / application ID** (currently `com.officebasics.saleshub` in `capacitor.config.json`, `android/app/build.gradle` and the Xcode project). It must be one your developer accounts own; change all three together, then run `npx cap sync`. |
| **You** | Set `window.COMPANY` (name, **support email**, mailing address, site URL) in `frontend/config.js`. Both stores require a working support contact. |
| **You** | Set `NATIVE_APP_API` in `frontend/config.js` to your production server (HTTPS). |
| **You** | Host the app on a public HTTPS address; the policy pages are `/privacy.html`, `/terms.html`, `/support.html`. Use these as the **Privacy Policy URL**, **Support URL** (and marketing URL). |
| **You** | Google Maps key: in Google Cloud allow the referrers `https://YOUR-SITE/*` **and** `https://localhost/*` (what the apps present). Put it in `frontend/config.js`. |
| **You** | Server env: `AUTH_USERS`, `AUTH_SECRET`, `GOOGLE_PLACES_API_KEY`, `APOLLO_API_KEY`, `ANTHROPIC_API_KEY` (see the README). Reviewers should see the finder and coaches working. |
| **You** | Create a **review account** (a normal `AUTH_USERS` entry, e.g. `appreview@…`) and give its credentials in App Store Connect's *App Review Information* and Play Console's *App access*. The app has no public sign-up, so reviewers can't get in without it. |

## 2. Build

```bash
npm install
python scripts/make_icons.py && python scripts/native_assets.py   # only if you changed the artwork
npx cap sync            # copies frontend/ into both apps
npx cap open ios        # Xcode (Mac): set Team, signing, then Product > Archive
npx cap open android    # Android Studio: Build > Generate Signed Bundle (AAB)
```

- **iOS:** Xcode 16+ on macOS. Set the Team and signing, bump *Version* / *Build* (`MARKETING_VERSION`,
  `CURRENT_PROJECT_VERSION`), archive, upload to App Store Connect. Deployment target is iOS 15.
- **Android:** `compileSdk`/`targetSdk` 36 (`android/variables.gradle`). Create an upload keystore, enroll in Play App
  Signing, build an **AAB**, bump `versionCode` in `android/app/build.gradle` for every upload.
- Test on devices: sign in, Find customers, Scan card (camera permission), Coach, Account → Delete my account (with a
  throwaway user), offline banner, rotation, dark mode, a small iPhone and an iPad.

## 3. What's already in place for review

| Requirement | Where |
|---|---|
| **Account deletion** inside the app (Apple 5.1.1(v), Google Play) | *Account → Delete my account* (`POST /auth/delete-account`); web link on `support.html` |
| **Privacy policy** public and linked in-app | `frontend/privacy.html`, linked from sign-in and Account |
| **Consent before sharing data with third-party AI** (Apple 5.1.2(i)) | AI consent dialog on first use + toggle in Account; server ignores AI without it |
| **Permission purpose strings** | `ios/App/App/Info.plist` (camera, photo library). Microphone/speech and location are *not* requested |
| **Privacy manifest** (`PrivacyInfo.xcprivacy`), no tracking | `ios/App/App/PrivacyInfo.xcprivacy` |
| **Export compliance** (HTTPS only) | `ITSAppUsesNonExemptEncryption = false` in `Info.plist` |
| **No ads, no analytics SDKs, no tracking** | nothing to declare for ATT; do not add an ATT prompt |
| **Data safety / privacy nutrition labels** | [privacy-labels.md](privacy-labels.md) |
| **Listing text, categories, age rating, review notes** | [listing.md](listing.md) |
| **Icons, launch screens, store graphics** | `assets/` (iOS 1024 icon without alpha, Play 512 icon, 1024×500 feature graphic); in-app icons by `scripts/native_assets.py` |
| **Accessibility basics**: labels, focus, skip link, reduced motion, 40 px touch targets, no input zoom | web app |
| **Offline behavior** | offline banner; the app opens and shows on-device data |
| **Content**: sample data for first-run and for reviewers | *Today → Try it with sample data* |
| **Cleartext traffic off, no backup of app data (Android)** | `AndroidManifest.xml` |

## 4. Likely review questions

- **Apple 4.2 “minimum functionality / web clip”.** The app bundles its own interface (not a website in a frame) and
  uses the camera for card scanning, offline use and on-device data, and account-based business functions. Say so in
  the review notes ([listing.md](listing.md)).
- **Apple 3.1.1 / Google payments.** The app sells nothing and has no in-app purchases. It is a business tool for
  an employer's sales team; accounts come from the employer. State that, and choose *Business* / *Productivity*.
- **Apple 5.1.1 sign-in.** Sign-in is required only because the app shows an employer's data; there is no sign-up.
  The review account covers it.
- **Google “Deceptive behavior” / User data.** The data safety form and privacy policy match the app: no data is sold,
  no ads, third parties are named (Google, Apollo, Anthropic, hosting).
- **Third-party business data.** Leads hold business contacts' names and work emails. The policy and the finder say to
  use business addresses, include an opt-out and honor requests. Keep Apollo's and Google's terms in mind (Google limits
  caching of Places data).
- **Google target audience.** 18+ / not for children; do not enroll in Families.

## 5. After launch

Keep `targetSdk` current (Google raises the minimum every August), rebuild with the current Xcode before Apple's
yearly SDK deadline, and re-run `npx cap sync` whenever `frontend/` changes (the apps ship a copy of it). Because the
web files are bundled, a change to them needs a new store release; server changes go live immediately.
