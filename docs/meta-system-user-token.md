# Meta System User + Permanent Access Token

How to create a System User in Meta Business and generate a non-expiring access token for the WhatsApp Cloud API. This is what production should use — the temporary token from the App Dashboard expires every 24 hours and will silently break the bot.

---

## Why a System User

| Token type | Where it comes from | Expiry | Use it for |
|---|---|---|---|
| Temporary user token | App Dashboard → WhatsApp → API Setup | 24 hours | Local dev, smoke tests |
| User access token (long-lived) | OAuth flow / Graph API Explorer | ~60 days | Nothing in production |
| **System User token** | **Business Settings → System Users** | **Never (if set to "Never")** | **Production** |

A System User is a non-human identity owned by the Meta Business Account. Its token survives password resets, employee changes, and Facebook session expiries. It's the only token type Meta officially supports for production WhatsApp Cloud API integrations.

**Reference:** [Meta — System Users overview](https://www.facebook.com/business/help/503306463479099)

---

## Prerequisites

Before you start, make sure:

- [ ] You have **Admin** access to the Meta Business Account that owns the WhatsApp Business Account (WABA). Employee access is not enough — only Admins can create System Users.
- [ ] The WhatsApp Business Account already exists and has the production phone number attached.
- [ ] The Meta App (the one whose App ID you'll use in `META_APP_ID`) is already created and has the WhatsApp product added.
- [ ] You have somewhere safe to store the token (1Password, Doppler, Vercel/Railway env vars). Treat it like a database password — anyone with it can send messages from the number and read message history.

**Reference:** [Meta — Get Started with WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started)

---

## Step 1 — Open Business Settings

1. Go to **[business.facebook.com](https://business.facebook.com)**
2. Top-right gear icon → **Business Settings**
3. If you have multiple businesses, switch to the one that owns the WhatsApp number using the business switcher in the top-left.

**VERIFY:** The business name in the top-left matches the one that owns the WABA. If it doesn't, you'll create a System User in the wrong tenant and the token won't see the WhatsApp asset.

---

## Step 2 — Create the System User

1. Left sidebar → **Users** → **System Users**
2. Click **Add** (top-right)
3. Fill in:
   - **System Username:** something descriptive, e.g. `ttt-whatsapp-bot-prod`
   - **System User Role:** **Admin**
     - Employee role can't generate tokens with WhatsApp permissions in all cases. Use Admin.
4. Click **Create System User**
5. Accept the Meta non-disclosure terms if prompted.

**Reference:** [Meta — Add a System User](https://www.facebook.com/business/help/503306463479099)

---

## Step 3 — Assign the WhatsApp Business Account to the System User

The System User exists but owns nothing yet. You need to grant it access to the WABA.

1. Still in **Business Settings → Users → System Users**, select the user you just created.
2. Click **Add Assets** (top-right of the user's panel)
3. Choose **WhatsApp Accounts** from the asset type list
4. Tick the WABA you want this token to control
5. Toggle **Full control / Manage WhatsApp account** to **ON**
6. Click **Save Changes**

**VERIFY:** Under the System User, the **Assigned Assets** tab now lists your WABA with "Manage" permission.

---

## Step 4 — (If your App is separate) Assign the App too

If the Meta App lives in this same business, you typically don't need this step. If the App is in a different business or you're not sure, do it anyway — it's harmless.

1. Same user panel → **Add Assets** → **Apps**
2. Tick the App that has the WhatsApp product enabled
3. Toggle **Develop app** or **Manage app** to ON
4. Save

---

## Step 5 — Generate the Token

1. Still on the System User's page, click **Generate New Token** (button near the top of the user panel)
2. **Select App:** pick the Meta App you'll be calling the Graph API with. The App ID here must match the `META_APP_ID` your bot uses.
3. **Token Expiration:** **Never**
   - This is the whole point. If you pick 60 days you'll be back here in two months explaining an outage.
4. **Permissions:** tick at least these two:
   - `whatsapp_business_messaging` — required to send/receive messages and call `/messages`
   - `whatsapp_business_management` — required to manage templates, phone numbers, webhooks, business profile
5. Click **Generate Token**
6. Meta shows the token **once**. Copy it immediately. You cannot retrieve it again — if you close the modal without copying, you have to revoke and regenerate.

**Reference:** [Meta — System User Access Tokens](https://developers.facebook.com/docs/marketing-api/system-users/create-retrieve-update#system-user-access-tokens)

---

## Step 6 — Store the Token

Put it in:

- The production host's environment variables (Vercel / Railway / Fly — wherever the bot runs) as `META_ACCESS_TOKEN` (or whatever the var is named in [.env.example](../.env.example))
- A password manager entry titled "Meta WhatsApp System User Token — prod" with the date and the System User name
- **Do not** commit it to the repo, paste it in Slack, or email it.

**VERIFY:** the token starts with `EAA…` and is roughly 200+ characters long. That's the System User token shape.

---

## Step 7 — Test the Token

From a terminal, swap in your token, WABA ID, and phone number ID:

```bash
# Should return the WABA's metadata
curl -s "https://graph.facebook.com/v21.0/<WABA_ID>" \
  -H "Authorization: Bearer <TOKEN>" | jq .

# Should return the phone number's metadata
curl -s "https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>" \
  -H "Authorization: Bearer <TOKEN>" | jq .
```

Both should return JSON with no `error` field. A 401 or "Invalid OAuth access token" means the System User doesn't have the asset assigned — go back to Step 3.

To confirm the token never expires, check it on the **[Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/)**:

1. Paste the token, click **Debug**
2. **Expires:** should read **Never**
3. **Scopes:** should include `whatsapp_business_messaging` and `whatsapp_business_management`
4. **App ID:** should match `META_APP_ID`

---

## Step 8 — Deploy

1. Update the production env var with the new token
2. Restart the service so the new value is picked up
3. Send a test message to the production number from your phone
4. Confirm the bot replies and the logs show no auth errors

---

## Rotating or Revoking

If the token leaks, or an admin who created it leaves the company:

1. **Business Settings → Users → System Users →** select the user
2. Click the existing token row → **Revoke**
3. Generate a new one (Step 5)
4. Update prod env vars
5. Restart

The token is tied to the System User, not the human who clicked "Generate". So when an employee leaves, you don't have to rotate — but you should review which humans have Admin access to the Business Account.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `(#10) Application does not have permission for this action` | App not assigned to System User (Step 4), or the App doesn't have the WhatsApp product added |
| `Invalid OAuth access token` | WABA not assigned to System User (Step 3), or you generated the token under the wrong App |
| Token works but only for 24h | You copied the App Dashboard temporary token by mistake. Tokens from System Users start with `EAA` and are noticeably longer |
| Can't see "System Users" in sidebar | You're not an Admin on the Business Account, or you opened Business Settings under the wrong business |
| "Generate Token" button missing | The System User has no assets assigned yet. Do Step 3 first |

---

## Useful Links

- [Meta Business Suite](https://business.facebook.com)
- [Meta App Dashboard](https://developers.facebook.com/apps/)
- [WhatsApp Cloud API — Get Started](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started)
- [System Users overview (Business Help)](https://www.facebook.com/business/help/503306463479099)
- [System User Access Tokens (Marketing API docs — same flow applies to WhatsApp)](https://developers.facebook.com/docs/marketing-api/system-users/create-retrieve-update#system-user-access-tokens)
- [Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/)
- [WhatsApp Business Platform permissions reference](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/permissions)
