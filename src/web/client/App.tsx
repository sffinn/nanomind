import { useEffect, useRef, useState } from "react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
}

interface OpenFile {
  path: string;
  content: string;
  loading: boolean;
  error: string | null;
  editing: boolean;
  draft: string;
  saving: boolean;
}

/** The chat tab is always present; file tabs are keyed by their path. */
const CHAT_TAB = "__chat__";

/** Returns just the filename portion of a path for tab labels. */
const baseName = (p: string): string => {
  const parts = p.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || p;
};

const STORAGE_KEY = "nanomind.conversations";

const newId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Date.now());

const createConversation = (): Conversation => ({
  id: newId(),
  title: "New chat",
  messages: [],
});

/** Loads persisted conversations from localStorage, falling back to a fresh one. */
function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Conversation[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    // ignore malformed storage
  }
  return [createConversation()];
}

/** Derives a short conversation title from its first user message. */
const titleFrom = (text: string): string => {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 32 ? `${trimmed.slice(0, 32)}…` : trimmed || "New chat";
};

/** LLM chat application with a conversation history sidebar. */
export function App() {
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [activeId, setActiveId] = useState<string>(() => conversations[0]!.id);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeTab, setActiveTab] = useState<string>(CHAT_TAB);
  const scrollRef = useRef<HTMLDivElement>(null);

  const active = conversations.find((c) => c.id === activeId) ?? conversations[0]!;

  useEffect(() => {
    fetch("/api/files")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => setFiles(Array.isArray(data.files) ? data.files : []))
      .catch(() => setFiles([]));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    } catch {
      // ignore quota errors
    }
  }, [conversations]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [active.messages, loading]);

  function newChat() {
    const convo = createConversation();
    setConversations((prev) => [convo, ...prev]);
    setActiveId(convo.id);
    setError(null);
  }

  function selectChat(id: string) {
    setActiveId(id);
    setError(null);
  }

  function deleteChat(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setConversations((prev) => {
      const remaining = prev.filter((c) => c.id !== id);
      const next = remaining.length > 0 ? remaining : [createConversation()];
      if (id === activeId) setActiveId(next[0]!.id);
      return next;
    });
  }

  async function openFile(filePath: string) {
    if (filePath.endsWith("/")) return; // directories aren't viewable

    setActiveTab(filePath);
    if (openFiles.some((f) => f.path === filePath)) return; // already loaded

    setOpenFiles((prev) => [
      ...prev,
      { path: filePath, content: "", loading: true, error: null, editing: false, draft: "", saving: false },
    ]);

    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.path === filePath
            ? { ...f, content: data.content ?? "", draft: data.content ?? "", loading: false }
            : f,
        ),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not load file.";
      setOpenFiles((prev) =>
        prev.map((f) => (f.path === filePath ? { ...f, loading: false, error: message } : f)),
      );
    }
  }

  function closeFile(filePath: string, e: React.MouseEvent) {
    e.stopPropagation();
    setOpenFiles((prev) => prev.filter((f) => f.path !== filePath));
    setActiveTab((prev) => (prev === filePath ? CHAT_TAB : prev));
  }

  function startEdit(filePath: string) {
    setOpenFiles((prev) =>
      prev.map((f) => (f.path === filePath ? { ...f, editing: true, draft: f.content, error: null } : f)),
    );
  }

  function cancelEdit(filePath: string) {
    setOpenFiles((prev) =>
      prev.map((f) => (f.path === filePath ? { ...f, editing: false, draft: f.content, error: null } : f)),
    );
  }

  function updateDraft(filePath: string, value: string) {
    setOpenFiles((prev) => prev.map((f) => (f.path === filePath ? { ...f, draft: value } : f)));
  }

  async function saveFile(filePath: string) {
    const file = openFiles.find((f) => f.path === filePath);
    if (!file || file.saving) return;

    setOpenFiles((prev) =>
      prev.map((f) => (f.path === filePath ? { ...f, saving: true, error: null } : f)),
    );

    try {
      const res = await fetch("/api/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, content: file.draft }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.path === filePath ? { ...f, content: f.draft, editing: false, saving: false } : f,
        ),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not save file.";
      setOpenFiles((prev) =>
        prev.map((f) => (f.path === filePath ? { ...f, saving: false, error: message } : f)),
      );
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = { role: "user", content: text };
    const nextMessages = [...active.messages, userMsg];
    const isFirst = active.messages.length === 0;

    setConversations((prev) =>
      prev.map((c) =>
        c.id === active.id
          ? { ...c, messages: nextMessages, title: isFirst ? titleFrom(text) : c.title }
          : c,
      ),
    );
    setInput("");
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
      const reply: ChatMessage = { role: "assistant", content: data.reply ?? "" };
      setConversations((prev) =>
        prev.map((c) => (c.id === active.id ? { ...c, messages: [...nextMessages, reply] } : c)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <button className="new-chat" onClick={newChat}>
          + New chat
        </button>

        <div className="files">
          <div className="sidebar-label">Files</div>
          <div className="file-list">
            {files.length === 0 ? (
              <div className="file-empty">No files</div>
            ) : (
              files.map((f) => {
                const isDir = f.endsWith("/");
                const classes = [
                  "file-item",
                  isDir ? "dir" : "",
                  !isDir && activeTab === f ? "active" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <div
                    key={f}
                    className={classes}
                    title={f}
                    onClick={() => openFile(f)}
                  >
                    {f}
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="sidebar-label">History</div>
        <div className="history">
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`history-item${c.id === active.id ? " active" : ""}`}
              onClick={() => selectChat(c.id)}
            >
              <span className="history-title">{c.title}</span>
              <button
                className="delete"
                onClick={(e) => deleteChat(c.id, e)}
                aria-label="Delete conversation"
                title="Delete conversation"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="chat">
        <header className="chat-header">
          <h1>nanomind</h1>
          <span className="chat-subtitle">LLM chat · powered by LM Studio</span>
        </header>

        {openFiles.length > 0 && (
          <div className="tabs">
            <button
              className={`tab${activeTab === CHAT_TAB ? " active" : ""}`}
              onClick={() => setActiveTab(CHAT_TAB)}
            >
              Chat
            </button>
            {openFiles.map((f) => (
              <button
                key={f.path}
                className={`tab${activeTab === f.path ? " active" : ""}`}
                onClick={() => setActiveTab(f.path)}
                title={f.path}
              >
                <span className="tab-label">{baseName(f.path)}</span>
                <span className="tab-close" onClick={(e) => closeFile(f.path, e)}>
                  ×
                </span>
              </button>
            ))}
          </div>
        )}

        {activeTab === CHAT_TAB ? (
          <>
            <div className="messages" ref={scrollRef}>
              {active.messages.length === 0 && !loading && (
                <div className="empty">Ask me anything to get started.</div>
              )}
              {active.messages.map((m, i) => (
                <div key={i} className={`msg msg-${m.role}`}>
                  <div className="bubble">{m.content}</div>
                </div>
              ))}
              {loading && (
                <div className="msg msg-assistant">
                  <div className="bubble typing">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              )}
            </div>

            {error && <div className="error">{error}</div>}

            <div className="composer">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
                rows={1}
                disabled={loading}
              />
              <button onClick={sendMessage} disabled={loading || !input.trim()}>
                Send
              </button>
            </div>
          </>
        ) : (
          (() => {
            const file = openFiles.find((f) => f.path === activeTab);
            if (!file) return null;
            return (
              <div className="file-view">
                <div className="file-view-bar">
                  <span className="file-view-path">{file.path}</span>
                  {!file.loading && !file.editing && (
                    <button className="file-action" onClick={() => startEdit(file.path)}>
                      Edit
                    </button>
                  )}
                  {file.editing && (
                    <div className="file-actions">
                      <button
                        className="file-action secondary"
                        onClick={() => cancelEdit(file.path)}
                        disabled={file.saving}
                      >
                        Cancel
                      </button>
                      <button
                        className="file-action primary"
                        onClick={() => saveFile(file.path)}
                        disabled={file.saving}
                      >
                        {file.saving ? "Saving…" : "Save"}
                      </button>
                    </div>
                  )}
                </div>
                {file.error && <div className="file-view-status error-text">{file.error}</div>}
                {file.loading ? (
                  <div className="file-view-status">Loading…</div>
                ) : file.editing ? (
                  <textarea
                    className="file-editor"
                    value={file.draft}
                    onChange={(e) => updateDraft(file.path, e.target.value)}
                    spellCheck={false}
                  />
                ) : (
                  <pre className="file-view-content">{file.content}</pre>
                )}
              </div>
            );
          })()
        )}
      </div>
    </div>
  );
}
