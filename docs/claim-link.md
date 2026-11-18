# The claim link

A WhatsApp link the insurance team sends a client. The client taps it, WhatsApp opens Tina's chat with the message already typed, and the client presses **Send**. Tina starts the claim.

```
https://wa.me/27764446801?text=Hi%20Tina%2C%20I%27d%20like%20to%20open%20an%20insurance%20claim.
```

Tina's number is 076 444 6801 (the same one on TTT's "Hi Tina" email buttons). The message it types is:

> Hi Tina, I'd like to open an insurance claim.

WhatsApp never sends the message for the client. They have to press Send, and Tina can reply as soon as they do.

## What the client gets

Tina treats this message as a tap on **Report a claim**, decided by its words and not by a model.

| The client is | What happens |
|---|---|
| Insurance only | The claim starts: which policy, then the walkthrough. |
| Tax **and** insurance | The same. Tina does not ask "insurance or tax?", and the rest of that conversation stays on insurance. |
| On a number shared by a tax contact and an insurance contact | The claim is for the insurance contact. |
| On a number shared by two insurance contacts | Tina starts no claim on a guess. The broker gets a Follow-up that says to check which client it is. |
| Tax only (no policy with TTT) | No claim. Tina offers to have the insurance team contact them (buttons: Yes, contact me / No, it's about tax). |
| A number TTT does not have | The unknown-number reply, as for any claim from an unknown number. |
| Already part-way through a claim | Tina carries on with that claim. No second claim is opened. |

If the client edits the message and adds details ("... for my stolen car"), it is an ordinary message and takes the ordinary route. It still becomes a claim for an insurance client.

## Putting it in an email

```html
<a href="https://wa.me/27764446801?text=Hi%20Tina%2C%20I%27d%20like%20to%20open%20an%20insurance%20claim."
   style="display:inline-block;padding:12px 26px;background:#25D366;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold">
  Report a claim on WhatsApp
</a>
```

It also works pasted as a plain link in an email, an SMS or a WhatsApp message.

## Before the link goes to clients

Claims are behind switches, and a client who taps the link while they are off gets Tina's tax assistant, not a claim.

| Setting (on `ttt-prod-bot` and `ttt-prod-bot-worker`) | Without it |
|---|---|
| `CLAIMS_ENABLED=true` | No claim is taken on WhatsApp. With `SERVICE_ROUTING_ENABLED` on, the client is told their broker will contact them to take the claim, and the broker gets a Follow-up. With it off, the tax assistant answers. |
| `SERVICE_ROUTING_ENABLED=true` (and `SERVICE_ROUTING_NUMBERS` empty, or including the phone) | The link still starts a claim for the contact Tina found first. On the few numbers shared by a tax and an insurance contact that may be the tax contact, and a client with both services is not moved onto insurance for the rest of the chat. |

Try it on your own phone first.

## Changing the wording

The text lives in one place, `CLAIM_LINK_TEXT` in `src/domain/claimLink.ts`. A test checks that the link's text is always recognised, so a change there cannot quietly break the links already sent. Links already sent keep working only while the old wording is still recognised, so change the wording only if you also re-send the link.
