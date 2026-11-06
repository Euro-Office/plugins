// SPDX-License-Identifier: AGPL-3.0-only
//
// The chat sidebar UI. State and the plugin protocol live in chat.ts.

import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";
import { memo } from "preact/compat";
import type { JSX } from "preact";
import type { AIEdits, Approval, Chat, Item, Preview } from "./chat";
import { renderMarkdown, stripLocationLinksHtml, stripLocationLinksMarkdown } from "./markdown";

// Feature flag: the token counter is not finished, so it stays hidden.
export const SHOW_TOKENS_INFO = false;
const MAX_TOKENS = 16000;
const TOOL_CALL_NAME_MAX_LENGTH = 40;

const WELCOME_BUTTONS = [
	["Blog post", "Blog post about"],
	["Press release", "Press release about"],
	["An essay", "An essay about"],
	["Social media post", "Social media post about"],
	["Brainstorm", "Brainstorm ideas for"],
	["Project proposal", "Project proposal about"],
	["Creative story", "Creative story about"],
	["Make a plan", "Make a plan about"],
	["Get advice", "Get advice about"]
];

type Tr = (s: string) => string;

function zoomSuffix() {
	let ratio = Math.min(Math.max(Math.round(window.devicePixelRatio / 0.25) * 0.25, 1), 2);
	return ratio === 1 ? "" : "@" + ratio + "x";
}

function Icon({ name, theme }: { name: string; theme: string }) {
	return <img class="icon" src={"../resources/icons/" + theme + "/" + name + zoomSuffix() + ".png"} alt="" draggable={false} />;
}

function IconButton({ icon, label, theme, onClick, class: cls, disabled }: { icon: string; label: string; theme: string; onClick: () => void; class?: string; disabled?: boolean }) {
	return (
		<button type="button" class={cls} title={label} aria-label={label} onClick={onClick} disabled={disabled}>
			<Icon name={icon} theme={theme} />
		</button>
	);
}

function copyText(text: string) {
	if (navigator.clipboard && navigator.clipboard.writeText) {
		navigator.clipboard.writeText(text).catch(() => copyWithTextarea(text));
		return;
	}
	copyWithTextarea(text);
}

function copyWithTextarea(text: string) {
	let ta = document.createElement("textarea");
	ta.value = text;
	ta.style.position = "fixed";
	ta.style.opacity = "0";
	document.body.appendChild(ta);
	ta.select();
	document.execCommand("copy");
	ta.remove();
}

export function App({ chat }: { chat: Chat }) {
	let [, rerender] = useReducer((n: number) => n + 1, 0);
	useEffect(() => chat.subscribe(() => rerender(0)), [chat]);
	let { state, tr } = chat;

	useEffect(() => {
		document.documentElement.classList.toggle("compact-radius", state.compactRadius);
	}, [state.compactRadius]);

	return (
		<div class="chat_window">
			<MessageList chat={chat} />
			{SHOW_TOKENS_INFO && <TokensInfo chat={chat} />}
			{chat.chipsVisible() && <ChipsRow chat={chat} />}
			{state.attachedText && (
				<div class="attached_text_wrapper">
					<div class="attached_text">{state.attachedText}</div>
					<IconButton class="icon_button" icon="close" label={tr("Remove attached text")} theme={state.themeType} onClick={chat.actions.clearAttachedText} />
				</div>
			)}
			{/* Persistent live region: it exists before a turn starts, so the
			    first "Thinking…" is announced, not skipped. */}
			<div class="agent_status_region" role="status" aria-live="polite">
				{state.running && !state.stopped && <AgentStatus chat={chat} />}
			</div>
			<Composer chat={chat} />
			{state.error && (
				<div class="div_error" role="alert" onClick={chat.actions.clearError}>
					<span class="lb_err">{state.error}</span>
				</div>
			)}
		</div>
	);
}

// ── Message list ─────────────────────────────────────────────────────────

