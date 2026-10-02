# Distribution on AI platforms

Research date: 2026-10-02. Web research from official docs and dated 2026 press. Points that
could not be confirmed are marked **[unverified]**.

## Anthropic Claude: Connectors Directory

- **Reach:** one directory for claude.ai, Desktop, mobile, Cowork and Claude Code. Free plan has
  directory connectors since about February 2026. Listings also appear as in-chat suggestions.
- **Submit:** claude.ai/directory/manage → "MCP connector". Any paid plan; Owner on Team/Enterprise.
- **Review:** automated policy scan, then live as "Community". Anthropic may later test every tool
  for "Verified". No published SLA; escalations to mcp-review@anthropic.com.
- **Hard requirements:** public HTTPS, Streamable HTTP. Every tool has a `title` and
  `readOnlyHint` or `destructiveHint`. A tool that mixes reads and writes is rejected. Tool names
  ≤64 characters; no prompt-injection-style instructions in descriptions. Actionable errors. The
  API must be your own and the server domain should match the service. Not accepted: tools that
  move money, or that generate images, video or audio.
- **Listing:** docs URL, privacy policy, support contact, icon, test account with populated data.
  MCP Apps need 3–5 PNG screenshots ≥1000 px wide. 7 compliance acknowledgments and a question
  about personal health data.
- **Auth:** OAuth via DCR or CIMD (CIMD recommended), Anthropic-held client credentials, or none.
  "Lazy authentication": public tools work without sign-in; a protected tool answers HTTP 401 +
  `WWW-Authenticate` and the host shows a Connect card. Callback
  `https://claude.ai/api/mcp/auth_callback`; S256 PKCE; OAuth endpoints must answer within 10 s.
  Egress IPs 160.79.104.0/21.
- **UI:** MCP Apps render on web and Desktop; `ui/open-link` can open an allowlisted domain.
  Sampling and resource subscriptions are not supported. Elicitation on claude.ai is
  **[unverified]**.
