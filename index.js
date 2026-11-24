import {
    chat,
    chat_metadata,
    Generate,
    name1,
    addOneMessage,
    substituteParams,
    getCurrentChatId,
    saveChatConditional,
    saveMetadata,
    setExtensionPrompt,
    extension_prompt_roles,
    extension_prompt_types,
    updateChatMetadata,
    updateMessageBlock,
} from '../../../../script.js';
import { eventSource, event_types } from '../../../../scripts/events.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../../scripts/popup.js';
import { ToolManager } from '../../../../scripts/tool-calling.js';
import {
    TOOL_NAME,
    META_KEY,
    PROMPT_KEY,
    MESSAGE_TYPE,
    normalizeCue,
    normalizeReaction,
    buildResumeInstruction,
    buildSkipResumeInstruction,
    decorateInterludeMessage,
    isInterludeMessage,
    makePending,
} from './core.js';

const REOPEN_ID = 'dynamic-interlude-reopen';
const SETTINGS_ID = 'dynamic-interlude-settings';
const DRAFT_SAVE_DELAY = 220;

let interludePopup = null;
let reopenBtn = null;
let draftTimer = null;
let restoringTextarea = null;
let resumeInFlight = false;

function extensionState() {
    const state = chat_metadata?.[META_KEY];
    return state && typeof state === 'object' ? state : {};
}

function pendingState() {
    const pending = extensionState().pending;
    return pending && typeof pending === 'object' ? pending : null;
}

async function writeState(next) {
    updateChatMetadata({
        [META_KEY]: {
            ...extensionState(),
            ...next,
        },
    });
    await saveMetadata();
}

async function writePending(pending) {
    await writeState({ pending: pending || null });
}

function currentPendingBelongsHere(pending = pendingState()) {
    if (!pending) return false;
    return pending.chatId === getCurrentChatId();
}

function findContinuationTarget() {
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message || message.is_user || message.is_system) continue;
        return i;
    }
    return -1;
}

function targetStillValid(pending) {
    if (!pending || !currentPendingBelongsHere(pending)) return false;
    const idx = Number(pending.targetIndex);
    return Number.isInteger(idx) && idx >= 0 && idx < chat.length && chat[idx] && !chat[idx].is_user && !chat[idx].is_system;
}

function mountReopenButton() {
    if (reopenBtn?.isConnected) return;

    reopenBtn = document.getElementById(REOPEN_ID);
    if (!reopenBtn) {
        reopenBtn = document.createElement('button');
        reopenBtn.id = REOPEN_ID;
        reopenBtn.className = 'dynamic-interlude-reopen menu_button';
        reopenBtn.type = 'button';
        reopenBtn.hidden = true;
        reopenBtn.setAttribute('aria-label', 'Open pending Dynamic Interlude');
        reopenBtn.innerHTML = '<i class="fa-solid fa-reply"></i><span>Tap to respond</span>';
        document.body.appendChild(reopenBtn);
    }

    if (reopenBtn.dataset.dynamicInterludeBound === 'true') return;
    reopenBtn.dataset.dynamicInterludeBound = 'true';

    let lastActivation = -Infinity;
    const activate = (event) => {
        const now = performance.now();
        if (now - lastActivation < 450) return;
        lastActivation = now;
        event.preventDefault();
        event.stopPropagation();
        void reopenInterlude();
    };

    // pointerup is the main path on modern Android/desktop Chromium. touchend
    // is a WebKit fallback, and click remains the keyboard/accessibility path.
    reopenBtn.addEventListener('pointerup', activate);
    reopenBtn.addEventListener('touchend', activate, { passive: false });
    reopenBtn.addEventListener('click', activate);
}

function lockComposer(locked) {
    const textarea = document.getElementById('send_textarea');
    const send = document.getElementById('send_but');
    const cont = document.getElementById('mes_continue');
    const form = document.getElementById('send_form');

    if (locked) {
        if (textarea && !restoringTextarea) {
            restoringTextarea = {
                readOnly: textarea.readOnly,
                placeholder: textarea.getAttribute('placeholder'),
                ariaDisabled: textarea.getAttribute('aria-disabled'),
            };
        }
        if (textarea) {
            textarea.readOnly = true;
            textarea.setAttribute('aria-disabled', 'true');
            textarea.setAttribute('placeholder', 'Interlude waiting — tap here to respond.');
        }
        send?.classList.add('dynamic-interlude-control-disabled');
        cont?.classList.add('dynamic-interlude-control-disabled');
        form?.classList.add('dynamic-interlude-composer-locked');
    } else {
        if (textarea && restoringTextarea) {
            textarea.readOnly = restoringTextarea.readOnly;
            if (restoringTextarea.placeholder === null) textarea.removeAttribute('placeholder');
            else textarea.setAttribute('placeholder', restoringTextarea.placeholder);
            if (restoringTextarea.ariaDisabled === null) textarea.removeAttribute('aria-disabled');
            else textarea.setAttribute('aria-disabled', restoringTextarea.ariaDisabled);
        }
        restoringTextarea = null;
        send?.classList.remove('dynamic-interlude-control-disabled');
        cont?.classList.remove('dynamic-interlude-control-disabled');
        form?.classList.remove('dynamic-interlude-composer-locked');
    }
}