function MessageList({ chat }: { chat: Chat }) {
	let { state, tr, actions } = chat;
	let ref = useRef<HTMLDivElement>(null);
	let stick = useRef(true);
	let lastCount = useRef(state.items.length);

	// Follow new content while the list is scrolled to the bottom.
	useLayoutEffect(() => {
		let el = ref.current;
		if (!el)
			return;
		let added = state.items.length > lastCount.current;
		lastCount.current = state.items.length;
		if (added && state.items[state.items.length - 1].role === "user")
			stick.current = true;
		if (stick.current)
			el.scrollTop = el.scrollHeight;
	});

	// The panel is resized (docking, theme, editor layout): keep the bottom in view.
	useEffect(() => {
		let onResize = () => { if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight; };
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	function onScroll() {
		let el = ref.current!;
		stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
	}

	// Links in answers: eo:// locations select a place in the document,
	// web links open in a new tab, nothing navigates this frame.
	function onClick(e: JSX.TargetedMouseEvent<HTMLDivElement>) {
		let link = (e.target as Element).closest && (e.target as Element).closest("a");
		if (!link)
			return;
		e.preventDefault();
		let href = link.getAttribute("href") || "";
		if (window.EOLinks.isLocationHref(href))
			actions.navigate(href);
		else if (/^(https?:|mailto:)/i.test(href))
			window.open((link as HTMLAnchorElement).href, "_blank", "noopener");
	}

	// Messages are memoized: while streaming, only the streaming message
	// re-renders, so the cost per chunk doesn't grow with the history length.
	let approvalsByItem = useMemo(() => {
		let map = new Map<number, Approval[]>();
		for (let a of Object.values(state.approvals)) {
			let list = map.get(a.itemId);
			list ? list.push(a) : map.set(a.itemId, [a]);
		}
		return map;
	}, [state.approvals]);

	let lastAssistant = -1;
	state.items.forEach((item, i) => { if (item.role === "assistant" && !item.isToolCall) lastAssistant = i; });

	return (
		<div class={"chat" + (state.items.length ? "" : " empty")} ref={ref} onScroll={onScroll} onClick={onClick} role="log" aria-live="polite" aria-label={tr("Chat")}>
			{state.items.length === 0 && !state.typing && <Welcome chat={chat} />}
			{state.items.map((item, i) => item.isToolCall
				? <ToolCallCard key={item.id} chat={chat} item={item} approvals={approvalsByItem.get(item.id) || NO_APPROVALS} trVersion={state.trVersion} />
				: item.role === "user"
					? <UserMessage key={item.id} item={item} />
					: <AssistantMessage key={item.id} chat={chat} item={item} streaming={i === state.streamingIndex} isLast={i === lastAssistant}
						theme={state.themeType} running={state.running} trVersion={state.trVersion} />)}
		</div>
	);
}

function Welcome({ chat }: { chat: Chat }) {
	let { tr } = chat;
	let user = (window.Asc.plugin.info && window.Asc.plugin.info.userName) || "";
	return (
		<div class="start_panel">
			<div class="welcome_text">
				<p><strong>{tr("Welcome") + (user ? ", " + user : "") + "!"}</strong></p>
				<p>{tr("I'm here to assist you with all your text creation and editing needs. Feel free to ask me anything about your document or anything else that's on your mind.")}</p>
				<p>{tr("Let’s make your content shine together!")}</p>
			</div>
			<div class="welcome_buttons_list">
				{WELCOME_BUTTONS.map(([text, prompt]) => (
					<button type="button" key={text} class="welcome_button btn-text-default" onClick={() => {
						chat.actions.setInput(tr(prompt) + " ", true);
					}}>{tr(text)}</button>
				))}
			</div>
		</div>
	);
}

const NO_APPROVALS: Approval[] = [];

const UserMessage = memo(function UserMessage({ item }: { item: Item }) {
	return (
		<div class="message user_message">
			<div class="message_content">
				<span class="span_message">{item.content as string}</span>
			</div>
		</div>
	);
});

function activeContent(item: Item): string {
	let content = item.content;
	if (Array.isArray(content))
		return content[item.activeContentIndex || 0] ?? content[0] ?? "";
	return content || "";
}

interface AssistantMessageProps { chat: Chat; item: Item; streaming: boolean; isLast: boolean; theme: string; running: boolean; trVersion: number }

// Reads only its props (plus the stable chat actions), so memo() is safe.
const AssistantMessage = memo(function AssistantMessage({ chat, item, streaming, isLast, theme, running, trVersion }: AssistantMessageProps) {
	let { tr, actions } = chat;
	let text = activeContent(item);
	let rendered = useMemo(() => renderMarkdown(text, tr, streaming), [text, streaming, trVersion]);

	let buttons: [string, string, () => void][] = [
		["btn-update", "Update", actions.regenerate],
		["btn-copy", "Copy", () => copyText(stripLocationLinksMarkdown(text))],
		["btn-replace", "Replace original text", () => actions.insert("replace", rendered.text)],
		["btn-select-tool", "Insert result", () => actions.insert("insert", stripLocationLinksHtml(rendered.html))],
		["btn-menu-comments", "In comment", () => actions.insert("comment", rendered.text)]
	];
	if (window.Asc.plugin.info && window.Asc.plugin.info.editorType === "word")
		buttons.push(["btn-ic-review", "As review", () => actions.insert("review", stripLocationLinksHtml(rendered.html))]);
	buttons.push(["btn-remove", "Delete", () => actions.deleteTurn(item)]);

	return (
		<div class={"message assistant_message" + (isLast ? " is_last" : "")}>
			{!item.aiEditsOnly && (
				<div class="message_content">
					<div class="span_message" dangerouslySetInnerHTML={{ __html: rendered.html }} />
					{!!item.error && (
						<div class="message_error">
							<div class="message_content_error_title"><Icon name="error" theme={theme} /><div>{tr("Something went wrong")}</div></div>
							<div class="message_content_error_desc">{tr("Please try reloading the conversation")}</div>
						</div>
					)}
				</div>
			)}
			{item.aiEdits && <AIEditsBar chat={chat} item={item} edits={item.aiEdits} />}
			{!item.error && !item.aiEditsOnly && !streaming && (
				<div class="action_buttons_list">
					{buttons.map(([icon, label, onClick]) => (
						<IconButton key={icon} class="action_button" icon={icon} label={tr(label)} theme={theme} onClick={onClick}
							disabled={running && (icon === "btn-update" || icon === "btn-remove")} />
					))}
				</div>
			)}
		</div>
	);
});

// ── Tool calls and approvals ─────────────────────────────────────────────

// trVersion is only a prop so translations arriving later re-render the card.
const ToolCallCard = memo(function ToolCallCard({ chat, item, approvals }: { chat: Chat; item: Item; approvals: Approval[]; trVersion: number }) {
	let [expanded, setExpanded] = useState(false);
	let funcName = item.functionName || "Unknown";
	let displayName = item.humanName || funcName;
	let calls = item.calls || [];
	let loading = calls.length === 0 || calls[calls.length - 1].result === null;
	let collapsedText = displayName.length > TOOL_CALL_NAME_MAX_LENGTH ? displayName.substring(0, TOOL_CALL_NAME_MAX_LENGTH - 3) + "..." : displayName;

	return (
		<div class="message tool_call_message">
			<div class="message_content tool_call_content">
				<button type="button" class={"tool_call_header" + (expanded ? " is-expanded" : "")} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
					<span class="tool_call_chevron" aria-hidden="true">
						<svg width="8" height="8" viewBox="0 0 8 8" fill="none"><polyline points="2,0.5 6,4 2,7.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
					</span>
					<span class="tool_call_title">{expanded ? displayName : collapsedText}{loading && !expanded && <span class="tool_call_dots">...</span>}</span>
				</button>
				{expanded && (
					<div class="tool_call_details">
						{calls.map((call, i) => (
							<div class="tool_call_call" key={i}>
								{call.arguments && <div class="tool_call_section"><pre>{funcName === "writeMacro" ? macroCode(call.arguments) : call.arguments}</pre></div>}
								{call.result !== null && <div class="tool_call_section"><pre>{typeof call.result === "string" ? call.result : JSON.stringify(call.result, null, 2)}</pre></div>}
							</div>
						))}
					</div>
				)}
				{/* Pending approval prompts stay visible even when the card is collapsed. */}
				{approvals.map((a) => <ApprovalCard key={a.data.id} chat={chat} approval={a} />)}
			</div>
		</div>
	);
});

function macroCode(args: string) {
	try {
		let parsed = JSON.parse(args);
		if (parsed && typeof parsed.code === "string")
			return parsed.code;
	} catch (e) {}
	return args;
}

function ApprovalCard({ chat, approval }: { chat: Chat; approval: Approval }) {
	let { tr, actions } = chat;
	let data = approval.data;
	let isMacro = typeof data.code === "string";
	let questionId = "tool_approval_q_" + String(data.id).replace(/[^A-Za-z0-9_-]/g, "_");
	let ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		ref.current && ref.current.focus({ preventScroll: true });
	}, []);
	let respond = (decision: string) => actions.respondApproval(data.id, decision);

	return (
		<div class="tool_call_approval" role="group" tabIndex={-1} aria-labelledby={questionId} ref={ref}>
			<div class="tool_call_approval_question" id={questionId}>{tr("Allow this action?") + " " + (data.humanName || data.functionName || "")}</div>
			{data.source === "editor" && <div class="tool_call_approval_label">{tr("Requested by the editor integration, not by this chat.")}</div>}
			{data.preview && typeof data.preview === "object" && <PreviewView preview={data.preview} tr={tr} />}
			{isMacro && <div class="tool_call_approval_label">{tr("The assistant wants to run this macro:")}</div>}
			{isMacro
				? <pre class="tool_call_approval_code" tabIndex={0}>{data.code}</pre>
				: data.arguments && data.arguments !== "{}" && <pre class="tool_call_approval_code" tabIndex={0}>{data.arguments}</pre>}
			<div class="tool_call_approval_buttons">
				<button type="button" class="btn-text-default submit primary" onClick={() => respond("allow")}>{tr("Allow")}</button>
				<button type="button" class="btn-text-default" onClick={() => respond("always")}>{tr(isMacro ? "Allow for this session" : "Always allow")}</button>
				<button type="button" class="btn-text-default" onClick={() => respond("deny")}>{tr("Deny")}</button>
			</div>
		</div>
	);
}

