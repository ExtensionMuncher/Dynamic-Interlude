# Dynamic Interlude v0.1.6

A SillyTavern 1.19.0 sister extension to Dynamic Response for **mid-response micro-reactions**.

The roleplay model can call the stealth function tool `request_dynamic_interlude` after writing the prose that happens before the pause. Dynamic Interlude displays a focused player-response dialog.

## v0.1.6 message architecture

A submitted reaction is now stored as a **real SillyTavern user-role message** rather than HTML embedded inside the interrupted assistant message. The persistent history is therefore:

```text
ASSISTANT: interrupted prose—
USER:      brief interlude reaction
ASSISTANT: —seamless continuation
```

The user message is compactly styled and tagged with `message.extra.type = "dynamic_interlude"`, but its `mes` field contains only the user's actual reaction. Future generations therefore see it permanently and correctly as user-authored context.

Unlike an ordinary full user turn, the micro-message is inserted without emitting SillyTavern's normal `MESSAGE_SENT` lifecycle event. This prevents cadence-driven extensions such as RST from firing a sidecar scan halfway through an interrupted action. The message remains in chat history, so later RST/Memory Loom/NWST history scans can still read it as ordinary user-authored evidence.

For the one generation immediately after the micro-reaction, Dynamic Interlude injects a temporary depth-zero **system** instruction telling the model to resume the interrupted action without restarting, recapping, or speaking for the user. That instruction is removed immediately after generation.

If continuation fails, retry edits/reuses the same interlude user message instead of duplicating it. **Skip & Continue** creates no artificial user message and retains SillyTavern's native Continue path.

## Install

Extract the ZIP and place the contained `Dynamic-Interlude` folder at:

`SillyTavern/data/<your-user>/extensions/Dynamic-Interlude/`

The final path must contain `Dynamic-Interlude/manifest.json` directly. Restart SillyTavern and refresh the browser.

## Mobile UI

v0.1.6 retains the v0.1.4 mobile repair: the active interlude uses SillyTavern 1.19.0's own `Popup` class / `<dialog>` top layer. When minimized, the reopen pill is body-level and tapping the locked composer also reopens the interlude.