function pendingPopupIsOpenFor(pending) {
    return Boolean(
        interludePopup &&
        !interludePopup._dynamicInterludeSuppress &&
        interludePopup._dynamicInterludePendingId === pending?.id &&
        interludePopup.dlg?.isConnected &&
        interludePopup.dlg?.open
    );
}

async function dismissPopupSilently() {
    const popup = interludePopup;
    if (!popup) return;
    interludePopup = null;
    popup._dynamicInterludeSuppress = true;
    try {
        if (popup.dlg?.isConnected && popup.dlg?.open) {
            await popup.completeCancelled();
        }
    } catch (error) {
        console.warn('[Dynamic Interlude] Could not silently close popup:', error);
        try { popup.dlg?.remove(); } catch { /* no-op */ }
    }
}

function buildPopupContent(pending) {
    const wrap = document.createElement('div');
    wrap.className = 'dynamic-interlude-native-content';
    wrap.tabIndex = -1;
    wrap.innerHTML = `
        <div class="dynamic-interlude-title">Dynamic Interlude</div>
        <div class="dynamic-interlude-kicker">Quick reaction, then the interrupted action continues.</div>
        <div class="dynamic-interlude-cue"></div>
        <div class="dynamic-interlude-error" hidden></div>
    `;
    wrap.querySelector('.dynamic-interlude-cue').textContent = pending.cue || '';
    const error = wrap.querySelector('.dynamic-interlude-error');
    error.textContent = pending.error || '';
    error.hidden = !pending.error;
    return wrap;
}

function syncPopupFromPending(pending) {
    const popup = interludePopup;
    if (!popup || popup._dynamicInterludePendingId !== pending?.id) return;
    const cue = popup.dlg?.querySelector('.dynamic-interlude-cue');
    const error = popup.dlg?.querySelector('.dynamic-interlude-error');
    if (cue) cue.textContent = pending.cue || '';
    if (error) {
        error.textContent = pending.error || '';
        error.hidden = !pending.error;
    }
    if (popup.mainInput && document.activeElement !== popup.mainInput) {
        popup.mainInput.value = pending.draft || '';
    }
}