// Before/after preview (scripts/helpers/toolPreviews.js). Plain data from
// the plugin, only ever rendered as text.
function str(value: unknown) {
	return value === undefined || value === null ? "" : String(value);
}

function Change({ before, after }: { before: unknown; after: unknown }) {
	let b = str(before);
	let a = str(after);
	if (b === a)
		return <>{b}</>;
	return <>{b !== "" && <del class="ai_preview_old">{b}</del>}{a !== "" && <ins class="ai_preview_new">{a}</ins>}</>;
}

function PreviewView({ preview, tr }: { preview: Preview; tr: Tr }) {
	let table = preview.table;
	return (
		<div class="tool_call_preview">
			<div class="tool_call_approval_label">{tr("Preview of the changes:")}</div>
			{Array.isArray(preview.items) && preview.items.length > 0 && (
				<dl class="tool_call_preview_items">
					{preview.items.filter(Boolean).map((entry, i) => [<dt key={"t" + i}>{str(entry.label)}</dt>, <dd key={"d" + i}>{str(entry.value)}</dd>])}
				</dl>
			)}
			{preview.text && typeof preview.text === "object" && (
				<div class="tool_call_preview_text">
					<div class="tool_call_preview_caption">{tr("Current text")}</div>
					<del class="ai_preview_old" tabIndex={0}>{str(preview.text.before)}</del>
					<div class="tool_call_preview_caption">{tr("New text")}</div>
					<ins class="ai_preview_new" tabIndex={0}>{str(preview.text.after)}</ins>
				</div>
			)}
			{table && Array.isArray(table.rows) && table.rows.length > 0 && (
				<>
					<div class="tool_call_preview_table_wrap" tabIndex={0}>
						<table class="tool_call_preview_table">
							<caption class="visually_hidden">{tr("Current and new cell values")}</caption>
							<thead><tr><th scope="col" />{(table.columns || []).map((col, i) => <th scope="col" key={i}>{str(col)}</th>)}</tr></thead>
							<tbody>
								{table.rows.map((row, r) => (
									<tr key={r}>
										<th scope="row">{str(row && row.label)}</th>
										{((row && row.cells) || []).map((cell, c) => <td key={c}><Change before={cell && cell.before} after={cell && cell.after} /></td>)}
									</tr>
								))}
							</tbody>
						</table>
					</div>
					{table.truncated && <div class="tool_call_preview_note">…</div>}
				</>
			)}
			{!!preview.note && <div class="tool_call_preview_note">{str(preview.note)}</div>}
		</div>
	);
}

