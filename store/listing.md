# Store listing copy

Edit the product name if you ship under your own brand. Character limits are the stores' current limits.

## Apple App Store
- **Name** (30): `Sales Hub: Office Supplies`
- **Subtitle** (30): `Prospect, quote and coach`
- **Category:** Business (secondary: Productivity). **Age rating:** 4+. **Price:** Free.
- **Promotional text** (170): Find nearby businesses, see headcount and the buyer, build a proposal that shows the savings, and get coached before the call. Built for office supply reps.
- **Keywords** (100): `sales,prospecting,quotes,proposals,CRM,leads,office supplies,janitorial,field sales,coach`
- **Support URL / Marketing URL / Privacy Policy URL:** your site's `/support.html`, `/`, `/privacy.html`
- **Copyright:** `© 2026 Your Company`

**Description**

Sales Hub is the sales app for business development reps who sell office, break-room, janitorial and print supplies.
It follows the sale from the first search to the first order.

FIND CUSTOMERS. Search Google Maps for businesses near you by type and area. See estimated headcount and the person who buys supplies. Add the good ones to your pipeline in one tap.

COMPARE COSTS. Photograph or upload what a customer buys today and get good, better and best alternatives, compared on cost per use, not case price.

BUILD PROPOSALS. Price every line from your catalog to your target margin, show the customer their savings, and print or share a clean PDF. Your costs and margins never appear on the customer's copy.

COACH. Five AI coaches (discovery, objections, proposals, account growth, outreach) answer from your team's playbook, including how perception shapes the sale. Add your own knowledge.

LOG A TOUCH. Dictate or type a note right after the visit, tidy it, and file it on the account. Scan a business card straight into a lead.

GROW ACCOUNTS. Onboarding checklists, renewals, follow-ups due and cross-sell gaps, on one Today screen.

Your data stays yours: no ads, no tracking, and you can delete your account from the app. AI features are optional and ask first.

Accounts are created by your company's administrator.

**What's new (1.0):** First release.

### App Review notes (App Store Connect → App Review Information)
```
Sales Hub is an internal sales tool. Accounts are created by the customer's administrator; there is no
public sign-up. Use this review account:

  Email:    <REVIEW ACCOUNT EMAIL>
  Password: <REVIEW ACCOUNT PASSWORD>

Tips: on the Today tab, tap "Try it with sample data" to load fictional leads. Prospecting > Find customers
searches Google Maps and Apollo (server-side keys are configured). The Coach tab works with and without AI;
the first time, the app asks permission before any text is sent to the AI provider (Anthropic).
Account > Delete my account deletes the account and its data (use the review account only if you wish;
we can restore it). The camera is used only by "Scan card". The app bundles its own interface and
works offline for on-device data; it is not a website wrapper.
No in-app purchases, ads, tracking or analytics.
```

## Google Play
- **App name** (30): `Sales Hub: Office Supplies`
- **Short description** (80): `Find customers, compare costs, quote and coach: for office supply sales reps.`
- **Full description** (4000): use the Apple description above.
- **Category:** Business. **Tags:** Business, Productivity. **Contact:** support email, website, phone (optional).
- **Privacy policy:** your site's `/privacy.html`. **Data deletion URL:** `/support.html`.
- **App access:** "All or some functionality is restricted": provide the review account and the "sample data" tip.
- **Content rating:** complete the IARC questionnaire (Business app; no UGC sharing, no purchases).
- **Target audience:** 18 and over. **Ads:** none. **Government/health/financial app:** no.

## Screenshots
Required sizes: iPhone 6.9" (1320×2868), iPad 13" (2064×2752) if iPad is enabled, Android phone (min. 1080 wide).
Regenerate them from the running app (fictional data only):

```bash
node scripts/store_screenshots.js http://127.0.0.1:8000 reviewer@example.com 'PASSWORD'   # writes store/screenshots/
```
