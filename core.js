export const TOOL_NAME = 'request_dynamic_interlude';
export const META_KEY = 'dynamicInterlude';
export const PROMPT_KEY = 'dynamic_interlude_resume_instruction';
export const MESSAGE_TYPE = 'dynamic_interlude';

export function normalizeCue(value) {
    const cue = String(value ?? '').trim();
    return cue || 'React briefly before the scene continues.';
}

export function normalizeReaction(value) {
    return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

/**
 * Temporary instruction used only for the generation immediately following a
 * real Dynamic Interlude user message. The reaction itself is NOT repeated in
 * this prompt; it already exists in ordinary SillyTavern user-role history.
 */
export function buildResumeInstruction() {
    return [
        '[Dynamic Interlude — resume instruction]',
        'The immediately preceding USER message is a brief micro-reaction that occurred at the interruption point inside the ongoing scene.',
        'Continue directly from the interrupted assistant output as though there was no scene break. Do not restart, recap, quote, summarize, or paraphrase the preceding assistant prose or the user reaction.',
        'Do not narrate actions, dialogue, thoughts, feelings, intentions, or decisions for the user beyond what the user explicitly supplied. Resume the interrupted character action, dialogue, or scene naturally.',
    ].join('\n');
}

/**
 * Skip keeps the legacy same-message Continue path because there is no user
 * reaction to preserve as a separate history entry.
 */
export function buildSkipResumeInstruction() {
    return [
        '[Dynamic Interlude — resume instruction]',
        'The player chose not to add a micro-reaction.',
        'Continue the SAME assistant turn from the exact pause point. Do not restart, recap, quote, or paraphrase the preceding scene. Do not narrate actions, dialogue, thoughts, feelings, intentions, or decisions for the user. Continue the interrupted character action or scene naturally.',
    ].join('\n');
}

export function makePending({ cue, chatId, targetIndex, id = null, now = Date.now() }) {
    return {
        id: id || `di_${now}_${Math.random().toString(36).slice(2, 9)}`,
        cue: normalizeCue(cue),
        draft: '',
        error: '',
        minimized: false,
        chatId: chatId ?? null,
        targetIndex: Number(targetIndex),
        interludeMessageIndex: null,
        createdAt: now,
    };
}

/**
 * Adds stable semantic metadata to a real ST user message. The visible compact
 * treatment is controlled by extra.type/CSS; message.mes remains
 * the user's exact reaction so the model sees ordinary user-role content.
 */
export function decorateInterludeMessage(message, pending, reaction) {
    if (!message || typeof message !== 'object') {
        throw new TypeError('Dynamic Interlude requires a message object.');
    }
    const text = normalizeReaction(reaction);
    message.mes = text;
    message.is_user = true;
    message.is_system = false;
    message.extra = {
        ...(message.extra || {}),
        isSmallSys: false,
        type: MESSAGE_TYPE,
        dynamic_interlude: {
            id: String(pending?.id || ''),
            targetIndex: Number(pending?.targetIndex),
            cue: normalizeCue(pending?.cue),
            createdAt: Number(pending?.createdAt || Date.now()),
        },
    };
    return message;
}

export function isInterludeMessage(message, pendingId = null) {
    if (!message || !message.is_user || message.is_system) return false;
    if (message.extra?.type !== MESSAGE_TYPE) return false;
    if (pendingId === null) return true;
    return message.extra?.dynamic_interlude?.id === pendingId;
}