// ── "Undo AI changes" bar ───────────────────────────────────────────────

function aiEditsStatus(edits: AIEdits, tr: Tr) {
	if (edits.undone)
		return tr("AI changes undone.");
	if (edits.resolved === "accept")
		return tr("AI changes accepted.");
	if (edits.resolved === "reject")
		return tr("AI changes rejected.");
	if ((edits.revisionCount || 0) > 0)
		return tr("The AI made %1 tracked changes.").replace("%1", String(edits.revisionCount));
	return tr("The AI changed the document.");
}

function AIEditsBar({ chat, item, edits }: { chat: Chat; item: Item; edits: AIEdits }) {
	let { tr, actions } = chat;
	let open = !edits.undone && !edits.resolved;
	let buttons: { label: string; action: string; title: string; enabled: boolean }[] = [];
	if (open && edits.canUndo) {
		buttons.push({
			label: "Undo AI changes", action: "undo", enabled: !!edits.undoAvailable,
			title: edits.undoAvailable
				? tr("Undoes the AI changes of this answer (%1 undo steps). Edits you made while the AI was working or afterwards may be undone too. Reject all is safer when the changes are tracked.").replace("%1", String(edits.steps))
				: tr("Not available: the document was changed by the AI afterwards. Use Undo in the editor.")
		});
	}
	if (open && (edits.revisionCount || 0) > 0) {
		buttons.push({ label: "Accept all", action: "accept", enabled: true, title: tr("Accept the tracked changes made in this answer") });
		buttons.push({ label: "Reject all", action: "reject", enabled: true, title: tr("Reject the tracked changes made in this answer") });
	}
	return (
		<div class="ai_edits_bar" role="group" aria-label={tr("AI changes")}>
			<span class="ai_edits_status">{aiEditsStatus(edits, tr)}</span>
			{buttons.length > 0 && (
				<div class="ai_edits_buttons">
					{buttons.map((b) => (
						<button type="button" key={b.action} class="btn-text-default ai_edits_button" title={b.title}
							disabled={!b.enabled || !!edits.busy} onClick={() => actions.aiEditsAction(item, b.action)}>{tr(b.label)}</button>
					))}
				</div>
			)}
			{open && !edits.canUndo && (
				<div class="ai_edits_hint">{(edits.steps || 0) > 1 ? tr("To undo, press Ctrl+Z %1 times.").replace("%1", String(edits.steps)) : tr("To undo, press Ctrl+Z.")}</div>
			)}
			<div class="ai_edits_message" role="status" aria-live="polite">{edits.message || ""}</div>
		</div>
	);
}

