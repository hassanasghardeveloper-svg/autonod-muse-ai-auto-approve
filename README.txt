AutoNod - Auto Approve for Muse  (v1.14.0)
==========================================
Unofficial helper for Muse. Not made by or affiliated with Muse. Free.

WHAT IT DOES
- Auto-clicks "Allow" / "Always allow" on Muse approval cards
- Payment / delete / purchase cards and actions like "Send" or "Post" are NEVER
  clicked - they wait for you, and a red number shows on the AutoNod icon
- Secure Store cards: clicks Add, puts YOUR email in Username,
  generates a strong password, and presses Enter
- Keeps every generated password (hidden, click to copy)
- Dashboard (opens in its own Chrome tab from the popup): Home, Activity,
  Waiting, Passwords, Settings. Activity works like the website: the list on
  the left, the card Muse asked on the right, filters, search (press /)
- Light / dark mode: moon/sun button in the header, or Settings > Appearance
- Finds Muse cards by Muse's own card marker + card id, so the same card is
  never clicked twice (falls back to reading button text if Muse changes)

MODES (pick one in the popup)
- Safe       approves website cards only; posts, messages, deletes wait
- Standard   + post permissions (e.g. Facebook "create, edit, publish ...")
             + fills Secure Store. Single deletes and Send/Post buttons wait.
             (recommended)
- Autopilot  approves everything (posts, sends, deletes) + fills login forms
Payment / checkout cards ALWAYS wait for you, in every mode.
Single switches are in the dashboard: Settings > What AutoNod clicks.

INSTALL (2 minutes)
1. Unzip this file into a folder (keep the folder, don't delete it).
2. Open Chrome and go to:  chrome://extensions
3. Turn ON "Developer mode" (top-right).
4. Click "Load unpacked" and select the unzipped folder
   (the one that contains manifest.json).
5. Click the puzzle icon in the toolbar and pin "AutoNod".
6. Click the icon, pick a mode, then "Email" -> type your email (saves by itself).
7. Open / refresh muse.ai (press F5).
   You should see "AutoNod is on" in the bottom-left corner.

IMPORTANT
- The popup shows "Working on this muse.ai tab" in green. If it says
  "Not running on this tab", click Reconnect.
- If Muse ignores the automatic "Add" click, an orange message asks you
  to click Add yourself; the extension then fills everything and presses Enter.
- Auto-approve skips your manual check. Only use it for tasks you trust.
- Passwords are stored in this Chrome only (not encrypted), never sent anywhere. Anyone who
  uses this computer can open the dashboard and see them.
- CAPTCHAs ("I'm not a robot") must still be done by you.

CREDITS
- Font: Instrument Sans (SIL Open Font License), bundled in fonts/
- Site icons are loaded from Google's favicon service (only the site name,
  e.g. yelp.com, is sent). Turn off in Settings > Show site icons.
- Card detection idea (Muse card marker, React approval id) from
  "Auto Approve for Muse" by homieyangg, MIT licence:
  https://github.com/homieyangg/muse-auto-approve

-------------------------------------------------------------------
URDU / ROMAN URDU
1. Zip ko unzip karein (folder delete na karein).
2. Chrome mein  chrome://extensions  kholein.
3. Upar right par "Developer mode" ON karein.
4. "Load unpacked" dabayein aur wo folder chunein jismein manifest.json hai.
5. Puzzle icon se "AutoNod" ko pin karein.
6. Icon par click karke apni email likhein aur mode chunein
   (Standard sab se behtar hai).
7. muse.ai ko F5 se refresh karein. Neeche left mein
   "AutoNod is on" aana chahiye.

Agar AutoNod icon par laal number aaye to Muse mein koi payment / delete /
send card aapka intezar kar raha hai - khud check karke click karein.

Popup mein hara "Working on this muse.ai tab" dikhna chahiye. Agar
"Not running on this tab" likha ho to "Reconnect" dabayein.