async function openPendingPopup(pending) {
    if (!pending || pending.minimized || resumeInFlight) return;
    if (pendingPopupIsOpenFor(pending)) {
        syncPopupFromPending(pending);
        return;
    }

    await dismissPopupSilently();

    const content = buildPopupContent(pending);
    const popup = new Popup(content, POPUP_TYPE.INPUT, pending.draft || '', {
        okButton: 'Send Interlude',
        cancelButton: 'Minimize',
        rows: 4,
        placeholder: 'A word, line, gesture, or short reaction…',
        animation: 'fast',
        allowVerticalScrolling: true,
        leftAlign: true,
        allowEscapeClose: false,
        defaultResult: POPUP_RESULT.AFFIRMATIVE,
        customButtons: [
            {
                text: 'Skip & Continue',
                result: POPUP_RESULT.CUSTOM1,
                icon: 'fa-forward',
            },
        ],
        onClosing: async (activePopup) => {
            if (activePopup._dynamicInterludeSuppress) return true;

            const current = pendingState();
            if (!current || current.id !== pending.id || !currentPendingBelongsHere(current)) return true;

            const draft = activePopup.mainInput?.value ?? current.draft ?? '';
            if (activePopup.result === POPUP_RESULT.AFFIRMATIVE && !normalizeReaction(draft)) {
                const error = activePopup.dlg.querySelector('.dynamic-interlude-error');
                if (error) {
                    error.textContent = 'Write a reaction first, or use Skip & Continue.';
                    error.hidden = false;
                }
                activePopup.mainInput?.focus();
                return false;
            }

            if (activePopup.result === POPUP_RESULT.NEGATIVE || activePopup.result === POPUP_RESULT.CANCELLED) {
                await writePending({ ...current, draft, error: '', minimized: true });
            } else {
                await writePending({ ...current, draft, error: '', minimized: false });
            }
            return true;
        },
        onOpen: (activePopup) => {
            activePopup.dlg.classList.add('dynamic-interlude-popup');
            activePopup.mainInput.classList.add('dynamic-interlude-popup-input');
            activePopup.mainInput.autocomplete = 'off';
            activePopup.mainInput.autocapitalize = 'sentences';
            activePopup.mainInput.spellcheck = true;

            // Do not force the mobile keyboard open the instant the browser puts
            // the dialog in the top layer. The user can tap the textarea normally.
            activePopup.mainInput.removeAttribute('autofocus');
            content.setAttribute('autofocus', '');
            content.focus({ preventScroll: true });

            activePopup.mainInput.addEventListener('input', () => {
                scheduleDraftSave(activePopup.mainInput.value);
                const error = activePopup.dlg.querySelector('.dynamic-interlude-error');
                if (error && !error.hidden) {
                    error.hidden = true;
                    error.textContent = '';
                }
            });
        },
    });

    popup._dynamicInterludePendingId = pending.id;
    popup._dynamicInterludeSuppress = false;
    // Popup's constructor marks the input autofocus before onOpen. Remove it
    // before showModal() so Android/iOS do not immediately resize the viewport.
    popup.mainInput.removeAttribute('autofocus');
    content.setAttribute('autofocus', '');
    interludePopup = popup;

    const resultPromise = popup.show();
    void resultPromise.then(async (value) => {
        if (popup._dynamicInterludeSuppress) return;
        if (interludePopup === popup) interludePopup = null;

        const result = popup.result;
        if (result === POPUP_RESULT.AFFIRMATIVE) {
            await resume({ reaction: normalizeReaction(value), showReaction: true });
            return;
        }
        if (result === POPUP_RESULT.CUSTOM1) {
            await resume({ reaction: '', showReaction: false });
            return;
        }

        // Minimize / force-close leaves the interlude pending and exposes both
        // the floating reopen control and the locked-composer recovery path.
        await showPending();
    }).catch(async (error) => {
        console.error('[Dynamic Interlude] Popup failed:', error);
        if (interludePopup === popup) interludePopup = null;
        await setPendingError(`Interlude popup failed to open: ${error?.message || String(error)}`);
    });
}

async function showPending(pending = pendingState()) {
    mountReopenButton();
    if (!pending || !currentPendingBelongsHere(pending)) {
        reopenBtn.hidden = true;
        await dismissPopupSilently();
        lockComposer(false);
        return;
    }

    lockComposer(true);

    if (pending.minimized) {
        await dismissPopupSilently();
        reopenBtn.hidden = false;
        return;
    }

    reopenBtn.hidden = true;
    await openPendingPopup(pending);
}

async function hideAllUi() {
    mountReopenButton();
    reopenBtn.hidden = true;
    await dismissPopupSilently();
}

function scheduleDraftSave(value) {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => void persistDraft(value), DRAFT_SAVE_DELAY);
}

async function persistDraft(value) {
    const pending = pendingState();
    if (!pending || !currentPendingBelongsHere(pending)) return;
    await writePending({ ...pending, draft: String(value ?? '') });
}

async function reopenInterlude() {
    const pending = pendingState();
    if (!pending || resumeInFlight || !currentPendingBelongsHere(pending)) return;
    clearTimeout(draftTimer);
    await writePending({ ...pending, minimized: false });
    await showPending();
}

function committedInterludeIndex(pending) {
    const idx = Number(pending?.interludeMessageIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= chat.length) return -1;
    return isInterludeMessage(chat[idx], pending.id) ? idx : -1;
}

function markInterludeElement(messageIndex) {
    const element = document.querySelector(`#chat .mes[mesid="${messageIndex}"]`);
    if (!element) return;
    element.setAttribute('type', MESSAGE_TYPE);
    element.classList.add('dynamic-interlude-message');
}

/**
 * Creates one real SillyTavern user message for the micro-reaction. If a
 * continuation attempt failed, retry updates that same message instead of
 * creating a duplicate user turn.
 */