// ── Selection chips ─────────────────────────────────────────────────────

function ChipsRow({ chat }: { chat: Chat }) {
	let { state, tr, actions } = chat;
	let chips = state.chips!;
	return (
		<div class="selection_chips" role="group" aria-label={tr("Suggested actions")}
			onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); actions.dismissChips(); } }}>
			<div class="selection_chips_summary">
				<span class="selection_chips_summary_text">{chips.summary}</span>
				<button type="button" class="selection_chips_dismiss" title={tr("Dismiss suggestions")} aria-label={tr("Dismiss suggestions")} onClick={actions.dismissChips}>×</button>
			</div>
			{chips.actions.map((a) => (
				<button type="button" key={a.id} class="selection_chip btn-text-default" onClick={() => actions.chip(a.id)}>{a.text}</button>
			))}
		</div>
	);
}

// ── Agent status ─────────────────────────────────────────────────────────

// Only the phase is announced (live region in App); the seconds counter is
// hidden from screen readers so it is not read out every second.
function AgentStatus({ chat }: { chat: Chat }) {
	let { state, tr } = chat;
	let [, tick] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		let t = setInterval(tick, 1000);
		return () => clearInterval(t);
	}, []);
	let label = state.activeTool
		? state.activeTool + "…"
		: tr("Thinking") + "…" + (state.agentModel ? " (" + state.agentModel + ")" : "");
	let seconds = Math.max(0, Math.floor((Date.now() - state.turnStart) / 1000));
	return (
		<div class="agent_status">
			<span class="agent_status_label">{label}</span>
			<span class="agent_status_time" aria-hidden="true">{tr("%1 s").replace("%1", String(seconds))}</span>
		</div>
	);
}

// ── Input ────────────────────────────────────────────────────────────────