- Docs: [submission](https://claude.com/docs/connectors/building/submission),
  [review criteria](https://claude.com/docs/connectors/building/review-criteria),
  [auth](https://claude.com/docs/connectors/building/authentication),
  [lazy auth](https://claude.com/docs/connectors/building/lazy-authentication).

## OpenAI ChatGPT: plugins

- **Renamed:** the App Directory became the Plugin Directory (chatgpt.com/plugins) on 2026-07-09.
  A plugin bundles an MCP app with skills. Listed for Free, Go, Plus and Pro.
- **EEA/UK/CH:** apps launched outside these regions in 2025; full EU availability not confirmed
  **[unverified]**. Risk for Altegio's markets.
- **Submit:** platform.openai.com/plugins. Verified individual or business identity,
  "Apps Management Write" permission. Manifest, logo, name + subtitle (30 chars), description
  (4,000 chars), website, support, privacy and terms URLs, per-country targeting, exactly 5
  positive and 3 negative test cases, demo video, demo account without signup or 2FA, commerce
  declaration if applicable.
- **Review:** median ≈11 days to approval, ≈3 days to rejection (reviewtimes.fyi, 2026-09-29).
- **Tool rules:** `readOnlyHint`, `destructiveHint` and `openWorldHint` set explicitly.
  Irreversible actions need human confirmation.
- **Restricted data:** card data, health data, government IDs and **MFA/OTP codes** must not be
  collected. Avoid raw location fields.
- **Commerce:** only physical goods may be sold; no direct links to checkout. Instant Checkout
  largely retired in March 2026. Free reservations are fine.
- **Auth:** OAuth 2.1 with CIMD (preferred) or DCR, or none. Per-tool `securitySchemes` mix
  `noauth` and `oauth2`. Sign-in triggered via `_meta["mcp/www_authenticate"]`. Tokens must be
  checked against the `resource` parameter. "Sign in with ChatGPT" (name, email, picture; no
  phone) is in a limited partner trial since 2026-09-29.
- **UI:** MCP Apps and the Apps SDK; reviewers test web and mobile, light and dark themes.
- Docs: [guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines),
  [submission](https://developers.openai.com/plugins/deploy/submission),
  [auth](https://developers.openai.com/plugins/build/auth).

## Google

- **Gemini app:** "Connected Apps" partners (OpenTable, Zocdoc, Thumbtack, …) come from business
  deals; no public submission. Users can add a custom MCP URL at gemini.google.com/apps only in
  the US, 18+, personal accounts. No MCP Apps rendering.
- **Gemini Enterprise:** each organization adds servers itself. **Gemini CLI** gallery replaced by
  Antigravity CLI on 2026-06-18; developer audience only.
- **Commerce:** UCP extended to hotels and food in 2026; services expected 2026–27 **[unverified]**.
- **AI Mode (Search):** agentic beauty booking in the US, handing off to the provider's checkout.
  Altegio's existing Reserve with Google (Actions Center) integration is the likely feed
  **[unverified link]**.
- Docs: [custom apps help](https://support.google.com/gemini/answer/17209137).

## Microsoft

- **M365 Copilot (work accounts):** declarative agent + MCP plugin in the Agent Store via Partner
  Center. OAuth 2.1 or Entra SSO. MCP Apps supported; only `readOnlyHint` honoured.
  [Docs](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-mcp-apps).
- **Consumer Copilot:** first-party partners only; no public MCP path found **[unverified]**.

## Others

| Platform | Consumer reach | Path |
|---|---|---|
| Perplexity | Pro/Max custom remote MCP since 2026-03-13 | No public directory form; contact api@perplexity.ai |
| Mistral Le Chat | Directory of ~65 connectors | No public form; contact Mistral |
| xAI Grok | Connectors since 2026-05-06; custom MCP for paid users | Catalog submission path not found |
| Amazon Alexa+ | MCP via "Alexa+ for Builders" preview (2026-07) | Eligibility **[unverified]** |
| Apple Siri | App Intents only | Needs App Intents in the Altegio.me iOS app |
| Meta AI | Ads MCP only | No consumer path |
| MCP Registry | Developer and agent discovery; feeds VS Code | `server.json` + `mcp-publisher`, DNS-verified namespace |
| Smithery, Glama | Developers | Self-serve |

## MCP spec facts

- Current spec 2026-07-28: stateless (no `initialize`, no `Mcp-Session-Id`), DCR deprecated in
  favour of CIMD, RFC 9207 `iss` validation, RFC 9728 and RFC 8707 mandatory, elicitation as
  "input_required" round trips, formal extensions (MCP Apps, Tasks).
- Hosts lag: Claude documents auth spec 2025-11-25. Build for 2025-11-25, stay compatible with
  2026-07-28.
- MCP Apps (stable since 2026-01-26) render in Claude web/desktop, ChatGPT, M365 Copilot,
  VS Code, Cursor, Goose; not Gemini.
- Do not rely on elicitation in consumer hosts.

## Precedents

- **Fresha** (ChatGPT and Claude since 2026-08-04, direct competitor): search and live
  availability in chat, then hand-off to Fresha checkout. No account linking in chat.
- **Resy (Claude):** no sign-in; availability in chat; booking finishes on resy.com or the app.
- **Booking.com, Expedia:** search in chat, book on their site.
- **ChatGPT restaurant reservations (OpenTable, Resy, Yelp; 2026-08-10):** first-party OpenAI
  feature; shares name and email with permission; card-required bookings go to the provider.
- **Zocdoc (Gemini, 2026-08-12):** books in chat; auth method unknown.
- Booksy, Mindbody, Vagaro, Treatwell, Calendly: no directory listings found **[unverified]**.

## Implications

1. Lazy, mixed auth: search and availability anonymous; booking, cancel and "my bookings" behind
   OAuth with phone + SMS on our page. CIMD first, DCR fallback. Never accept OTP codes in tools.
2. A deep-link hand-off ships everywhere first, including hosts with weak OAuth or UI support.
3. One MCP App (business cards → slot picker → confirmation) that works at 320 px and in dark
   mode, with text fallbacks.
4. Write tools separate from reads; cancel is destructive; confirmation lives in the UI or host.
5. Exclude or limit medical categories.
6. Before submission: verified OpenAI business identity, privacy policy, terms, support email,
   public docs page, logo, screenshots, demo video, demo account and business, test prompts,
   production server on an Altegio-owned domain, Anthropic's IP range allowed.