async function commitInterludeUserMessage(pending, reaction) {
    const normalized = normalizeReaction(reaction);
    if (!normalized) throw new Error('Write a reaction first, or use Skip & Continue.');

    let messageIndex = committedInterludeIndex(pending);
    let message;

    if (messageIndex >= 0) {
        message = chat[messageIndex];
        const previousText = message.mes;
        decorateInterludeMessage(message, pending, normalized);
        if (previousText !== message.mes && message.extra) delete message.extra.token_count;
        updateMessageBlock(messageIndex, message);
        markInterludeElement(messageIndex);
        await saveChatConditional();
    } else {
        // Insert a genuine USER-role history message without emitting ST's
        // ordinary MESSAGE_SENT lifecycle event. Dynamic Interlude is a
        // micro-turn inside an already-running action, not a new full turn.
        //
        // This distinction matters to cadence-driven extensions such as RST:
        // firing MESSAGE_SENT here can trigger a sidecar scan before the
        // interrupted assistant action has resumed. The message still remains
        // in chat history permanently, so later RST/ML/NWST scans can read it as
        // ordinary user-authored evidence.
        message = {
            name: name1,
            is_user: true,
            is_system: false,
            send_date: new Date().toISOString(),
            mes: substituteParams(normalized),
            extra: {},
        };
        decorateInterludeMessage(message, pending, message.mes);
        chat.push(message);
        messageIndex = chat.length - 1;
        chat_metadata.tainted = true;
        await saveChatConditional();

        const rendered = addOneMessage(message, { showSwipes: false });
        if (rendered?.attr) rendered.attr('type', MESSAGE_TYPE);
        markInterludeElement(messageIndex);
        await eventSource.emit(event_types.USER_MESSAGE_RENDERED, messageIndex);
    }

    const nextPending = {
        ...pending,
        draft: normalized,
        error: '',
        minimized: false,
        interludeMessageIndex: messageIndex,
    };
    await writePending(nextPending);
    return nextPending;
}

async function setPendingError(message) {
    const pending = pendingState();
    if (!pending) return;
    await writePending({ ...pending, error: String(message || 'Unable to continue the interlude.'), minimized: false });
    await showPending();
}

async function resume({ reaction = '', showReaction = true } = {}) {
    let pending = pendingState();
    if (!pending || resumeInFlight) return;
    if (!targetStillValid(pending)) {
        await setPendingError('The interrupted assistant message changed or no longer exists. Start a new generation instead of resuming this interlude.');
        return;
    }

    const normalized = normalizeReaction(reaction);
    resumeInFlight = true;
    clearTimeout(draftTimer);

    try {
        if (showReaction && normalized) {
            // Persist the reaction as a genuine compact USER message. It remains
            // visible to both the player and future model generations.
            pending = await commitInterludeUserMessage(pending, normalized);

            // The reaction itself is already in history. This temporary SYSTEM
            // instruction only explains that the unusual short user turn occurs
            // inside the still-ongoing action and must be resumed seamlessly.
            setExtensionPrompt(
                PROMPT_KEY,
                buildResumeInstruction(),
                extension_prompt_types.IN_CHAT,
                0,
                false,
                extension_prompt_roles.SYSTEM,
            );

            await hideAllUi();

            // A real user message is now the final history item, so create a new
            // assistant reply without inserting another user message from the
            // composer. This is the semantic structure we want:
            // ASSISTANT fragment -> USER interlude -> ASSISTANT continuation.
            const result = await Generate('normal', { automatic_trigger: true });
            if (result === undefined) {
                throw new Error('SillyTavern did not return continuation text. Check that the active backend is connected, then try again.');
            }
        } else {
            // Skip creates no artificial user message. Keep the native Continue
            // path so the interrupted assistant message simply resumes in place.
            setExtensionPrompt(
                PROMPT_KEY,
                buildSkipResumeInstruction(),
                extension_prompt_types.IN_CHAT,
                0,
                false,
                extension_prompt_roles.SYSTEM,
            );

            await hideAllUi();
            await writePending({ ...pending, draft: '', error: '', minimized: false });
            const result = await Generate('continue');
            if (result === undefined) {
                throw new Error('SillyTavern did not return continuation text. Check that the active backend is connected, then try again.');
            }
        }

        await writePending(null);
        lockComposer(false);
    } catch (error) {
        console.error('[Dynamic Interlude] Continuation failed:', error);
        await setPendingError(error?.message || String(error));
    } finally {
        setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
        resumeInFlight = false;
        await showPending();
    }
}