function Composer({ chat }: { chat: Chat }) {
	let { state, tr, actions } = chat;
	let ref = useRef<HTMLTextAreaElement>(null);
	let [tokens, setTokens] = useState(0);
	let tooMany = SHOW_TOKENS_INFO && tokens > MAX_TOKENS;

	useLayoutEffect(() => {
		let ta = ref.current!;
		ta.style.height = "auto";
		ta.style.height = Math.min(ta.scrollHeight, 98) + 2 + "px";
	}, [state.input]);

	useEffect(() => {
		ref.current && ref.current.focus();
	}, [state.focusInput]);

	useEffect(() => {
		if (!SHOW_TOKENS_INFO || !window.Asc.OpenAIEncode)
			return;
		let t = setTimeout(() => setTokens(window.Asc.OpenAIEncode!(state.input.trim()).length), 250);
		return () => clearTimeout(t);
	}, [state.input]);

	function submit() {
		if (tooMany) {
			actions.setError("Too many tokens in your request.");
			return;
		}
		actions.submit();
	}

	function onKeyDown(e: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) {
		if (e.key !== "Enter" || e.isComposing)
			return;
		let ta = e.currentTarget;
		if (e.ctrlKey || e.metaKey) {
			e.preventDefault();
			let { selectionStart: s, selectionEnd: end, value } = ta;
			actions.setInput(value.substring(0, s) + "\n" + value.substring(end));
			requestAnimationFrame(() => ta.setSelectionRange(s + 1, s + 1));
		} else if (!e.shiftKey) {
			e.preventDefault();
			submit();
		}
	}

	let theme = state.themeType;
	return (
		<div class="input_message_wrapper">
			<textarea ref={ref} class={"input_message" + (tooMany ? " error_border" : "")} rows={1} spellcheck={false}
				placeholder={tr("Ask AI anything")} aria-label={tr("Ask AI anything")} value={state.input}
				onInput={(e) => actions.setInput(e.currentTarget.value)} onKeyDown={onKeyDown} />
			<div class="input_buttons_container">
				{state.voiceSupported && !state.running && <VoiceButton chat={chat} input={ref} />}
				{state.running
					? <button type="button" class="input_control_button stop_button" title={tr("Stop")} aria-label={tr("Stop")} onClick={actions.stop}><span class="stop_icon" aria-hidden="true" /></button>
					: <IconButton class="input_control_button" icon="btn-demote" label={tr("Send")} theme={theme} onClick={submit} />}
			</div>
		</div>
	);
}

function VoiceButton({ chat, input }: { chat: Chat; input: { current: HTMLTextAreaElement | null } }) {
	let { state, tr, actions } = chat;
	let engine = useRef<ReturnType<NonNullable<Window["initVoiceRecognitionEngine"]>>>(null);

	function toggle() {
		if (!engine.current) {
			let rec = window.initVoiceRecognitionEngine ? window.initVoiceRecognitionEngine() : null;
			if (!rec) {
				actions.setError("Voice input is not supported in your browser");
				return;
			}
			rec.onStart = () => actions.setRecording(true);
			rec.onEnd = () => actions.setRecording(false);
			rec.onError = (error: string) => {
				actions.setRecording(false);
				if (error !== "no-speech" && error !== "aborted")
					actions.setError(tr("Voice input error:") + " " + error);
			};
			rec.onProgress = (text: string) => {
				let value = chat.state.input;
				if (value && !value.endsWith(" ") && !value.endsWith("\n"))
					text = " " + text;
				actions.setInput(value + text);
				input.current && input.current.focus();
			};
			engine.current = rec;
		}
		try {
			if (state.recording)
				engine.current.engine.stop();
			else
				engine.current.engine.start();
		} catch (e) {
			actions.setError("Failed to start voice input");
		}
	}

	let label = state.recording ? tr("Stop voice input") : tr("Voice input");
	return (
		<button type="button" class={"input_control_button voice_button" + (state.recording ? " recording" : "")} title={label} aria-label={label} aria-pressed={state.recording} onClick={toggle}>
			<Icon name="btn-microphone" theme={state.themeType} />
		</button>
	);
}

// Token counter (SHOW_TOKENS_INFO). Needs vendor/GPT-3-Encoder loaded.
function TokensInfo({ chat }: { chat: Chat }) {
	let { tr, actions } = chat;
	return (
		<div class="tokens_info">
			<span>{tr("Maximum 16000 tokens are available.")}</span>
			<button type="button" class="btn-text-default" onClick={actions.clearHistory}>{tr("Clear history")}</button>
		</div>
	);
}