async function requestDynamicInterlude(args = {}) {
    const existing = pendingState();
    if (existing && currentPendingBelongsHere(existing)) {
        await showPending(existing);
        return 'A Dynamic Interlude is already waiting for the player.';
    }

    const targetIndex = findContinuationTarget();
    if (targetIndex < 0) {
        throw new Error('Dynamic Interlude requires an assistant message to pause and continue.');
    }

    const pending = makePending({
        cue: normalizeCue(args.cue),
        chatId: getCurrentChatId(),
        targetIndex,
    });
    await writePending(pending);
    await showPending(pending);
    return 'Paused for a brief player reaction.';
}

let toolRegistered = false;

function registerTool() {
    if (toolRegistered) return;
    ToolManager.registerFunctionTool({
        name: TOOL_NAME,
        displayName: 'Dynamic Interlude',
        description: 'Pause the CURRENT assistant response at a natural micro-beat when you need one brief player reaction before immediately continuing the same action or scene. Use this only for quick in-the-moment reactions (for example: a character asks a tiny question mid-action, reaches for the player, reveals something, or gives the player a split-second chance to react while the larger action is still underway). Do NOT use it to end the turn, hand over full scene control, ask broad/open-ended questions, or replace an ordinary response. Write all prose that happens BEFORE the pause first, then call this tool with a short cue telling the player exactly what they can react to. After the player responds, a follow-up assistant message will resume the interrupted action from that exact point without treating it as a scene break.',
        parameters: {
            type: 'object',
            properties: {
                cue: {
                    type: 'string',
                    description: 'A concise player-facing cue for the immediate micro-reaction. It should name the exact thing happening right now without narrating the player response.',
                },
            },
            required: ['cue'],
            additionalProperties: false,
        },
        action: requestDynamicInterlude,
        formatMessage: ({ cue }) => `Dynamic Interlude: ${normalizeCue(cue)}`,
        shouldRegister: () => !pendingState(),
        stealth: true,
    });
    toolRegistered = true;
}

async function createTestPending() {
    const targetIndex = findContinuationTarget();
    if (targetIndex < 0) {
        window.toastr?.warning?.('Generate at least one assistant message first so Dynamic Interlude has a continuation target.');
        return;
    }
    const pending = makePending({
        cue: 'The character pauses mid-action and looks to you for one quick reaction before continuing.',
        chatId: getCurrentChatId(),
        targetIndex,
    });
    await writePending(pending);
    await showPending(pending);
}

function createSettings() {
    if (document.getElementById(SETTINGS_ID)) return;
    const host = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2') || document.body;
    const wrap = document.createElement('div');
    wrap.id = SETTINGS_ID;
    wrap.className = 'extension_container';
    wrap.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Dynamic Interlude</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <p class="notes">Mid-response micro-reactions. The model pauses, your reaction becomes a real compact user message, then a fresh assistant message resumes the interrupted action immediately.</p>
                <div class="dynamic-interlude-settings-actions">
                    <button type="button" class="menu_button dynamic-interlude-test">Test interlude popup</button>
                    <button type="button" class="menu_button dynamic-interlude-clear">Clear pending interlude</button>
                </div>
                <small>Function tool: <code>${TOOL_NAME}</code></small>
            </div>
        </div>
    `;
    host.appendChild(wrap);
    wrap.querySelector('.dynamic-interlude-test')?.addEventListener('click', () => void createTestPending());
    wrap.querySelector('.dynamic-interlude-clear')?.addEventListener('click', async () => {
        await writePending(null);
        await hideAllUi();
        lockComposer(false);
    });
}

async function restoreForCurrentChat() {
    clearTimeout(draftTimer);
    await hideAllUi();
    lockComposer(false);
    await showPending();
}

// Recovery route: on a minimized pending interlude, tapping the locked composer
// itself reopens the native ST popup. This avoids depending on one floating UI
// element on mobile browsers.
document.addEventListener('pointerup', (event) => {
    const pending = pendingState();
    if (!pending?.minimized || !currentPendingBelongsHere(pending) || resumeInFlight) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest('#send_textarea, #send_form')) return;
    event.preventDefault();
    event.stopPropagation();
    void reopenInterlude();
}, true);

jQuery(async () => {
    mountReopenButton();
    createSettings();
    registerTool();
    await restoreForCurrentChat();
    eventSource.on(event_types.CHAT_CHANGED, () => void restoreForCurrentChat());
    eventSource.on(event_types.APP_READY, () => void restoreForCurrentChat());
    console.info('[Dynamic Interlude] v0.1.6 loaded — cadence-safe user-message interlude mode');
});
